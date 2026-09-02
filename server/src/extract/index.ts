/**
 * utopia-extract: LLM extraction (entities, relations, time normalization).
 *
 * The prompt injects the ontology's types and the document's known time.
 * The output is strict JSON. Evidence quotes are mandatory (a fact with no
 * quote gets a lower confidence).
 */

import type { ChatMessage } from "../llm";

export type ExtractedEntity = {
  name: string;
  type: string;
  /**
   * The model's own words for what this thing most specifically is. We do
   * not validate this against the ontology and do not store it in it.
   *
   * The reason it exists: every type list has a "close enough" entry. The
   * ontology has `product`; the model thinks that is good enough and picks
   * it, and the "vector database software" it had in mind is lost right
   * there. In practice, 17 entities all came back with an empty
   * `specific_type` for exactly this reason — and it is exactly what
   * later resolution needs most: a short name matches a short label far
   * better than a paragraph of Chinese prose matches "A software
   * application."
   */
  specificType?: string | null;
};

export type ExtractedFact = {
  subject: string;
  predicate: string;
  /** The object entity's name, for a relation fact. Empty for an attribute fact. */
  object?: string | null;
  /** The literal value, for an attribute fact (when the predicate is an attribute). */
  value?: unknown;
  validFrom?: string | null;
  validTo?: string | null;
  confidence?: number | null;
  quote?: string | null;
};

export type Extraction = {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  /**
   * How many items were skipped while parsing item by item. The caller
   * MUST be told this — a silent skip is a silent drop, the same class of
   * bug as "a partial extraction reported as complete".
   */
  skippedEntities: number;
  skippedFacts: number;
  /** True when the model's output was cut short and this is the repaired parse. */
  truncated: boolean;
};

/**
 * One relation as it appears in the prompt.
 *
 * It carries one thing a plain type list does not: a type signature. This
 * signature is a hint for the model, not a gate — it lowers the odds of
 * "Alice works_at Seattle" at the moment the model writes the fact,
 * instead of catching the mistake after the fact. Catching it after the
 * fact means a choice between a lost fact and dirty data; a signature
 * corrects course before anything is written. When the ontology itself is
 * wrong and the text plainly says otherwise, the model may still write
 * what the text says — a hard gate would drop data systematically, which
 * is exactly what happened with `part_of` before.
 */
export type PromptRelation = {
  key: string;
  label: string;
  description: string;
  /**
   * A shape such as `person|organization → vendor`. `*` means "either
   * side, unconstrained". An empty string means both sides are
   * unconstrained.
   *
   * Always use keys here, never labels: the model must write the key, and
   * in a Chinese-language knowledge base the label for `person` is "人物"
   * — putting it in the signature would teach the model to output a type
   * that does not exist (see decision 0004).
   */
  signature: string;
};

/**
 * Builds the extraction prompt.
 *
 * `types` is a list of (key, label, description) triples. When a
 * description is non-empty, it is listed on its own line — the semantic
 * guidance in the ontology drives extraction quality directly.
 *
 * `attributes` is a list of caller-formatted attribute lines (for example
 * `"person.salary (number, CNY): monthly salary"`). When empty, the prompt
 * is byte-for-byte the same as when no attributes are defined — a
 * knowledge base with no attributes pays nothing for this feature.
 *
 * `known` is the list of (type key, entity name) pairs already accepted
 * earlier in this same document, in first-appearance order. The first
 * chunk of a document has no "earlier", so its list is empty.
 */
