import { describe, expect, it } from "vitest";
import { dockedInspectorWidth, dockedQuery } from "./panel-shell";

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
