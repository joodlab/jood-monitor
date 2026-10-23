import { describe, expect, it } from "vitest";
import { historyError, snapshotError } from "./install-errors";
import { rawRetentionMessage } from "./retention";

describe("snapshot errors", () => {
  it("explains a time outside retention without offering Retry", () => {
    const error = snapshotError(new Error("snapshot outside retention"));
    expect(error.title).toBe("This time is outside the 180-day retention");
    expect(error.detail).toBe(
      "Saved inventory and events cover the last 180 days. Choose a time within them, or return to live."
    );
    expect(error.retryable).toBe(false);
    expect(error.chooseTime).toBe(true);
  });

  it("explains an unreadable link time", () => {
    const error = snapshotError(new Error("invalid timestamp"));
    expect(error.title).toBe("This link's time could not be read");
    expect(error.detail).toBe(
      "Choose a saved observation time instead, or return to live."
    );
    expect(error.retryable).toBe(false);
    expect(error.chooseTime).toBe(true);
  });

  it("offers another time only where another time can succeed", () => {
    for (const message of [
      "snapshot outside retention",
      "invalid timestamp",
      "historical inventory precision boundary too broad",
      "query too broad; select an entity and metric",
    ]) {
      const error = snapshotError(new Error(message));
      expect(error.chooseTime).toBe(true);
      // The banner's own button follows; nothing points "above".
      expect(error.detail).not.toContain("above");
      expect(error.detail.endsWith("or return to live.")).toBe(true);
    }
    for (const message of [
      "snapshot too broad",
      "archive restore in progress; retry",
      "authentication required",
      "Failed to fetch",
    ]) {
      expect(snapshotError(new Error(message)).chooseTime).toBeUndefined();
    }
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
    expect(error.detail).toBe("Choose another time, or return to live.");
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

  it("never offers a shorter range for a Diagnostic period read on its own", () => {
    for (const frozen of [true, false]) {
      const error = historyError(
        new Error(
          "query too broad; more archived samples in this window than one read parses"
        ),
        frozen,
        "1",
        { period: true }
      );
      expect(error.title).toBe(
        "This Diagnostic period holds too many samples to load"
      );
      expect(error.detail).toContain(
        "more samples than the hub reads in one request"
      );
      expect(error.detail).not.toContain("shorter range");
      expect(error.retryable).toBe(false);
    }
    // Other failures read as they do for the range.
    expect(
      historyError(new Error("Failed to fetch"), false, "1", { period: true })
    ).toEqual(historyError(new Error("Failed to fetch"), false, "1"));
  });

  it("asks for a shorter range only when one exists", () => {
    for (const message of [
      "query too broad; choose a shorter range",
      "query too broad; more archived samples in this window than one read parses",
    ]) {
      for (const frozen of [true, false]) {
        for (const range of ["6", "24"]) {
          const error = historyError(new Error(message), frozen, range);
          expect(error.detail).toBe("Choose a shorter range.");
          expect(error.retryable).toBe(false);
        }
        // One hour is the shortest range: no shorter one to choose.
        const shortest = historyError(new Error(message), frozen, "1");
        expect(shortest.title).toBe(
          "This window holds too many samples to load"
        );
        expect(shortest.detail).not.toContain("shorter range");
        expect(shortest.detail).toContain(
          "more samples than the hub reads in one request"
        );
        expect(shortest.retryable).toBe(false);
      }
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

  it("leaves the time picker to the page's banner", () => {
    for (const message of ["invalid timestamp", "snapshot outside retention"]) {
      const error = historyError(new Error(message), true);
      expect(error.retryable).toBe(false);
      expect(error).not.toHaveProperty("chooseTime");
    }
  });
});
