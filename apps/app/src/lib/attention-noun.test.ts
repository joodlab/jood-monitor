import { describe, expect, it } from "vitest";
import type { Severity } from "./attention";
import { rowsNoun } from "./attention-noun";

function rows(...severities: Severity[]) {
  return severities.map((severity) => ({ severity }));
}

describe("the noun for the visible attention rows", () => {
  it("calls info rows alone notes, never problems", () => {
    expect(rowsNoun(rows("info"))).toBe("notes");
    expect(rowsNoun(rows("info", "info", "info"))).toBe("notes");
  });

  it("calls rows without info problems", () => {
    expect(rowsNoun(rows("critical", "warning"))).toBe("problems");
    expect(rowsNoun(rows("warning"))).toBe("problems");
  });

  it("calls a mix of problems and notes items", () => {
    expect(rowsNoun(rows("critical", "info"))).toBe("items");
    expect(rowsNoun(rows("info", "warning", "info"))).toBe("items");
  });

  it("calls an empty list problems, as nothing in it is a note", () => {
    expect(rowsNoun([])).toBe("problems");
  });
});
