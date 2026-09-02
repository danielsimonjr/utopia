import { describe, expect, test } from "bun:test";
import {
  LlmClient,
  OutOfCredit,
  RateLimited,
  Unreachable,
  isUnreachable,
  outOfCredit,
  rateLimited,
} from "./index";

/** Starts a dummy HTTP server for one test and returns its base URL and a stop function. */
function dummyServer(handler: (req: Request) => Response | Promise<Response>): {
  url: string;
  stop: () => void;
} {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Starts a TCP listener that accepts connections and holds them open
 * without ever writing a byte back. This is the shape a hung endpoint
 * takes in production: the TCP handshake succeeds, the request goes out,
 * and then nothing comes back.
 */
function silentServer(): { url: string; stop: () => void } {
  const sockets: { end: () => void }[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        sockets.push(socket);
      },
      data() {},
      close() {},
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      for (const s of sockets) s.end();
      server.stop(true);
    },
  };
}

describe("error classification", () => {
  test("a 402 is a billing problem", async () => {
    const { url, stop } = dummyServer(
      () => new Response(JSON.stringify({ message: "Sorry, your account balance is insufficient" }), { status: 402 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(outOfCredit(err)).toBeInstanceOf(OutOfCredit);
    } finally {
      stop();
    }
  });

  test("a 429 that says insufficient_quota is a billing problem, not a rate limit", async () => {
    const { url, stop } = dummyServer(
      () =>
        new Response(
          JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }),
          { status: 429 },
        ),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(outOfCredit(err)).toBeInstanceOf(OutOfCredit);
      expect(rateLimited(err)).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("a plain 429 is still a rate limit", async () => {
    const { url, stop } = dummyServer(
      () => new Response(JSON.stringify({ error: { message: "TPM limit reached" } }), { status: 429 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(rateLimited(err)).toBeInstanceOf(RateLimited);
      expect(outOfCredit(err)).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("a rate limit without Retry-After is still a rate limit", async () => {
    const { url, stop } = dummyServer(
      () => new Response(JSON.stringify({ error: { message: "TPM limit reached" } }), { status: 429 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      const hit = rateLimited(err);
      expect(hit).toBeDefined();
      expect(hit?.retryAfterMs).toBeNull();
    } finally {
      stop();
    }
  });

  test("Retry-After, when sent, is read into retryAfterMs", async () => {
    const { url, stop } = dummyServer(
      () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(rateLimited(err)?.retryAfterMs).toBe(7000);
    } finally {
      stop();
    }
  });

  test("a clean 401 is a different problem: not rate limited, not unreachable", async () => {
    const { url, stop } = dummyServer(
      () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(rateLimited(err)).toBeUndefined();
      expect(outOfCredit(err)).toBeUndefined();
      expect(isUnreachable(err)).toBe(false);
    } finally {
      stop();
    }
  });

  test("classification survives being wrapped by extra context layers", async () => {
    const { url, stop } = dummyServer(
      () => new Response(JSON.stringify({ error: { message: "TPM limit reached" } }), { status: 429 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const raw = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      const wrapped = new Error("process_document failed", {
        cause: new Error("extract failed", { cause: raw }),
      });
      const hit = rateLimited(wrapped);
      expect(hit?.status).toBe(429);
      // The outermost message must not leak the endpoint's wording.
      expect(wrapped.message).not.toContain("rate limiting");
    } finally {
      stop();
    }
  });
});

describe("Unreachable", () => {
  test("connecting to a closed port is Unreachable, not a clean API error", async () => {
    // Nothing listens on port 1, and 127.0.0.1 bypasses any proxy.
    const client = new LlmClient("http://127.0.0.1:1", null, "m");
    const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
    expect(isUnreachable(err)).toBe(true);
  });

  test("Unreachable survives context layers, and the wrapper text hides the endpoint wording", async () => {
    const client = new LlmClient("http://127.0.0.1:1", null, "m");
    const raw = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
    const wrapped = new Error("process_document failed", { cause: new Error("embedding failed", { cause: raw }) });
    expect(isUnreachable(wrapped)).toBe(true);
    expect(wrapped.message).not.toContain("endpoint");
  });

  test("an ordinary failure is not mistaken for an unreachable endpoint", () => {
    const err = new Error("extraction failed", { cause: new Error("embedding response is missing the vector") });
    expect(isUnreachable(err)).toBe(false);
  });

  /**
   * A request must fail with an error, never hang forever.
   *
   * Without this guard, the failure mode in production looks like this: an
   * ingest run dies partway through, every worker slot is stuck waiting on
   * a request that will never finish, and nothing in the logs or the UI
   * says why.
   */
  test("a silently-connected server ends in an error, not a hang", async () => {
    const { url, stop } = silentServer();
    try {
      const client = LlmClient.withTimeouts(url, null, "m", 5000, 300);
      const started = Date.now();
      const err = await client.chat([{ role: "user", content: "hi" }]).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isUnreachable(err)).toBe(true);
      // The read timeout (300ms), not the connect timeout (5000ms), must be
      // what ends this — otherwise this assertion would need to wait 5s.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      stop();
    }
  }, 10_000);
});

describe("successful calls (against a local dummy server)", () => {
  test("chat returns the message content", async () => {
    const { url, stop } = dummyServer(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "hello there" } }] }), { status: 200 }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const reply = await client.chat([{ role: "user", content: "hi" }]);
      expect(reply).toBe("hello there");
    } finally {
      stop();
    }
  });

  test("embed returns one vector per input", async () => {
    const { url, stop } = dummyServer(
      () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
          { status: 200 },
        ),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const vectors = await client.embed(["a", "b"]);
      expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    } finally {
      stop();
    }
  });

  test("chatStream yields text deltas from an SSE response", async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n` +
      `data: [DONE]\n\n`;
    const { url, stop } = dummyServer(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const chunks: string[] = [];
      for await (const delta of client.chatStream([{ role: "user", content: "hi" }])) {
        chunks.push(delta);
      }
      expect(chunks.join("")).toBe("Hello");
    } finally {
      stop();
    }
  });

  test("chatToolsStream merges tool-call deltas by index and yields the full turn last", async () => {
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const sse =
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }) +
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] } }] }) +
      frame({ choices: [{ delta: { content: "done" } }] }) +
      `data: [DONE]\n\n`;
    const { url, stop } = dummyServer(
      () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    try {
      const client = new LlmClient(url, null, "m");
      const deltas: string[] = [];
      let turn;
      for await (const item of client.chatToolsStream([{ role: "user", content: "hi" }], [])) {
        if (item.kind === "delta") deltas.push(item.text);
        else turn = item.turn;
      }
      expect(deltas).toEqual(["done"]);
      expect(turn?.content).toBe("done");
      expect(turn?.toolCalls).toEqual([{ id: "call_1", name: "search", arguments: '{"q":"cats"}' }]);
    } finally {
      stop();
    }
  });
});
