import { describe, expect, it } from "vitest";
import { historyError, snapshotError } from "./install-errors";
import { rawRetentionMessage } from "./retention";

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

  it("names the per-cluster series cap without advice no filter can follow", () => {
    const error = snapshotError(new Error("snapshot too broad"));
    expect(error.title).toBe(
      "A cluster reports more series than one view can load"
    );
    // The snapshot is read per workspace; a cluster filter cannot shrink it.
    expect(error.detail).not.toContain("narrow");
    // The count is live state, so a later read can succeed.
    expect(error.retryable).toBe(true);
  });

  it("points a saved observation's broad sample read to another time", () => {
    const error = snapshotError(
      new Error("query too broad; select an entity and metric")
    );
    expect(error.title).toBe(
      "The saved samples at this time are too many to load"
    );
    expect(error.detail).toContain("Return to live");
    expect(error.detail).not.toContain("entity");
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
  it("reads the hub's 7-day refusal like the dashboard's own when frozen", () => {
    for (const error of [
      new Error("history range must be within 7 days"),
      new Error(rawRetentionMessage),
    ]) {
      expect(historyError(error, true)).toEqual({
        title:
          "Raw samples are kept for 7 days; this saved observation is older",
        detail: "",
        retryable: false,
      });
    }
  });

  it("never calls a live window a saved observation", () => {
    // Live, the refusal means the browser and hub clocks disagreed.
    const error = historyError(new Error(rawRetentionMessage), false);
    expect(error.title).toBe("History unavailable");
    expect(error.title).not.toContain("saved observation");
    expect(error.retryable).toBe(true);
  });

  it("asks for a shorter range when a history read is too broad", () => {
    for (const frozen of [true, false]) {
      const error = historyError(
        new Error("query too broad; select an entity and metric"),
        frozen
      );
      expect(error.detail).toBe("Choose a shorter range.");
      expect(error.retryable).toBe(false);
    }
  });

  it("falls back to the snapshot reading for other errors", () => {
    expect(
      historyError(new TypeError("Failed to fetch"), false).retryable
    ).toBe(true);
    expect(historyError(new Error("boom"), true).title).toBe(
      "History unavailable"
    );
  });
});
