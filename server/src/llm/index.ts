/**
 * utopia-llm: a thin client for the OpenAI-compatible chat protocol.
 *
 * One code path fits DeepSeek, Qwen (DashScope compatible mode), GLM,
 * OpenAI, Ollama, and vLLM.
 */

import { log } from "../core/log";

export type ChatMessage = { role: string; content: string };

/** A tool call in the OpenAI protocol. The assistant turn carries it. */
export type ToolCall = {
  id: string;
  name: string;
  /** The arguments as a JSON string. We pass the protocol value through as-is. */
  arguments: string;
};

/** One assistant turn in a tool conversation. It carries text, tool calls, or both. */
export type AssistantTurn = {
  content: string | null;
  toolCalls: ToolCall[];
};

/** Turns an assistant turn back into an OpenAI protocol message. Use this to replay history. */
export function assistantTurnToMessage(turn: AssistantTurn): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: "assistant", content: turn.content };
  if (turn.toolCalls.length > 0) {
    msg.tool_calls = turn.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  return msg;
}

/** A tool result message (role=tool). */
export function toolResultMessage(toolCallId: string, content: string): Record<string, unknown> {
  return { role: "tool", tool_call_id: toolCallId, content };
}

/** One event of a streamed tool turn. */
export type ToolStreamItem =
  | { kind: "delta"; text: string }
  | { kind: "turn"; turn: AssistantTurn };

/**
 * The endpoint gave back nothing we can use. Two cases collapse into one type:
 * we could not connect (DNS, TCP, TLS, timeout), or we connected but the
 * reply was not valid JSON from this API.
 *
 * We fold both cases into one type on purpose. From the caller's side both
 * mean the same thing — "this address is not a model API" — and call for
 * the same next step: check the URL, check the proxy.
 *
 * This type does NOT cover a clean 4xx/5xx from the endpoint. A clean HTTP
 * error means the address is a model API; the key, quota, or model name is
 * wrong instead. That is a different problem with a different owner.
 */
export class Unreachable extends Error {
  constructor(cause: unknown) {
    super(`LLM endpoint gave no usable answer: ${causeMessage(cause)}`, { cause });
    this.name = "Unreachable";
  }
}

/**
 * The endpoint is rate limiting us.
 *
 * This is a distinct type because the caller must react to it differently
 * from an ordinary failure: back off and try again, instead of giving up.
 * Rate limiting is different from most other 4xx errors in one way — it
 * heals on its own. A bad key stays bad after a thousand retries; a quota
 * resets after a minute. Mixing the two wastes the retry budget on the
 * class of error that never heals.
 */
export class RateLimited extends Error {
  readonly status: number;
  /**
   * Often `null`. Most providers do not send `Retry-After` on a 429
   * (SiliconFlow does not). Treat it as a bonus hint, not something to
   * depend on — the caller must bring its own backoff regardless.
   */
  readonly retryAfterMs: number | null;
  readonly detail: string;
  constructor(status: number, retryAfterMs: number | null, detail: string) {
    super(`LLM endpoint is rate limiting (${status}): ${detail}`);
    this.name = "RateLimited";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }
}

/**
 * The account cannot pay for this request: it is out of funds, or the plan
 * quota is used up.
 *
 * This is kept apart from {@link RateLimited} because it does not heal on
 * its own. A rate limit passes in a minute; an empty balance is still
 * empty tomorrow. Retrying only repeats the same failure three times — it
 * does not make the thing that must actually happen (someone tops up the
 * account) happen.
 */
export class OutOfCredit extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`LLM account cannot pay for this request (${status}): ${detail}`);
    this.name = "OutOfCredit";
    this.status = status;
    this.detail = detail;
  }
}

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Walks an error and its `cause` chain, oldest wrap first, error itself first. */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** True if {@link Unreachable} appears anywhere in the error's `cause` chain. */
export function isUnreachable(err: unknown): boolean {
  return errorChain(err).some((e) => e instanceof Unreachable);
}

/** The {@link RateLimited} in the error's `cause` chain, if any. Survives wrapping. */
export function rateLimited(err: unknown): RateLimited | undefined {
  return errorChain(err).find((e): e is RateLimited => e instanceof RateLimited);
}

