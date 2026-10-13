import { describe, expect, it } from "vitest";
import { isUniqueViolation, normalizeD1Error, toD1Value } from "./d1-driver";

describe("D1 adapter boundaries", () => {
  it("retains constraint classification through runtime causes", () => {
    const error = normalizeD1Error(
      new Error(
        "D1_ERROR: UNIQUE constraint failed: Workspace.id: SQLITE_CONSTRAINT_UNIQUE"
      )
    );
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("wrapped", { cause: error }))).toBe(
      true
    );
    expect(
      isUniqueViolation(
        normalizeD1Error(
          new Error(
            "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY"
          )
        )
      )
    ).toBe(false);
  });
  it("does not round large integer parameters before binding", () => {
    expect(toD1Value(9_007_199_254_740_993n, 0)).toBe("9007199254740993");
    expect(toD1Value(123n, 0)).toBe(123);
    expect(() => toD1Value(Number.NaN, 0)).toThrow();
  });
  it("binds only the requested byte-view span", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(
      new Uint8Array(toD1Value(bytes.subarray(1, 3), 0) as ArrayBuffer)
    ).toEqual(new Uint8Array([2, 3]));
    expect(toD1Value(undefined, 0)).toBeNull();
  });
});
