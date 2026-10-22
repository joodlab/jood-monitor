import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { WorkspacesPage, type WorkspacesPageProps } from "./workspaces-page";

// Server-rendered markup of the workspace grid. Synthetic workspaces only.

function render(props: Partial<WorkspacesPageProps>) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(WorkspacesPage, {
        onNewWorkspace: () => undefined,
        onOpen: () => undefined,
        scope: "global",
        views: [],
        workspaces: [],
        ...props,
      })
    )
  );
}

describe("Workspaces page", () => {
  it("never shows a failed list as zero workspaces", () => {
    const html = render({ error: true, onRetry: () => undefined });
    expect(html).toContain("Workspace list unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("0 workspaces");
    expect(html).not.toContain("Create a workspace to group clusters");
    expect(html).toContain("Every cluster in every workspace");
  });
  it("does not infer that every workspace is loaded without the list", () => {
    const html = render({ error: true, scope: "ws-a" });
    expect(html).toContain("Not in the loaded view");
    expect(html).not.toContain("Retry");
  });
  it("invites creating a workspace only when the list is known to be empty", () => {
    const html = render({});
    expect(html).toContain("0 workspaces");
    expect(html).toContain("Create a workspace to group clusters");
    expect(html).not.toContain('role="alert"');
  });
  it("shows nothing as counted while loading", () => {
    const html = render({ loading: true, error: true });
    expect(html).toContain("Loading workspaces");
    expect(html).not.toContain("0 workspaces");
    expect(html).not.toContain("Create a workspace to group clusters");
  });
  it("lists known workspaces with their count", () => {
    const html = render({
      workspaces: [
        { id: "ws-a", name: "Synthetic A" },
        { id: "ws-b", name: "Synthetic B" },
      ],
    });
    expect(html).toContain("2 workspaces");
    expect(html).toContain("Synthetic A");
    expect(html).not.toContain("Create a workspace to group clusters");
  });
});
