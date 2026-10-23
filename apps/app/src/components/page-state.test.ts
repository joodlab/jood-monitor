import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageState, retrySnapshot } from "./page-state";

// Server-rendered markup of the dashboard's snapshot problem banner for
// errors the hub can return.

function render(error: unknown, data?: unknown, chooser = true) {
  return renderToStaticMarkup(
    createElement(PageState, {
      loading: false,
      onRetry: () => undefined,
      onChooseTime: chooser ? () => undefined : undefined,
      snapshot: { isError: true, error, data },
    })
  );
}

const chooseAnother = "Choose another time…</button>";

describe("snapshot problem banner", () => {
  it("offers another time instead of Retry where a repeat fails the same way", () => {
    for (const message of [
      "snapshot outside retention",
      "invalid timestamp",
      "historical inventory precision boundary too broad",
      "query too broad; select an entity and metric",
    ]) {
      const html = render(new Error(message));
      expect(html).toContain('role="alert"');
      expect(html).not.toContain("Retry</button>");
      expect(html).toContain(chooseAnother);
      expect(html).toContain("or return to live.");
      // Without a picker to open, the banner offers no button at all.
      expect(render(new Error(message), undefined, false)).not.toContain(
        "</button>"
      );
    }
  });

  it("offers no other time where the time is not the problem", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      new Error("snapshot too broad"),
      new Error("authentication required"),
    ]) {
      expect(render(error)).not.toContain(chooseAnother);
    }
  });

  it("offers Retry where a repeat can succeed", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      new Error("archive restore in progress; retry"),
    ]) {
      expect(render(error)).toContain("Retry</button>");
    }
  });

  it("speaks of observations below only when some are shown", () => {
    const below = "Observations below may be out of date.";
    expect(render(new TypeError("Failed to fetch"))).not.toContain(below);
    expect(
      render(new TypeError("Failed to fetch"), { clusters: [] })
    ).toContain(below);
  });

  it("retries once, and never a request that fails the same way", () => {
    const network = new TypeError("Failed to fetch");
    expect(retrySnapshot(0, network)).toBe(true);
    expect(retrySnapshot(1, network)).toBe(false);
    expect(retrySnapshot(0, new Error("snapshot outside retention"))).toBe(
      false
    );
  });

  it("shows nothing while the snapshot is fine", () => {
    const html = renderToStaticMarkup(
      createElement(PageState, {
        loading: false,
        onRetry: () => undefined,
        snapshot: { isError: false, error: null },
      })
    );
    expect(html).toBe("");
  });
});