export function buildMessages(
  types: [string, string, string][],
  relations: PromptRelation[],
  attributes: string[],
  docTime: string | null | undefined,
  filename: string,
  known: [string, string][],
  chunkText: string,
): ChatMessage[] {
  // Do not send the label when a description is present. A label is meant
  // for a human, and it tracks the corpus language, not the interface —
  // in a Chinese knowledge base the label for `person` is "人物". A line
  // such as "- person (人物): a specific named person…" gives almost no
  // extra information over the key, yet makes the prompt jump between the
  // corpus language and identifiers. Fall back to the label only when the
  // description is empty: a bare key alone is too thin (see decision 0004).
  const fmtList = (items: [string, string, string][]): string =>
    items
      .map(([k, l, d]) => {
        const desc = d.trim();
        return desc === "" ? `- ${k} (${l})` : `- ${k}: ${desc}`;
      })
      .join("\n");

  const typeList = fmtList(types);

  // A relation line: the signature, when present, takes the parenthesis;
  // otherwise the label fills it. Example:
  // `- works_at (person → organization): a person is employed by an organization.`
  const relList = relations
    .map((r) => {
      const d = r.description.trim();
      let paren: string;
      if (r.signature !== "") paren = r.signature;
      else if (d === "") paren = r.label;
      else paren = "";
      if (paren !== "" && d !== "") return `- ${r.key} (${paren}): ${d}`;
      if (paren !== "" && d === "") return `- ${r.key} (${paren})`;
      if (paren === "" && d !== "") return `- ${r.key}: ${d}`;
      return `- ${r.key}`;
    })
    .join("\n");

  // Explain the signature notation only when a real signature is present;
  // a knowledge base with no signatures gets a prompt that is unchanged.
  //
  // The instructions are in English — the prompt's INSTRUCTION language is
  // English; only the description text tracks the corpus language.
  //
  // The signature governs two separate things, and they must NOT be
  // covered by the same overridable rule. An earlier version folded both
  // into one sentence ("It is a hint, not a rule — when the text says
  // otherwise, write what the text says"), and the model then applied that
  // leniency to argument order too, writing
  // `Elon Musk (person) --employee--> Microsoft`
  // when schema.org declares `employee (organization → person)`. In one
  // real run, 102 of 130 checkable facts landed backwards this way — which
  // defeats the main selling point of using schema.org in the first place
  // (direction is declared, not merely described).
  //
  // The two things, said separately:
  // - WHICH TYPES MAY TAKE PART: a hint, not a gate. The ontology can be
  //   wrong, and when the text says Seattle, write Seattle.
  // - ARGUMENT ORDER: fixed by the signature. Order is not a claim about
  //   the world; it is this key's own encoding convention. The source text
  //   never "says a different direction" — it only states that a relation
  //   holds between two entities. When it is phrased the other way round,
  //   swap subject and object; do not reverse the relation instead.
  const sigNote = relations.some((r) => r.signature !== "")
    ? ". A parenthesis after the key is the type signature, subject then object; " +
      '"|" means or, "*" means unconstrained. Which kinds of things may take part ' +
      "is a hint, not a rule — when the text says otherwise, write what the text says. " +
      "The order is not a hint: the signature fixes which side is the subject. If the " +
      "text puts them the other way round, swap subject and object so that the subject " +
      "matches the left side — do not reverse the relation. For example, given " +
      '"employee (organization → person)" and a text saying "X is an employee of Y", ' +
      "write Y as the subject and X as the object"
    : "";

  const timeCtx = docTime
    ? `Document date: ${docTime}. Resolve relative time expressions (e.g. "last year", ` +
      `"this March") to absolute dates using it as the reference.`
    : "Document date unknown — only output dates explicitly written in the text.";

  // The attribute block is added only when needed: list, output note, and
  // value rules. When no attributes are defined, it does not appear at all.
  const attrSection =
    attributes.length === 0
      ? ""
      : `\nAttributes (literal-valued fields, listed as class.attribute_key; as "predicate" ` +
        `use the attribute_key alone — e.g. "salary", not "person.salary" — with a ` +
        `"value" instead of "object"):\n${attributes.join("\n")}\n`;
  const attrRules =
    attributes.length === 0
      ? ""
      : `\n10. Attribute facts carry "value" (no "object"): number = plain number without ` +
        `thousands separators or unit symbols; date = "YYYY[-MM[-DD]]"; bool = true/false; ` +
        `text = a short string. Only attach an attribute to a subject of its listed class. ` +
        `valid_from = when this value took effect, if the text says so.`;

  const system =
    `You are a knowledge-graph extraction engine. Extract entities and factual relations ` +
    `from the given text. Output exactly one JSON object and nothing else.\n\n` +
    `Entity types (prefer these keys):\n${typeList}\n\n` +
    `Relation types (prefer these keys)${sigNote}:\n${relList}\n` +
    `${attrSection}\n` +
    `Output format:\n` +
    `{"entities":[{"name":"entity name","type":"type key","specific_type":"what you would call it"}],\n` +
    ` "facts":[{"subject":"subject entity name","predicate":"relation key","object":"object entity name",\n` +
    `            "valid_from":"2023-01","valid_to":null,"confidence":0.9,"quote":"verbatim supporting quote"}]}\n\n` +
    `Rules:\n` +
    `1. Use the canonical full name as written in the text, in the text's original language; ` +
    `list each entity once. Text introduces a full name and then shortens it — ` +
    `"星云科技上海研究院" becomes "上海研究院", "Nebula Technologies Inc." becomes ` +
    `"Nebula" — and both forms mean one entity, listed once under the fuller form. ` +
    `Two names are two entities only when the text is talking about two things.\n` +
    `2. Every fact's subject/object must appear in entities.\n` +
    `3. Dates must be "YYYY", "YYYY-MM", "YYYY-MM-DD", or null — never invent dates.\n` +
    `3a. valid_to takes a third value: "unknown". Use it when the text says the relation ` +
    `has ended but does not say when — "former CEO of X", "stepped down", "left the ` +
    `company", "no longer available", "until recently". Use null only for something ` +
    `still going on. These are not interchangeable: null asserts it still holds, and ` +
    `writing null for a relation the text says is over makes us claim the opposite of ` +
    `the source.\n` +
    `4. ${timeCtx}\n` +
    `5. quote must be a contiguous excerpt from the source text; every fact needs one.\n` +
    `6. confidence in 0~1: 0.9 explicitly stated, 0.7 inferred, 0.5 uncertain.\n` +
    `7. If nothing can be extracted, output {"entities":[],"facts":[]}.\n` +
    `8. If no listed relation fits, do not force the nearest one — write the predicate the ` +
    `text itself uses, in snake_case (e.g. "available_on", "runs_on"). A relation ` +
    `named after the text is worth more than a listed one that says something false.\n` +
    `9. The same holds for entity types: if none of the listed types fits, write the type ` +
    `the text implies, in snake_case (e.g. "model", "technology"). Do not fall back ` +
    `to a broad listed type such as "thing" or "creative_work" merely because ` +
    `nothing specific matched — that hides the gap instead of reporting it.\n` +
    `10. specific_type is required on every entity and is never checked against the list. ` +
    `Name the most specific kind the thing is, in the words you would use for it. Write ` +
    `it even when "type" already fits, and make it narrower than "type" wherever the ` +
    `text supports it — type "product", specific_type "vector database software". ` +
    `Repeat the listed type only when the text genuinely says nothing more precise.` +
    `${attrRules}`;

  // The known-entity block sits right next to the body text: position
  // carries compliance, see the comment on knownBlock.
  const user = `Source file: "${filename}"\n${knownBlock(known)}\nText:\n${chunkText}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * The character budget for entities already seen in this document, inside
 * the prompt.
 *
 * Past the budget, entries are cut off (the earliest-seen ones are kept).
 * Chinese business text states the full name first and introduces the main
 * subject first, so first-appearance order naturally favors the names that
 * get abbreviated later.
 */
const KNOWN_BUDGET_CHARS = 1200;

/**
 * Formats "entities already accepted in this document" as a prompt block.
 * Returns an empty string when there are none.
 *
 * Why this sits right before the body text, with the instruction next to
 * the list it governs: an abstract rule loses to a concrete block placed
 * right next to it. In one real case, an ontology-guidance instruction
 * lost to the English JSON skeleton that followed it, until it moved
 * after the skeleton and was called out by name there. Compliance follows
 * position, so an instruction belongs next to the data it governs, and
 * both belong next to the body text.
 *
 * A separate rule, unrelated to which message this goes in: content that
 * changes from chunk to chunk always goes last. Prefix-cache matching
 * works on the token prefix, and messages concatenate system-then-user, so
 * "end of system" and "start of user" are nearly equivalent. What
 * actually breaks the cache is putting per-chunk content in the MIDDLE
 * (after the ontology, before the rules) — that pushes the rules out of
 * the prefix. The cache itself is outside our control — whether a
 * provider turns it on, or reports it, is up to them (measured `cached=0`
 * on this deployment) — our job is only to not break it. A self-hosted
 * vLLM turns automatic prefix caching on by default, and that saves
 * compute, not money.
 */
function knownBlock(known: [string, string][]): string {
  if (known.length === 0) return "";
  // Grouped by type: more compact, and it happens to suppress type drift
  // across chunks (the same "沧海" being `product` in one chunk and
  // `project` in another).
  const byType: [string, string[]][] = [];
  let used = 0;
  for (const [typeKey, name] of known) {
    used += [...name].length + 2;
    if (used > KNOWN_BUDGET_CHARS) break;
    const existing = byType.find(([k]) => k === typeKey);
    if (existing) existing[1].push(name);
    else byType.push([typeKey, [name]]);
  }
  if (byType.length === 0) return "";
  const lines = byType.map(([k, names]) => `  ${k}: ${names.join(", ")}`).join("\n");
  return (
    `\nAlready recorded from earlier parts of this same document:\n${lines}\n\n` +
    `If something in the text below refers to one of these, write that exact string as ` +
    `the name, and give it that same type — documents abbreviate after first mention ` +
    `("星云科技上海研究院" later becomes "上海研究院"), and the shortened form must ` +
    `not become a second entity. If it is a different thing, name it as the text does; ` +
    `do not force it onto this list.\n`
  );
}

/** Pulls the JSON object out of an LLM reply, tolerating code fences and surrounding chatter. */
export function jsonBlock(raw: string): string {
  const text = raw.trim();
  let cleaned = text;
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice("```json".length);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice("```".length);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON found in LLM reply");
  }
  return cleaned.slice(start, end + 1);
}

/**
 * Closes the brackets missing after `head`. Brackets inside a string
 * literal do not count — `"a[b"` does not open a bracket.
 *
 * Returns `null` when the structure itself is wrong (for example, a
 * bracket that closes something that was never opened) — that is not
 * "unfinished", it is broken.
 */
function closeBrackets(head: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const c of head) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") stack.push(c);
    else if (c === "]" || c === "}") {
      const want = c === "]" ? "[" : "{";
      if (stack.pop() !== want) return null;
    }
  }
  if (inStr) return null; // Cut off mid-string — this fragment is not usable.
  let out = head;
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "[" ? "]" : "}";
  }
  return out;
}

/**
 * When the output is cut short, falls back to the last complete object and
 * closes brackets from there.
 *
 * When the model runs out mid-write (hitting `max_tokens`), the objects
 * before the cut are complete and correct. Discarding the whole block
 * throws away a dozen already-correct facts along with it — in practice, 4
 * of 246 calls in one run were cut this way.
 */
function repairTruncated(json: string): string | null {
  let cut = json.length;
  for (let i = 0; i < 64; i++) {
    const idx = json.slice(0, cut).lastIndexOf("}");
    if (idx === -1) return null;
    const closed = closeBrackets(json.slice(0, idx + 1));
    if (closed !== null) {
      try {
        JSON.parse(closed);
        return closed;
      } catch {
        // fall through and try an earlier cut point
      }
    }
    cut = idx;
  }
  return null;
}

/**
 * One bad record must not spoil the whole chunk.
 *
 * An earlier version parsed the whole reply as one strict object — all or
 * nothing. One object missing `predicate`, or one truncated output, threw
 * away every entity and fact in the chunk, and a chunk often holds twenty
 * good facts. In one run, 5 of 246 calls (2%) were lost this way, and each
 * loss failed the whole `extract_document` task, triggering a retry, and
 * after three retries marked the document failed.
 *
 * Now: parse to a generic value first (closing brackets first if the
 * output was cut short), then convert item by item — keep the good ones,
 * count the bad ones. The count MUST be reported outward — a silent skip
 * is just another way of reporting a partial job as complete.
 */
export function parseResponse(raw: string): Extraction {
  const jsonStr = jsonBlock(raw);
  let value: unknown;
  let truncated = false;
  try {
    value = JSON.parse(jsonStr);
  } catch (e) {
    const fixed = repairTruncated(jsonStr);
    if (fixed === null) {
      throw new Error(`Failed to parse extraction JSON: ${(e as Error).message}`);
    }
    try {
      value = JSON.parse(fixed);
      truncated = true;
    } catch (e2) {
      throw new Error(`Failed to parse extraction JSON: ${(e2 as Error).message}`);
    }
  }

  function take<T>(
    obj: unknown,
    key: string,
    validate: (item: unknown) => T,
  ): { items: T[]; skipped: number } {
    const arr = (obj as Record<string, unknown>)?.[key];
    if (!Array.isArray(arr)) return { items: [], skipped: 0 };
    const items: T[] = [];
    let skipped = 0;
    for (const item of arr) {
      try {
        items.push(validate(item));
      } catch {
        skipped++;
      }
    }
    return { items, skipped };
  }

  const validateEntity = (item: unknown): ExtractedEntity => {
    const o = item as Record<string, unknown>;
    if (typeof o?.name !== "string" || typeof o?.type !== "string") {
      throw new Error("invalid entity");
    }
    const specificType = o.specific_type;
    return {
      name: o.name,
      type: o.type,
      specificType: typeof specificType === "string" ? specificType : null,
    };
  };

  const validateFact = (item: unknown): ExtractedFact => {
    const o = item as Record<string, unknown>;
    if (typeof o?.subject !== "string" || typeof o?.predicate !== "string") {
      throw new Error("invalid fact");
    }
    return {
      subject: o.subject,
      predicate: o.predicate,
      object: typeof o.object === "string" ? o.object : null,
      value: "value" in o ? o.value : undefined,
      validFrom: typeof o.valid_from === "string" ? o.valid_from : null,
      validTo: typeof o.valid_to === "string" ? o.valid_to : null,
      confidence: typeof o.confidence === "number" ? o.confidence : null,
      quote: typeof o.quote === "string" ? o.quote : null,
    };
  };

  const { items: entities, skipped: skippedEntities } = take(value, "entities", validateEntity);
  const { items: facts, skipped: skippedFacts } = take(value, "facts", validateFact);
  return { entities, facts, skippedEntities, skippedFacts, truncated };
}

// ---------------------------------------------------------------------------
// Entity-resolution adjudication (batched: one call judges many pairs; the
// LLM only handles the gray zone that embeddings cannot separate)
// ---------------------------------------------------------------------------

/** One side to adjudicate: a name, a type label, and a list of fact summary lines. */
export type AdjudicationSide = {
  name: string;
  typeLabel: string;
  facts: string[];
};

export type AdjudicationPair = {
  left: AdjudicationSide;
  right: AdjudicationSide;
};

export type AdjudicationVerdict = {
  i: number;
  verdict: string;
  confidence?: number | null;
};

/** Builds the batched adjudication prompt. Biased toward caution: not enough evidence means "unsure" (merging needs proof). */
export function buildAdjudicationMessages(pairs: AdjudicationPair[]): ChatMessage[] {
  const system =
    `You are an entity-resolution adjudicator for a knowledge graph. ` +
    `For each numbered pair, decide whether the two records refer to the SAME real-world ` +
    `entity or are namesakes (different entities that share a name).\n\n` +
    `Judge by the facts attached to each record: employer/affiliation, role, time ranges, ` +
    `and connected entities. Identical names alone are NEVER sufficient evidence of sameness. ` +
    `Contradictory affiliations in overlapping time periods indicate different entities ` +
    `(but people do change jobs — non-overlapping periods can belong to one person).\n\n` +
    `One name containing the other is a different case, and the rule above does not apply ` +
    `to it: "星云科技上海研究院" against "上海研究院", "Nebula Technologies Inc." ` +
    `against "Nebula". Documents drop the qualifier after first mention, so the shorter ` +
    `form is usually the longer one abbreviated — treat the containment as evidence FOR ` +
    `sameness and let the facts settle it. Shared people, parent or location confirm one ` +
    `entity; a different parent or conflicting leadership means the shorter name belongs ` +
    `to something else.\n` +
    `Abbreviation removes a qualifier from the FRONT. It never adds a noun or a ` +
    `prepositional phrase at the end, so those are different entities however much text ` +
    `they share: "the operator library for the Canghai Platform" is not the Canghai ` +
    `Platform, "Qiming X7 programme" is not the Qiming X7, and "沧海平台项目" is not ` +
    `"沧海平台" — a project, a programme, a team or a component is its own record.\n\n` +
    `Output exactly one JSON object and nothing else:\n` +
    `{"verdicts":[{"i":0,"verdict":"same|different|unsure","confidence":0.9}]}\n\n` +
    `Rules:\n` +
    `1. One verdict per pair, using the pair's number as "i".\n` +
    `2. confidence in 0~1.\n` +
    `3. Be conservative: if the evidence is insufficient to decide, answer "unsure" — ` +
    `a wrong merge is far more damaging than leaving two records separate.`;

  const fmtSide = (s: AdjudicationSide): string => {
    const facts =
      s.facts.length === 0 ? "  (no recorded facts)" : s.facts.map((f) => `  - ${f}`).join("\n");
    return `"${s.name}" (${s.typeLabel})\n${facts}`;
  };
  let user = "";
  pairs.forEach((p, i) => {
    user += `Pair ${i}:\nRecord A: ${fmtSide(p.left)}\nRecord B: ${fmtSide(p.right)}\n\n`;
  });

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseAdjudication(raw: string): AdjudicationVerdict[] {
  const jsonStr = jsonBlock(raw);
  let reply: unknown;
  try {
    reply = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse adjudication JSON: ${(e as Error).message}`);
  }
  const verdicts = (reply as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(verdicts)) return [];
  return verdicts.map((v) => {
    const o = v as Record<string, unknown>;
    return {
      i: typeof o.i === "number" ? o.i : 0,
      verdict: typeof o.verdict === "string" ? o.verdict : "",
      confidence: typeof o.confidence === "number" ? o.confidence : null,
    };
  });
}

/**
 * Normalizes an attribute value to its datatype. Returns `null` on
 * failure — an omission is better than a dirty value; the caller skips and
 * logs it. `number` tolerates thousands separators and spaces; `date`
 * requires `YYYY[-MM[-DD]]` and keeps its original precision; `bool` reads
 * yes/no loosely.
 */
export function normalizeAttrValue(datatype: string, raw: unknown): unknown {
  switch (datatype) {
    case "number": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      if (typeof raw === "string") {
        const cleaned = raw.replace(/[,\s_]/g, "");
        const n = Number(cleaned);
        return cleaned !== "" && Number.isFinite(n) ? n : null;
      }
      return null;
    }
    case "date": {
      if (typeof raw !== "string") return null;
      const s = raw.trim();
      return parseTime(s) !== null ? s : null;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        switch (raw.trim().toLowerCase()) {
          case "true":
          case "yes":
          case "是":
            return true;
          case "false":
          case "no":
          case "否":
            return false;
          default:
            return null;
        }
      }
      return null;
    }
    default: {
      let s: string;
      if (typeof raw === "string") s = raw.trim();
      else if (typeof raw === "number") s = String(raw);
      else return null;
      return s === "" ? null : [...s].slice(0, 500).join("");
    }
  }
}

export type TimePrecision = "year" | "month" | "day";

/** Parses a time string into (UTC instant, precision). Supports YYYY / YYYY-MM / YYYY-MM-DD. */
export function parseTime(s: string): { date: Date; precision: TimePrecision } | null {
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayMatch) {
    const [, y, m, d] = dayMatch;
    const date = fromYmd(Number(y), Number(m), Number(d));
    return date ? { date, precision: "day" } : null;
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (monthMatch) {
    const [, y, m] = monthMatch;
    const date = fromYmd(Number(y), Number(m), 1);
    return date ? { date, precision: "month" } : null;
  }

  if (/^\d{4}$/.test(trimmed)) {
    const date = fromYmd(Number(trimmed), 1, 1);
    return date ? { date, precision: "year" } : null;
  }

  return null;
}

/** Builds a UTC midnight Date from calendar fields, rejecting a date that overflows (like 2024-02-30). */
function fromYmd(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}
