import { describe, expect, test } from "bun:test";
import { baseTools, checkCall } from "./chat";

describe("checkCall", () => {
  // Arguments cut off mid-JSON: this is what happens when the model
  // hits the token cap. This used to fall back to an empty object, and
  // then search_chunks would search using the user's own question. The
  // result looked like a perfectly normal "search - 6 sources" trace
  // with a wrong-input answer behind it. Nobody double-checks an answer
  // that looks fine, so this case must be a refusal.
  test("arguments cut off mid-JSON do not become a search", () => {
    const tools = baseTools();
    const result = checkCall(tools, "search_chunks", '{"query": "Acme reven');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step.kind).toBe("tool");
      expect(result.step.detail).toBe("bad arguments");
      expect(result.message).toContain("not valid JSON");
      expect(result.message).toContain("again");
    }
  });

  // An empty string and a missing field are the same thing:
  // {"query": ""} retrieves something unrelated to the question, and it
  // still shows up as a perfectly normal trace step.
  test("an empty required argument counts as missing", () => {
    const tools = baseTools();
    for (const raw of ["{}", '{"query": ""}', '{"query": "   "}', '{"query": null}']) {
      const result = checkCall(tools, "search_chunks", raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.step.detail).toBe("missing query");
    }
  });

  // The criterion comes from the schema itself. This guards against
  // adding a required argument and forgetting to update validation:
  // query_data only appears in the schema once a data source is
  // mounted, and its two required arguments have never been written
  // out separately anywhere else.
  test("the schema is the only place required is written down", () => {
    const tools = (baseTools() as any[]).concat([
      {
        type: "function",
        function: {
          name: "query_data",
          parameters: { type: "object", properties: {}, required: ["data_source", "sql"] },
        },
      },
    ]);
    const missing = checkCall(tools, "query_data", '{"data_source": "warehouse"}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.step.detail).toBe("missing sql");
    const ok = checkCall(tools, "query_data", '{"data_source": "warehouse", "sql": "SELECT 1"}');
    expect(ok.ok).toBe(true);
  });

  // A well-formed call passes through untouched, optional arguments and
  // all. This gate only judges whether the call said what it wants to
  // do; it does not filter. Reassembling args here would mean
  // remembering to add every new optional argument in a second place,
  // and a forgotten one would silently stop working.
  test("a well-formed call passes through untouched", () => {
    const tools = baseTools();
    const result = checkCall(
      tools,
      "entity_facts",
      '{"entity_id": "1f8ac10b-58cc-4372-a567-0e02b2c3d479", "at": "2026-03-15"}',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.at).toBe("2026-03-15");
  });

  // "changes" already refused a missing "since" on its own. This pins
  // down two things: the new unified gate agrees with it, and the date
  // format check (e.g. "2026-13-45") is still its own job, since
  // checkCall only looks at presence, not validity.
  test("the one tool that already refused still refuses", () => {
    const tools = baseTools();
    expect(checkCall(tools, "changes", "{}").ok).toBe(false);
    const withBadDate = checkCall(tools, "changes", '{"since": "2026-13-45"}');
    expect(withBadDate.ok).toBe(true);
  });
});
