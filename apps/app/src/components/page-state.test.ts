import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageState } from "./page-state";

// Server-rendered markup of the dashboard's snapshot problem banner for
// errors the hub can return.

function render(error: unknown, data?: unknown) {
  return renderToStaticMarkup(
    createElement(PageState, {
      loading: false,
      onRetry: () => undefined,
      snapshot: { isError: true, error, data },
    })
  );
}

describe("snapshot problem banner", () => {
  it("hides Retry where a repeat fails the same way", () => {
    for (const message of [
      "snapshot outside retention",
      "invalid timestamp",
      "query too broad; select an entity and metric",
    ]) {
      const html = render(new Error(message));
      expect(html).toContain('role="alert"');
      expect(html).not.toContain("Retry</button>");
      expect(html).toContain("Return to live");
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