/** The {@link OutOfCredit} in the error's `cause` chain, if any. Survives wrapping. */
export function outOfCredit(err: unknown): OutOfCredit | undefined {
  return errorChain(err).find((e): e is OutOfCredit => e instanceof OutOfCredit);
}

/** How long a connect attempt may take before it counts as failed. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * How long the client waits without a new byte before it gives up on a
 * request.
 *
 * This is an idle timeout, not a total-duration timeout: {@link
 * LlmClient.chatToolsStream} is a real stream, and a long tool
 * conversation legitimately runs for minutes. A cap on total duration
 * would cut it off mid-stream. An idle timeout instead measures silence —
 * during a stream, tokens keep arriving and never trip it; on a plain
 * call, it catches the case where the request went out and nothing ever
 * came back.
 *
 * 300 seconds, not 60: the first byte of a non-streamed call must wait for
 * the model to finish the whole generation. A large extraction prompt
 * normally takes 60–120 seconds, longer when the server queues. A smaller
 * number would kill requests that were about to succeed, and here a false
 * kill costs more than noticing a hang five minutes late.
 */
const READ_TIMEOUT_MS = 300_000;

function retryAfterOfHeaders(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

function errDetail(body: unknown): string {
  const b = body as Record<string, unknown> | null | undefined;
  const error = b?.error as Record<string, unknown> | undefined;
  const msg = error?.message ?? b?.message;
  return typeof msg === "string" ? msg : "unknown error";
}

/** True if the response body says this 429 is a billing problem, not a rate limit. */
function saysOutOfCredit(body: unknown): boolean {
  const b = body as Record<string, unknown> | null | undefined;
  const error = b?.error as Record<string, unknown> | undefined;
  const code = error?.code;
  const type = error?.type;
  return code === "insufficient_quota" || type === "insufficient_quota";
}

/**
 * Turns a non-2xx response into one of three error kinds: out of credit,
 * rate limited, or other.
 *
 * A 503 does not count as rate limited: it may mean the endpoint is down,
 * or a proxy sits in the middle. Counting it in would send "try again
 * soon" traffic at something that will never come back. Keep the
 * criterion narrow and fall back to "other" when unsure.
 */
function failure(kind: string, status: number, retryAfterMs: number | null, body: unknown): Error {
  const detail = errDetail(body);
  // Out of credit must be checked first, and not by status code alone.
  //
  // 402 is the standard answer (SiliconFlow uses it), but OpenAI reports an
  // exhausted balance as a 429, distinguished only by `insufficient_quota`
  // in the body. Classifying by status code alone would treat a broke
  // OpenAI account as rate limited, then retry it forever with backoff —
  // and the longer the backoff grows, the more it looks like a slow
  // endpoint, and the harder the real cause is to find.
  if (status === 402 || saysOutOfCredit(body)) {
    return new OutOfCredit(status, detail);
  }
  if (status === 429) {
    return new RateLimited(status, retryAfterMs, detail);
  }
  return new Error(`${kind} request failed (${status}): ${detail}`);
}

async function readJsonBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch (e) {
    throw new Unreachable(e);
  }
}

