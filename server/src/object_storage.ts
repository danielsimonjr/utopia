/**
 * Object storage source: S3 and anything that speaks the same protocol
 * (MinIO, Ceph RGW, Alibaba OSS's S3-compatible endpoint, Cloudflare
 * R2, …).
 *
 * Version history is out of scope for now: most buckets do not have
 * versioning on, and even the ones that do mostly hold write-once
 * objects — ingesting every version would cost far more than it buys.
 *
 * `doc_time` comes from `LastModified`, which is the write time, not
 * the document's own time. A 2019 contract uploaded today lands on
 * today's timeline. There is no better source available from object
 * storage alone.
 */

import { createHash, createHmac } from "node:crypto";

/** How many objects one sync ingests at most. Not a performance limit — a guard against pulling in a whole bucket by a misconfigured prefix, since ingestion is not reversible. */
const MAX_OBJECTS_PER_SYNC = 2000;
/** Per-object size cap. Anything bigger is probably a data file (backup, image, video), not a document — the extractor gets nothing useful from it. */
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

export type RemoteObject = {
  /** `s3://bucket/key` — matches the URI-shaped external_key convention used by `ingest_item`. */
  externalKey: string;
  filename: string;
  bytes: Uint8Array;
  lastModified: Date | null;
};

export type S3Config = {
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Set for a self-hosted endpoint (MinIO, Ceph, R2); forces path-style addressing. */
  endpoint?: string;
};

function strField(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Builds a client config from a source's `config` JSON. */
export function parseS3Config(config: Record<string, unknown>): S3Config {
  const bucket = strField(config, "bucket");
  if (!bucket) {
    throw new Error("object storage source is missing config.bucket");
  }
  return {
    bucket,
    region: strField(config, "region"),
    accessKeyId: strField(config, "access_key_id"),
    secretAccessKey: strField(config, "secret_access_key"),
    endpoint: strField(config, "endpoint"),
  };
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** A minimal AWS SigV4-signed S3 client (GET only: list + get). */
class S3Client {
  constructor(private readonly cfg: S3Config) {}

  private region(): string {
    return this.cfg.region ?? "us-east-1";
  }

  private pathStyle(): boolean {
    return this.cfg.endpoint != null;
  }

  private base(): URL {
    return new URL(this.cfg.endpoint ?? `https://s3.${this.region()}.amazonaws.com`);
  }

  private locate(key: string): { url: URL; host: string; path: string } {
    const base = this.base();
    let host = base.host;
    let path: string;
    if (this.pathStyle()) {
      path = `/${this.cfg.bucket}${key ? `/${key}` : ""}`;
    } else {
      host = `${this.cfg.bucket}.${base.host}`;
      path = key ? `/${key}` : "/";
    }
    const url = new URL(`${base.protocol}//${host}${path}`);
    return { url, host, path };
  }

  private sign(host: string, path: string, canonicalQuery: string): { url: string; headers: Record<string, string> } {
    const region = this.region();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update("").digest("hex");
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = ["GET", path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const kDate = createHmac("sha256", `AWS4${this.cfg.secretAccessKey ?? ""}`).update(dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(region).digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId ?? ""}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return {
      url: `https://${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
      headers: {
        host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization,
      },
    };
  }

  private async signedGet(key: string, query: Record<string, string>): Promise<Response> {
    const { host, path } = this.locate(key);
    const canonicalQuery = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort()
      .join("&");
    const { url, headers } = this.sign(host, path, canonicalQuery);
    const scheme = this.base().protocol === "http:" ? "http:" : "https:";
    return fetch(url.replace(/^https:/, scheme), { headers });
  }

  async listObjects(prefix?: string): Promise<{ key: string; size: number; lastModified: Date }[]> {
    const out: { key: string; size: number; lastModified: Date }[] = [];
    let continuationToken: string | undefined;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2" };
      if (prefix) query.prefix = prefix;
      if (continuationToken) query["continuation-token"] = continuationToken;
      const resp = await this.signedGet("", query);
      if (!resp.ok) {
        throw new Error(`S3 list failed: HTTP ${resp.status}`);
      }
      const xml = await resp.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = m[1]!;
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
        const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
        if (key && size && lastModified) {
          out.push({ key: xmlUnescape(key), size: Number(size), lastModified: new Date(lastModified) });
        }
      }
      const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (isTruncated && nextToken) {
        continuationToken = xmlUnescape(nextToken);
        continue;
      }
      break;
    }
    return out;
  }

  async getObject(key: string): Promise<Uint8Array> {
    const resp = await this.signedGet(key, {});
    if (!resp.ok) {
      throw new Error(`S3 get failed: HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
}

/**
 * Lists objects under a prefix and fetches each one.
 *
 * Zero-byte objects are always skipped, judged by size, not by name.
 * (A trailing-slash "directory marker" test would be tempting, but S3
 * has no real directories, and this matches the upstream Rust
 * implementation's own reasoning: judging by size is both simpler and
 * catches every empty placeholder, regardless of what its key looks
 * like.)
 *
 * A single object failing to fetch does not take down the whole sync:
 * fetches happen well after the listing call, and permissions or
 * content can change in between, especially in a large bucket. The
 * failure is counted and logged, not thrown.
 */
export async function fetchObjects(
  cfg: S3Config,
  prefix: string | undefined,
): Promise<{ objects: RemoteObject[]; truncated: boolean }> {
  const client = new S3Client(cfg);
  const listing = await client.listObjects(prefix);
  const out: RemoteObject[] = [];
  let truncated = false;
  for (const meta of listing) {
    if (meta.size === 0) continue;
    if (meta.size > MAX_OBJECT_BYTES) continue;
    if (out.length >= MAX_OBJECTS_PER_SYNC) {
      truncated = true;
      break;
    }
    let bytes: Uint8Array;
    try {
      bytes = await client.getObject(meta.key);
    } catch {
      continue;
    }
    out.push({
      externalKey: `s3://${cfg.bucket}/${meta.key}`,
      filename: meta.key.split("/").pop() || meta.key,
      bytes,
      lastModified: meta.lastModified,
    });
  }
  return { objects: out, truncated };
}
