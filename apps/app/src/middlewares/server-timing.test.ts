import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Timing } from "../lib/server/server-timing";

const { setResponseHeader } = vi.hoisted(() => ({
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start/server", () => ({ setResponseHeader }));

const { serverTimingMiddleware } = await import("./server-timing");

const doThenTotal = /^do;dur=\d+\.\d;desc="[^"]+", total;dur=\d+\.\d;/;
const d1ThenTotal = /^d1;dur=.*, total;dur=/;

type Next = (options: { context: { timing: Timing } }) => Promise<unknown>;
const server = serverTimingMiddleware.options.server as unknown as (options: {
  next: Next;
}) => Promise<unknown>;

describe("serverTimingMiddleware", () => {
  beforeEach(() => {
    setResponseHeader.mockClear();
  });

  it("hands the read a timing and reports its waits", async () => {
    const result = await server({
      next: async ({ context }) =>
        await context.timing.measure("do", () => Promise.resolve("synthetic")),
    });
    expect(result).toBe("synthetic");
    expect(setResponseHeader).toHaveBeenCalledTimes(1);
    const [name, value] = setResponseHeader.mock.calls[0];
    expect(name).toBe("Server-Timing");
    expect(value).toMatch(doThenTotal);
  });

  it("still reports where a failed read waited", async () => {
    await expect(
      server({
        next: async ({ context }) => {
          await context.timing.measure("d1", () => Promise.resolve());
          throw new Error("synthetic failure");
        },
      })
    ).rejects.toThrow("synthetic failure");
    expect(setResponseHeader).toHaveBeenCalledWith(
      "Server-Timing",
      expect.stringMatching(d1ThenTotal)
    );
  });
});
