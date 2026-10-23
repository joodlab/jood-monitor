import { describe, expect, it } from "vitest";
import { switchFocus } from "./panel-focus";
import { dockedInspectorWidth, dockedQuery } from "./panel-shell";

// The panel's focus rule when it opens or shows another resource. Synthetic
// stand-ins for DOM elements: a card outside the panel, a Back button
// inside it, and the body.
describe("resource switch focus", () => {
  const body = { name: "body" };
  const card = { name: "Deployment checkout card" };
  const back = { name: "Back to Deployment checkout" };
  const panel = { contains: (node: { name: string }) => node === back };

  it("keeps focus on the card or row that switched the panel", () => {
    expect(switchFocus(true, card, body, panel)).toBe("invoker");
    expect(switchFocus(false, card, body, panel)).toBe("invoker");
  });
  it("moves focus to the title when a switch starts inside the panel", () => {
    // Back, a member pod or the browser's Back while focus is in the panel.
    expect(switchFocus(true, back, body, panel)).toBe("title");
  });
  it("moves focus to the title when the switch dropped it to the body", () => {
    // The focused pod button unmounted with the previous resource.
    expect(switchFocus(true, body, body, panel)).toBe("title");
    expect(switchFocus(true, null, body, panel)).toBe("title");
  });
  it("leaves a first open to the panel itself", () => {
    expect(switchFocus(false, body, body, panel)).toBe("open");
    expect(switchFocus(false, null, body, null)).toBe("open");
  });
  it("leaves focus to the finder when a choice there switched the panel", () => {
    // The finder's input, which closes and returns focus itself; it never
    // becomes the element Escape returns to.
    const finderInput = { name: "Find a page, resource or action" };
    expect(switchFocus(true, finderInput, body, panel, true)).toBe("dialog");
    expect(switchFocus(false, finderInput, body, null, true)).toBe("dialog");
    // Focus in the panel still moves to the title.
    expect(switchFocus(true, back, body, panel, false)).toBe("title");
  });
});

// The docked service panel's width, which the canvas keeps its cards clear
// of: 60vw between 560 and 1000 px.
describe("docked service panel width", () => {
  it("docks from 768 px", () => {
    expect(dockedQuery).toBe("(min-width: 768px)");
  });
  it("keeps its 560 px minimum at the dock breakpoint", () => {
    expect(dockedInspectorWidth(768)).toBe(560);
  });
  it("takes 60% of a mid-size viewport", () => {
    expect(dockedInspectorWidth(1200)).toBe(720);
  });
  it("stops at 1000 px on wide screens", () => {
    expect(dockedInspectorWidth(2000)).toBe(1000);
  });
});
