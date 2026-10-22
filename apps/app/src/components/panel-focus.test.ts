import { describe, expect, it } from "vitest";
import { closingFocus, escapeConsumed, focusedOutside } from "./panel-focus";

// Synthetic stand-ins for DOM elements: a card on the canvas, the canvas
// search field, a control inside the panel, and the body.
interface Fake {
  isConnected: boolean;
  name: string;
}
const fake = (name: string, isConnected = true): Fake => ({
  name,
  isConnected,
});
const body = fake("body");
const card = fake("Service checkout card");
const otherCard = fake("Ingress checkout-public card");
const search = fake("Search the canvas");
const closeButton = fake("Close panel");
const panel = { contains: (node: Fake) => node === closeButton };

describe("Escape another control already handled", () => {
  it("leaves the panel open when the Escape was consumed", () => {
    // The canvas search clears its text and calls preventDefault.
    expect(escapeConsumed("escape-key", { defaultPrevented: true })).toBe(true);
  });
  it("closes the panel on an unhandled Escape", () => {
    // An empty search does not consume Escape, so the panel closes.
    expect(escapeConsumed("escape-key", { defaultPrevented: false })).toBe(
      false
    );
  });
  it("does not affect other ways of closing", () => {
    expect(escapeConsumed("close-press", { defaultPrevented: true })).toBe(
      false
    );
    expect(escapeConsumed("outside-press", { defaultPrevented: true })).toBe(
      false
    );
  });
});

describe("panel focus", () => {
  it("records the card that opened or switched the panel", () => {
    expect(focusedOutside(card, body, panel)).toBe(card);
    expect(focusedOutside(closeButton, body, panel)).toBeNull();
    expect(focusedOutside(body, body, panel)).toBeNull();
    expect(focusedOutside(null, body, panel)).toBeNull();
    // Before the panel mounts there is no popup to contain focus.
    expect(focusedOutside(otherCard, body, null)).toBe(otherCard);
  });
  it("returns focus to the latest invoker from inside the panel", () => {
    // Card A opened the panel, card B switched it: Escape returns to B.
    expect(closingFocus(closeButton, body, panel, card)).toBe(card);
  });
  it("returns focus to the invoker when focus was dropped to the body", () => {
    expect(closingFocus(body, body, panel, card)).toBe(card);
    expect(closingFocus(null, body, panel, card)).toBe(card);
  });
  it("keeps focus the operator moved elsewhere", () => {
    expect(closingFocus(search, body, panel, card)).toBe(false);
    expect(closingFocus(otherCard, body, panel, card)).toBe(false);
  });
  it("falls back to the default when the invoker is gone", () => {
    expect(closingFocus(closeButton, body, panel, fake("removed", false))).toBe(
      true
    );
    expect(closingFocus(closeButton, body, panel, null)).toBe(true);
  });
});
