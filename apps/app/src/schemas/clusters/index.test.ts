import { describe, expect, it } from "vitest";
import { historyCommandSchema, seriesHistorySchema } from ".";

const valid = {
  workspace: "synthetic-demo",
  cluster: "synthetic-cluster",
  from: "2026-10-22T11:00:00Z",
  entities: ["synthetic-cluster-node-a"],
  names: ["system.cpu.time", "system.memory.usage"],
};

describe("series history request", () => {
  it("accepts a scoped read of known series", () => {
    expect(seriesHistorySchema.parse(valid)).toEqual(valid);
    expect(
      seriesHistorySchema.safeParse({
        ...valid,
        workspace: "global",
        to: "2026-10-22T12:00:00Z",
      }).success
    ).toBe(true);
  });

  it("rejects more than 20 entities and duplicate entities", () => {
    const many = Array.from({ length: 21 }, (_, index) => `node-${index}`);
    expect(
      seriesHistorySchema.safeParse({ ...valid, entities: many }).success
    ).toBe(false);
    expect(
      seriesHistorySchema.safeParse({ ...valid, entities: many.slice(0, 20) })
        .success
    ).toBe(true);
    expect(
      seriesHistorySchema.safeParse({ ...valid, entities: ["a", "a"] }).success
    ).toBe(false);
    expect(
      seriesHistorySchema.safeParse({ ...valid, entities: [] }).success
    ).toBe(false);
  });

  it("rejects unknown names, including system.network.errors", () => {
    for (const name of [
      "system.network.errors",
      "container.cpu.usage",
      "k8s.pod.cpu",
    ]) {
      expect(
        seriesHistorySchema.safeParse({ ...valid, names: [name] }).success
      ).toBe(false);
    }
  });

  it("rejects more than 9 names and duplicate names", () => {
    const names = [
      "system.cpu.time",
      "system.memory.usage",
      "system.memory.limit",
      "system.network.io",
      "system.disk.io",
      "system.filesystem.usage",
      "system.filesystem.inodes.usage",
      "k8s.node.cpu.usage",
      "k8s.node.memory.usage",
      "k8s.pod.cpu.usage",
    ];
    expect(seriesHistorySchema.safeParse({ ...valid, names }).success).toBe(
      false
    );
    expect(
      seriesHistorySchema.safeParse({ ...valid, names: names.slice(0, 9) })
        .success
    ).toBe(true);
    expect(
      seriesHistorySchema.safeParse({
        ...valid,
        names: ["system.cpu.time", "system.cpu.time"],
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      seriesHistorySchema.safeParse({ ...valid, resolution: "5m" }).success
    ).toBe(false);
    expect(
      seriesHistorySchema.safeParse({ ...valid, entity: "node" }).success
    ).toBe(false);
  });
});

describe("Durable Object history command", () => {
  it("accepts the singular fields an earlier Worker sends and bounded sets", () => {
    const window = {
      from: "2026-10-22T11:00:00.000000000Z",
      to: "2026-10-22T12:00:00.000000000Z",
    };
    expect(
      historyCommandSchema.safeParse({
        ...window,
        entity: undefined,
        name: "k8s.node.cpu.usage",
      }).success
    ).toBe(true);
    expect(
      historyCommandSchema.safeParse({
        ...window,
        entities: Array.from({ length: 21 }, (_, index) => `node-${index}`),
      }).success
    ).toBe(false);
    expect(
      historyCommandSchema.safeParse({ ...window, extra: true }).success
    ).toBe(false);
  });
});
