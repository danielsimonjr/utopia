import { describe, expect, test } from "bun:test";
import { changesWindow, changeLine } from "./tools";
import type { GraphChange } from "../../store/graph";
import { newId } from "../../core/ids";

function d(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!));
}
function t(s: string): Date {
  return new Date(s);
}

describe("changesWindow", () => {
  // Someone who says "through March 31" means to include the 31st. The
  // SQL side is a half-open "< end", so end must land at April 1st
  // midnight - one day off and asking for the 31st silently drops it.
  test("until names a day the window must contain", () => {
    const win = changesWindow(d("2026-03-01"), d("2026-03-31"), t("2026-06-01T00:00:00Z"));
    expect(win).not.toBeNull();
    expect(win!.start).toEqual(t("2026-03-01T00:00:00Z"));
    expect(win!.end).toEqual(t("2026-04-01T00:00:00Z"));
    // The display string must NEVER show 04-01: that is an internal
    // detail of the half-open range, and printing it would tell the
    // model the window is a day wider than it asked for (this really
    // happened once).
    expect(win!.label).toBe("2026-03-01 → 2026-03-31");
  });

  // With no `until`, the display string says "now". Formatting `end`
  // instead would treat the server clock as the user's own boundary -
  // it looks like a precise answer, but it is really just "what time is
  // it right now".
  test("an open window says now rather than the clock", () => {
    const now = t("2026-06-01T13:45:00Z");
    const win = changesWindow(d("2026-03-01"), null, now);
    expect(win).not.toBeNull();
    expect(win!.end).toEqual(now);
    expect(win!.label).toBe("2026-03-01 → now");
  });

  test("without since there is no window", () => {
    expect(changesWindow(null, d("2026-03-31"), t("2026-06-01T00:00:00Z"))).toBeNull();
  });
});

function baseChange(kind: string): GraphChange {
  return {
    fact_id: newId(),
    at: t("2026-08-28T10:00:00Z"),
    kind,
    subject_id: newId(),
    subject_name: "Acme",
    predicate_label: "founded in",
    object_name: null,
    object_value: null,
    valid_from: null,
    valid_to: null,
    valid_from_precision: null,
    valid_to_precision: null,
    confidence: 0.9,
    document_id: null,
    filename: null,
    quote: null,
  };
}

describe("changeLine", () => {
  // A literal value must read as itself. Calling `.toString()` on a JSON
  // string would print the quotes along with it, and the model would
  // treat "1993" (with quotes) as part of the answer.
  test("a literal value reads as itself, not as JSON", () => {
    const c = baseChange("asserted");
    c.object_value = "1993";
    expect(changeLine(c).endsWith("Acme founded in 1993")).toBe(true);
  });

  // The two time axes must be visibly two different things on one line:
  // the record-time moment comes first with no label, the world-axis
  // range trails the assertion tagged "valid". Printed as one run of
  // dates, "recorded in 2026" reads as "happened in 2026" - the exact
  // misreading this tool exists to prevent.
  test("the record time and the valid range do not read as one date run", () => {
    const c = baseChange("corrected");
    c.object_name = "Berlin";
    c.predicate_label = "headquartered in";
    c.valid_from = t("2019-01-01T00:00:00Z");
    const line = changeLine(c);
    expect(line.startsWith("2026-08-28 corrected: ")).toBe(true);
    expect(line).toContain("[valid 2019-01-01 → now]");
  });

  // No evidence, no claim of evidence. Adding a "from ..." tag anyway
  // would make an unsourced assertion look sourced.
  test("a fact with no evidence claims no document", () => {
    const c = baseChange("rejected");
    c.object_name = "Berlin";
    expect(changeLine(c)).not.toContain("from");
  });

  test("evidence carries the filename and the quote", () => {
    const c = baseChange("corrected");
    c.object_name = "Berlin";
    c.filename = "annual-report.pdf";
    c.quote = "moved its head office to Berlin";
    const line = changeLine(c);
    expect(line).toContain('from "annual-report.pdf"');
    expect(line).toContain('"moved its head office to Berlin"');
  });
});
