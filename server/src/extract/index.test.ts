import { describe, expect, test } from "bun:test";
import {
  buildMessages,
  jsonBlock,
  normalizeAttrValue,
  parseAdjudication,
  parseResponse,
  parseTime,
  type PromptRelation,
} from "./index";

function rel(key: string, description: string, signature: string): PromptRelation {
  return { key, label: key.replace(/_/g, " "), description, signature };
}

describe("prompt shape", () => {
  /**
   * The signature takes the parenthesis, and it is always the key: in a
   * Chinese knowledge base the label for `person` is "人物", and putting
   * that in the prompt would teach the model to output a type that does
   * not exist.
   */
  test("a signature takes the parenthesis and uses keys", () => {
    const rels = [rel("works_at", "受雇于某个组织。", "person → organization")];
    const msgs = buildMessages([], rels, [], null, "a.txt", [], "text");
    expect(msgs[0]!.content).toContain("- works_at (person → organization): 受雇于某个组织。");
  });

  /** Several classes join with a pipe, and an empty side is a star — both are key-level notation, not type names. */
  test("several classes join with a pipe and an empty side is a star", () => {
    const rels = [rel("buys_from", "", "employee|team → *")];
    const msgs = buildMessages([], rels, [], null, "a.txt", [], "text");
    expect(msgs[0]!.content).toContain("- buys_from (employee|team → *)");
  });

  /**
   * A knowledge base with no signatures pays nothing: the notation note
   * does not appear either. Most knowledge bases never declare
   * domain/range, and they should not pay a token cost per chunk for it.
   */
  test("a base without signatures pays nothing", () => {
    const rels = [rel("works_at", "受雇于某个组织。", "")];
    const msgs = buildMessages([], rels, [], null, "a.txt", [], "text");
    expect(msgs[0]!.content).toContain("- works_at: 受雇于某个组织。");
    expect(msgs[0]!.content).not.toContain("type signature");
    expect(msgs[0]!.content).not.toContain("→");
  });

  /**
   * The prompt must say the signature is a hint. Without this sentence,
   * the model treats the signature as a hard rule, and when the ontology
   * is wrong it drops data systematically (the way `part_of` did).
   */
  test("the prompt says the signature is a hint", () => {
    const rels = [rel("works_at", "d", "person → organization")];
    const msgs = buildMessages([], rels, [], null, "a.txt", [], "text");
    expect(msgs[0]!.content).toContain("hint, not a rule");
  });

  /**
   * But order is NOT a hint.
   *
   * Both sentences must be present; losing either one reintroduces an old
   * bug: without "a hint, not a gate", a wrong ontology drops data
   * systematically (the `part_of` way); without "order is fixed by the
   * signature", the model follows English word order and writes
   * `Musk --employee--> Microsoft`, while schema.org declares
   * `employee (organization → person)` — in one real run, 102 of 130
   * checkable facts landed backwards this way.
   */
  test("the prompt says the order is not a hint", () => {
    const rels = [rel("employee", "d", "organization → person")];
    const msgs = buildMessages([], rels, [], null, "a.txt", [], "text");
    const c = msgs[0]!.content;
    expect(c).toContain("hint, not a rule");
    expect(c).toContain("The order is not a hint");
    expect(c).toContain("swap subject and object");
    expect(c).toContain("do not reverse the relation");
  });

  /**
   * Known entities must land in the USER message, right next to the body
   * text. Compliance is not about caching: an abstract rule loses to a
   * concrete block placed right next to it. Putting the list in the
   * system message's rule section would put it behind the output format,
   * ten rules, and the filename — as far as possible from the body text
   * it is meant to govern.
   */
  test("known entities stay out of the system message", () => {
    // Use a name absent from rule 1's example: rule 1 also mentions
    // "星云科技上海研究院", so asserting on it would not prove which
    // message the list actually lands in.
    const known: [string, string][] = [["organization", "华瑞集团智能制造研究院"]];
    const msgs = buildMessages([], [], [], null, "a.txt", known, "text");
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).not.toContain("Already recorded");
    expect(msgs[0]!.content).not.toContain("华瑞集团智能制造研究院");
    expect(msgs[1]!.content).toContain("organization: 华瑞集团智能制造研究院");
  });

  /** The first chunk has no "earlier", so the block must not appear at all — zero cost, not an empty heading. */
  test("the first chunk carries no block", () => {
    const msgs = buildMessages([], [], [], null, "a.txt", [], "text");
    expect(msgs[1]!.content).not.toContain("Already recorded");
  });

  /** The anti-forcing guardrail must be present: giving a reference point invites forcing a match onto it. */
  test("the block tells the model not to force a match", () => {
    const known: [string, string][] = [["person", "陈立"]];
    const msgs = buildMessages([], [], [], null, "a.txt", known, "text");
    expect(msgs[1]!.content).toContain("do not force it onto this list");
  });

  /**
   * A described type drops the label: a Chinese knowledge base's label is
   * Chinese, and mixing it into the prompt only makes identifiers jump
   * between languages, for almost no extra information over the key.
   */
  test("described types drop the label", () => {
    const types: [string, string, string][] = [
      ["person", "人物", "有名有姓的具体的人。"],
      ["event", "事件", ""],
    ];
    const msgs = buildMessages(types, [], [], null, "a.txt", [], "text");
    const prompt = JSON.stringify(msgs);
    expect(prompt).toContain("- person: 有名有姓的具体的人。");
    expect(prompt).not.toContain("person (人物)");
    // With an empty description the label is still the only extra clue, so keep it.
    expect(prompt).toContain("- event (事件)");
  });
});

