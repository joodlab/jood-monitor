import { describe, expect, it } from "vitest";
import {
  closingFocus,
  escapeConsumed,
  finderFocus,
  focusedOutside,
} from "./panel-focus";

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

describe("finder focus", () => {
  // The finder's input and the panel's title once it shows the chosen
  // resource.
  const input = fake("Find a page, resource or action");
  const finder = { contains: (node: Fake) => node === input };
  const title = fake("payments-api");

  it("returns focus to the control that opened the finder", () => {
    expect(finderFocus(input, body, finder, card, title)).toBe(card);
    expect(finderFocus(input, body, finder, card, null)).toBe(card);
  });
  it("moves focus to the panel's title when the opener unmounted", () => {
    // The pod row went with the resource the finder switched away from.
    const gone = fake("checkout-5b8d4-a", false);
    expect(finderFocus(input, body, finder, gone, title)).toBe(title);
    // The input itself was removed first, dropping focus to the body.
    expect(finderFocus(body, body, finder, gone, title)).toBe(title);
  });
  it("does not return focus to the body", () => {
    expect(finderFocus(input, body, finder, body, title)).toBe(title);
    expect(finderFocus(input, body, finder, null, title)).toBe(title);
  });
  it("falls back to the main region when neither is there", () => {
    expect(
      finderFocus(
        input,
        body,
        finder,
        fake("gone", false),
        fake("closed", false)
      )
    ).toBe("main");
    expect(finderFocus(input, body, finder, null, null)).toBe("main");
  });
  it("keeps focus that already moved elsewhere", () => {
    // A panel the finder opened focused itself, or the saved-observation
    // picker took focus.
    expect(finderFocus(closeButton, body, finder, card, title)).toBe(false);
    expect(finderFocus(search, body, finder, card, title)).toBe(false);
  });
  it("returns focus when the finder's element is not known", () => {
    expect(finderFocus(input, body, null, card, title)).toBe(card);
  });
});