/** Fetches a URL, aborting if no response headers arrive within `timeoutMs`. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the whole body as JSON, aborting the response if it stalls for `timeoutMs`. */
async function jsonWithIdleTimeout(resp: Response, timeoutMs: number): Promise<unknown> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resp.body?.cancel().catch(() => {});
  }, timeoutMs);
  try {
    return await readJsonBody(resp);
  } catch (e) {
    if (timedOut) throw new Unreachable(new Error("read timed out"));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  readonly model: string;
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(
    baseUrl: string,
    apiKey: string | null,
    model: string,
    connectTimeoutMs: number = CONNECT_TIMEOUT_MS,
    readTimeoutMs: number = READ_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey ?? null;
    this.model = model;
    this.connectTimeoutMs = connectTimeoutMs;
    this.readTimeoutMs = readTimeoutMs;
  }

  /**
   * Builds a client with injected timeouts. Tests use this — production
   * code uses the constructor and the fixed timeouts above. Testing a hang
   * with the real 300-second timeout would take five minutes, and nobody
   * keeps a test like that around.
   */
  static withTimeouts(
    baseUrl: string,
    apiKey: string | null,
    model: string,
    connectTimeoutMs: number,
    readTimeoutMs: number,
  ): LlmClient {
    return new LlmClient(baseUrl, apiKey, model, connectTimeoutMs, readTimeoutMs);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetchWithTimeout(
        `${this.baseUrl}${path}`,
        { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
        // The idle-read guard covers the wait for headers too: a
        // connected-but-silent peer must fail within the read timeout,
        // not the (usually longer) connect timeout.
        Math.min(this.connectTimeoutMs, this.readTimeoutMs),
      );
    } catch (e) {
      throw new Unreachable(e);
    }
  }

  /** A non-streamed chat call. Good for lightweight uses such as a connectivity check. */
  async chat(messages: ChatMessage[]): Promise<string> {
    const resp = await this.post("/chat/completions", {
      model: this.model,
      messages,
      stream: false,
    });
    const status = resp.status;
    const retryAfterMs = retryAfterOfHeaders(resp.headers);
    const body = await jsonWithIdleTimeout(resp, this.readTimeoutMs);
    if (!resp.ok) {
      throw failure("LLM", status, retryAfterMs, body);
    }
    logUsage(this.model, body);
    const content = (body as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`Unexpected LLM response shape: ${JSON.stringify(body)}`);
    }
    return content;
  }

  /**
   * A tool call (non-streamed). `messages` are raw OpenAI protocol JSON
   * (this supports `assistant.tool_calls` turns and `role=tool` replies).
   * `tools` is the function-definition array.
   */
  async chatTools(messages: unknown[], tools: unknown): Promise<AssistantTurn> {
    const resp = await this.post("/chat/completions", {
      model: this.model,
      messages,
      tools,
      stream: false,
    });
    const status = resp.status;
    const retryAfterMs = retryAfterOfHeaders(resp.headers);
    const body = await jsonWithIdleTimeout(resp, this.readTimeoutMs);
    if (!resp.ok) {
      throw failure("LLM", status, retryAfterMs, body);
    }
    const msg = (body as any)?.choices?.[0]?.message;
    if (msg === undefined || msg === null) {
      throw new Error(`Unexpected LLM response shape: ${JSON.stringify(body)}`);
    }
    const content = typeof msg.content === "string" && msg.content !== "" ? msg.content : null;
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const toolCalls: ToolCall[] = [];
    for (const c of rawCalls) {
      const id = c?.id;
      const name = c?.function?.name;
      if (typeof id !== "string" || typeof name !== "string") continue;
      const args = typeof c?.function?.arguments === "string" ? c.function.arguments : "{}";
      toolCalls.push({ id, name, arguments: args });
    }
    return { content, toolCalls };
  }

  /**
   * A tool call (streamed). Text deltas are yielded right away. Tool calls
   * are merged by their OpenAI-protocol `index` (id/name land in the first
   * frame, `arguments` land across frames). The full turn comes last.
   */
  async *chatToolsStream(
    messages: unknown[],
    tools: unknown,
  ): AsyncGenerator<ToolStreamItem> {
    const resp = await this.post("/chat/completions", {
      model: this.model,
      messages,
      tools,
      stream: true,
    });
    if (!resp.ok) {
      const status = resp.status;
      const retryAfterMs = retryAfterOfHeaders(resp.headers);
      const body = await readJsonBody(resp).catch(() => ({}));
      throw failure("LLM", status, retryAfterMs, body);
    }

    let content = "";
    const calls: ToolCall[] = [];
    for await (const frame of sseFrames(resp, this.readTimeoutMs)) {
      for (const line of frame.split("\n")) {
        const data = stripDataPrefix(line);
        if (data === null) continue;
        if (data === "[DONE]") {
          calls.splice(0, calls.length, ...calls.filter((c) => c.name !== ""));
          yield { kind: "turn", turn: { content: content || null, toolCalls: [...calls] } };
          return;
        }
        let v: any;
        try {
          v = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = v?.choices?.[0]?.delta;
        const text = delta?.content;
        if (typeof text === "string" && text !== "") {
          content += text;
          yield { kind: "delta", text };
        }
        const tcs = delta?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = typeof tc?.index === "number" ? tc.index : 0;
            while (calls.length <= idx) calls.push({ id: "", name: "", arguments: "" });
            const slot = calls[idx]!;
            if (typeof tc?.id === "string") slot.id += tc.id;
            if (typeof tc?.function?.name === "string") slot.name += tc.function.name;
            if (typeof tc?.function?.arguments === "string") slot.arguments += tc.function.arguments;
          }
        }
      }
    }
    const finalCalls = calls.filter((c) => c.name !== "");
    yield { kind: "turn", turn: { content: content || null, toolCalls: finalCalls } };
  }

  /** A streamed chat call. Yields text deltas. */
  async *chatStream(messages: ChatMessage[]): AsyncGenerator<string> {
    yield* this.chatStreamRaw(messages);
  }

  /** A streamed chat call, raw JSON messages (can carry tool-turn context). */
  async *chatStreamRaw(messages: unknown[]): AsyncGenerator<string> {
    const resp = await this.post("/chat/completions", {
      model: this.model,
      messages,
      stream: true,
    });
    if (!resp.ok) {
      const status = resp.status;
      const retryAfterMs = retryAfterOfHeaders(resp.headers);
      const body = await readJsonBody(resp).catch(() => ({}));
      throw failure("LLM", status, retryAfterMs, body);
    }
    for await (const frame of sseFrames(resp, this.readTimeoutMs)) {
      for (const line of frame.split("\n")) {
        const data = stripDataPrefix(line);
        if (data === null) continue;
        if (data === "[DONE]") return;
        let v: any;
        try {
          v = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = v?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta !== "") yield delta;
      }
    }
  }

  /** Batch embeddings. */
  async embed(texts: string[]): Promise<number[][]> {
    const resp = await this.post("/embeddings", { model: this.model, input: texts });
    const status = resp.status;
    const retryAfterMs = retryAfterOfHeaders(resp.headers);
    const body = await jsonWithIdleTimeout(resp, this.readTimeoutMs);
    if (!resp.ok) {
      throw failure("Embedding", status, retryAfterMs, body);
    }
    const data = (body as any)?.data;
    if (!Array.isArray(data)) {
      throw new Error("Unexpected embedding response shape");
    }
    return data.map((item) => {
      const embedding = item?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error("Embedding response is missing the vector");
      }
      return embedding.filter((x: unknown) => typeof x === "number");
    });
  }
}