describe("parseTime", () => {
  test("precisions", () => {
    expect(parseTime("2024")?.precision).toBe("year");
    expect(parseTime("2024-07")?.precision).toBe("month");
    expect(parseTime("2024-07-15")?.precision).toBe("day");
    expect(parseTime("null")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("下个月")).toBeNull();
  });

  test("UTC instant", () => {
    expect(parseTime("2024-07-15")?.date.toISOString()).toBe("2024-07-15T00:00:00.000Z");
    expect(parseTime("2024-07")?.date.toISOString()).toBe("2024-07-01T00:00:00.000Z");
    expect(parseTime("2024")?.date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });
});

test("parseAdjudication reads a fenced reply", () => {
  const raw =
    '```json\n{"verdicts":[{"i":0,"verdict":"same","confidence":0.92},{"i":1,"verdict":"unsure"}]}\n```';
  const v = parseAdjudication(raw);
  expect(v.length).toBe(2);
  expect(v[0]!.verdict).toBe("same");
  expect(v[1]!.confidence).toBeNull();
});

test("normalizeAttrValue for each datatype", () => {
  expect(normalizeAttrValue("number", "35,000")).toBe(35000);
  expect(normalizeAttrValue("number", 42)).toBe(42);
  expect(normalizeAttrValue("number", "about ten")).toBeNull();
  expect(normalizeAttrValue("date", "2024-07")).toBe("2024-07");
  expect(normalizeAttrValue("date", "下个月")).toBeNull();
  expect(normalizeAttrValue("bool", "yes")).toBe(true);
  expect(normalizeAttrValue("text", " CTO ")).toBe("CTO");
  expect(normalizeAttrValue("text", [1])).toBeNull();
});

describe("parseResponse", () => {
  /**
   * One malformed record must not take down the whole chunk.
   *
   * The shape is taken from a real log: `missing field "predicate"`. The
   * model occasionally omits this field, and a strict all-or-nothing parse
   * used to drop the whole chunk — including two other facts in it that
   * were fine.
   */
  test("one malformed fact does not take the whole chunk", () => {
    const raw = `{
      "entities": [{"name": "OpenAI", "type": "organization"}],
      "facts": [
        {"subject": "OpenAI", "predicate": "produces", "object": "GPT-4"},
        {"subject": "OpenAI", "object": "ChatGPT"},
        {"subject": "Sam Altman", "predicate": "leads", "object": "OpenAI"}
      ]
    }`;
    const x = parseResponse(raw);
    expect(x.facts.length).toBe(2);
    expect(x.skippedFacts).toBe(1);
    expect(x.entities.length).toBe(1);
    expect(x.truncated).toBe(false);
  });

  /**
   * A cut-off reply must keep what was already complete.
   *
   * When the model hits `max_tokens` it stops mid-write. The objects
   * before the cut are complete and correct; discarding the whole chunk
   * throws away a dozen good facts along with it.
   */
  test("a cut-off reply keeps what was complete", () => {
    const raw = `{
      "entities": [{"name": "Anthropic", "type": "organization"}],
      "facts": [
        {"subject": "Anthropic", "predicate": "produces", "object": "Claude"},
        {"subject": "Dario Amodei", "predicate": "leads", "object": "Anthropic"},
        {"subject": "Anthropic", "predicate": "loca`;
    const x = parseResponse(raw);
    expect(x.truncated).toBe(true);
    expect(x.facts.length).toBe(2);
    expect(x.entities.length).toBe(1);
  });

  /** A bracket inside a string does not count as structure — `"a[b"` does not open a bracket. */
  test("brackets inside strings are not structure", () => {
    const raw = `{"entities": [], "facts": [{"subject": "a[b{c", "predicate": "p", "object": "o"}]}`;
    const x = parseResponse(raw);
    expect(x.facts.length).toBe(1);
    expect(x.truncated).toBe(false);
  });

  /** With not even one complete object, this must still fail — leniency does not mean reporting an empty result as success. */
  test("a reply with nothing complete still fails", () => {
    expect(() => parseResponse('{"facts": [{"subject": "a')).toThrow();
  });

  test("reads a reply wrapped in a code fence", () => {
    const raw =
      '好的，结果如下：\n```json\n{"entities":[{"name":"张三","type":"person"}],"facts":[]}\n```';
    const e = parseResponse(raw);
    expect(e.entities.length).toBe(1);
    expect(e.entities[0]!.type).toBe("person");
  });

  /**
   * specific_type is in both the skeleton and the rules, and both say
   * "always fill this in". Being only in the skeleton is not enough: when
   * a rule and the skeleton conflict, the skeleton wins (the language rule
   * has broken this way before). Here the two agree, so both must be pinned.
   */
  test("every entity is asked for its own words", () => {
    const msgs = buildMessages([], [], [], null, "a.txt", [], "text");
    const sys = msgs[0]!.content;
    expect(sys).toContain('"specific_type":"what you would call it"');
    expect(sys).toContain("required on every entity");
    // The key sentence: it is not validated. Validating it would just build another vocabulary.
    expect(sys).toContain("never checked against the list");
    // The relationship to `type` must be spelled out, or the model just copies the broad type.
    expect(sys).toContain("narrower than");
  });
});

test("jsonBlock strips fences and surrounding text", () => {
  expect(jsonBlock('noise {"a":1} noise')).toBe('{"a":1}');
  expect(jsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(() => jsonBlock("no json here")).toThrow();
});
