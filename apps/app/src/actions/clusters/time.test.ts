import { describe, expect, it } from "vitest";
import { normalizeTime, validRangeTime } from "./index";

describe("history range timestamps", () => {
  it("retains all nanoseconds when converting offsets", () => {
    expect(normalizeTime("2026-10-13T10:30:00.123456789+03:00")).toBe(
      "2026-10-13T07:30:00.123456789Z"
    );
    expect(normalizeTime("2026-10-13T07:30:00Z")).toBe(
      "2026-10-13T07:30:00.000000000Z"
    );
    expect(validRangeTime("2026-10-13T10:30:00+03:00")).toBe(
      Date.parse("2026-10-13T07:30:00Z")
    );
  });
  it("rejects calendar rollover and non-RFC3339 input", () => {
    expect(() => normalizeTime("2026-02-30T00:00:00Z")).toThrow();
    expect(() => validRangeTime("tomorrow")).toThrow();
    expect(() => normalizeTime("2026-10-13T07:30:00+25:00")).toThrow();
  });
});
