import { describe, expect, it } from "vitest";
import {
  historyError,
  rawRetentionMessage,
  snapshotError,
} from "./install-errors";

describe("snapshot errors", () => {
  it("explains a time outside retention without offering Retry", () => {
    const error = snapshotError(new Error("snapshot outside retention"));
    expect(error.title).toBe("This time is outside the 180-day retention");
    expect(error.detail).toContain("Return to live");
    expect(error.retryable).toBe(false);
  });

  it("explains an unreadable link time", () => {
    const error = snapshotError(new Error("invalid timestamp"));
    expect(error.title).toBe("This link's time could not be read");
    expect(error.retryable).toBe(false);
  });

  it("asks for a narrower scope when the hub refuses a broad read", () => {
    const error = snapshotError(new Error("snapshot too broad"));
    expect(error.title).toBe(
      "This scope is too large to load; narrow it to a cluster"
    );
    expect(error.retryable).toBe(false);
  });

  it("does not call an unresolved saved inventory a broad scope", () => {
    const error = snapshotError(
      new Error("historical inventory precision boundary too broad")
    );
    expect(error.title).not.toContain("scope");
    expect(error.retryable).toBe(false);
  });

  it("keeps Retry while an archive restore is running", () => {
    const error = snapshotError(
      new Error("archive restore in progress; retry")
    );
    expect(error.title).toBe("Archive restore in progress; retry shortly");
    expect(error.retryable).toBe(true);
  });

  it("asks to sign in again when the session is gone", () => {
    const error = snapshotError(new Error("authentication required"));
    expect(error.title).toBe("Reload and sign in again");
    expect(error.retryable).toBe(false);
  });

  it("claims the hub is unreachable only for a failed fetch", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ]) {
      const error = snapshotError(new TypeError(message));
      expect(error.title).toBe("The hub could not be reached");
      expect(error.retryable).toBe(true);
    }
    const other = snapshotError(new Error("observer state unavailable"));
    expect(other.title).not.toContain("reached");
    expect(other.detail).toBe("observer state unavailable");
    expect(other.retryable).toBe(true);
  });

  it("reports rejected input without Retry", () => {
    const error = snapshotError(
      new Error(
        JSON.stringify([
          { path: ["workspace"], message: "Invalid input", code: "custom" },
        ])
      )
    );
    expect(error.title).toBe("The hub rejected this request");
    expect(error.detail).toBe("workspace: Invalid input.");
    expect(error.retryable).toBe(false);
  });
});

describe("history errors", () => {
  it("reads the hub's 7-day refusal like the dashboard's own", () => {
    for (const error of [
      new Error("history range must be within 7 days"),
      new Error(rawRetentionMessage),
    ]) {
      expect(historyError(error)).toEqual({
        title:
          "Raw samples are kept for 7 days; this saved observation is older",
        detail: "",
        retryable: false,
      });
    }
  });

  it("asks for a shorter range when a history read is too broad", () => {
    const error = historyError(
      new Error("query too broad; select an entity and metric")
    );
    expect(error.detail).toBe("Choose a shorter range.");
    expect(error.retryable).toBe(false);
  });

  it("falls back to the snapshot reading for other errors", () => {
    expect(historyError(new TypeError("Failed to fetch")).retryable).toBe(true);
    expect(historyError(new Error("boom")).title).toBe("History unavailable");
  });
});