function stripDataPrefix(line: string): string | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice("data:".length).trim();
}

/**
 * Splits a byte stream into SSE frames (blank-line separated), aborting the
 * response if no new byte arrives within `idleTimeoutMs`.
 */
async function* sseFrames(resp: Response, idleTimeoutMs: number): AsyncGenerator<string> {
  const body = resp.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (chunk === null) break;
      buf += decoder.decode(chunk, { stream: true });
      let pos: number;
      while ((pos = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, pos);
        buf = buf.slice(pos + 2);
        yield frame;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Unreachable(new Error("read timed out")));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([reader.read(), timeout]);
    if (result.done) return null;
    return result.value ?? new Uint8Array();
  } catch (e) {
    if (timedOut) {
      await reader.cancel().catch(() => {});
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Logs the token cost of one call. The cached-token count is the most
 * important field here: extraction relies on "the system message is
 * identical across chunks within one document" to hit the provider's
 * prefix cache. Putting per-chunk content into the system message zeroes
 * this out silently — this count is the only place that shows it.
 *
 * Field names differ by vendor: OpenAI uses
 * `prompt_tokens_details.cached_tokens`, DeepSeek uses
 * `prompt_cache_hit_tokens`. Read both; whichever is present wins.
 */
function logUsage(model: string, body: unknown): void {
  const u = (body as any)?.usage;
  if (u === undefined || u === null) return;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens;
  log.info("llm usage", {
    model,
    prompt: u?.prompt_tokens,
    completion: u?.completion_tokens,
    cached,
  });
}
