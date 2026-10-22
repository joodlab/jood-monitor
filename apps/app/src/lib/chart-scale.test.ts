import { describe, expect, it } from "vitest";
import {
  displayUnit,
  formatInUnit,
  formatUsage,
  historySamples,
  isolatedSamples,
  needsDate,
  percentOf,
  references,
  sampleStats,
  tickLabel,
  timeTicks,
  tooltipContent,
  valueAxis,
  valueDomainTop,
  withGaps,
} from "./chart-scale";

const roundHour = /:00$/;
const t0 = Date.parse("2026-10-22T12:00:00Z");
const metric = (offset: number, value: string, name = "k8s.pod.cpu.usage") => ({
  name,
  sourceTime: new Date(t0 + offset).toISOString(),
  value,
});

describe("history samples", () => {
  it("keeps only the named, finite series in source-time order", () => {
    const samples = historySamples(
      [
        metric(30_000, "0.2"),
        metric(0, "0.1"),
        metric(15_000, "NaN"),
        metric(10_000, "5", "k8s.pod.memory.usage"),
      ],
      "k8s.pod.cpu.usage"
    );
    expect(samples).toEqual([
      { time: t0, value: 0.1 },
      { time: t0 + 30_000, value: 0.2 },
    ]);
  });

  it("breaks lines at gaps instead of filling them with zero", () => {
    const samples = [
      { time: t0, value: 1 },
      { time: t0 + 30_000, value: 2 },
      { time: t0 + 300_000, value: 3 },
    ];
    const rows = withGaps(samples);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({ time: t0 + 165_000, value: null });
    expect(rows.some((row) => row.value === 0)).toBe(false);
    expect(isolatedSamples(samples)).toEqual([samples[2]]);
  });

  it("summarizes latest, range, count and gaps", () => {
    const stats = sampleStats([
      { time: t0, value: 4 },
      { time: t0 + 30_000, value: 1 },
      { time: t0 + 200_000, value: 2 },
    ]);
    expect(stats).toEqual({
      count: 3,
      gaps: 1,
      latest: { time: t0 + 200_000, value: 2 },
      min: 1,
      max: 4,
    });
    expect(sampleStats([])).toEqual({
      count: 0,
      gaps: 0,
      latest: undefined,
      min: undefined,
      max: undefined,
    });
  });
});

describe("display units", () => {
  it("chooses millicores below one core and MiB below one GiB", () => {
    expect(displayUnit("cpu", 0.25).label).toBe("millicores");
    expect(displayUnit("cpu", 1.5).label).toBe("cores");
    expect(displayUnit("memory", 512 * 1024 ** 2).label).toBe("MiB");
    expect(displayUnit("memory", 3 * 1024 ** 3).label).toBe("GiB");
  });

  it("formats with at most three significant digits", () => {
    expect(formatUsage("cpu", 0.012_34)).toBe("12.3m");
    expect(formatUsage("cpu", 0.25)).toBe("250m");
    expect(formatUsage("cpu", 1)).toBe("1 core");
    expect(formatUsage("cpu", 2.3456)).toBe("2.35 cores");
    expect(formatUsage("memory", 300 * 1024 ** 2)).toBe("300 MiB");
    expect(formatUsage("memory", 1.5 * 1024 ** 3)).toBe("1.5 GiB");
    expect(formatInUnit(undefined, displayUnit("cpu", 1))).toBe("no sample");
  });

  it("states percentages only against a known positive reference", () => {
    expect(percentOf(0.25, 1)).toBe("25%");
    expect(percentOf(0.25, undefined)).toBeUndefined();
    expect(percentOf(0.25, 0)).toBeUndefined();
  });

  it("drops missing or zero references and keeps them in the domain", () => {
    const refs = references([
      { label: "request", dash: "2 3", value: 0 },
      { label: "limit", dash: "6 3", value: 2 },
      { label: "other", dash: "1 1", value: null },
    ]);
    expect(refs.map((ref) => ref.label)).toEqual(["limit"]);
    expect(valueDomainTop(0.5, refs)).toBe(2);
    expect(valueDomainTop(undefined, [])).toBe(0);
  });
});

describe("value axis", () => {
  it("starts at zero with round ticks just above the highest value", () => {
    expect(valueAxis(1000)).toEqual({
      top: 1250,
      ticks: [0, 250, 500, 750, 1000, 1250],
    });
    expect(valueAxis(7.8).ticks).toEqual([0, 2, 4, 6, 8]);
    expect(valueAxis(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(valueAxis(0)).toEqual({ top: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  });
});

describe("time axis", () => {
  it("places ticks on round wall-clock times in the display zone", () => {
    const from = Date.parse("2026-10-22T11:07:00Z");
    const to = from + 3_600_000;
    const utc = timeTicks(from, to, "UTC");
    expect(utc[0]).toBe(Date.parse("2026-10-22T11:10:00Z"));
    expect(utc.length).toBeLessThanOrEqual(7);
    // India is UTC+05:30, so its round hours fall on UTC half hours.
    const kolkata = timeTicks(from, from + 6 * 3_600_000, "Asia/Kolkata");
    expect(tickLabel(kolkata[0], "Asia/Kolkata", false)).toMatch(roundHour);
    expect(new Date(kolkata[0]).getUTCMinutes()).toBe(30);
    expect(timeTicks(to, from, "UTC")).toEqual([]);
  });

  it("adds dates for a day-long range or one crossing midnight", () => {
    const evening = Date.parse("2026-10-22T20:00:00Z");
    expect(needsDate(evening - 3_600_000, evening, "UTC")).toBe(false);
    expect(needsDate(evening, evening + 6 * 3_600_000, "UTC")).toBe(true);
    expect(needsDate(evening - 86_400_000, evening, "UTC")).toBe(true);
    // 20:30–21:30 UTC stays on one UTC day but crosses midnight in Riyadh.
    const late = evening + 1_800_000;
    expect(needsDate(late, late + 3_600_000, "UTC")).toBe(false);
    expect(needsDate(late, late + 3_600_000, "Asia/Riyadh")).toBe(true);
    expect(tickLabel(evening, "UTC", false)).toBe("20:00");
    expect(tickLabel(evening, "UTC", true)).toBe("Oct 22 20:00");
  });
});

describe("tooltip", () => {
  it("shows source time in the display zone and the value with its unit", () => {
    const unit = displayUnit("cpu", 0.5);
    const content = tooltipContent(
      { time: Date.parse("2026-10-22T12:00:05Z"), value: 250 },
      {
        unit,
        timeZone: "Asia/Riyadh",
        title: "CPU used",
        percentBase: { label: "limit", dash: "6 3", value: 1 },
      }
    );
    expect(content.title).toBe("Source time Oct 22, 15:00:05 GMT+3");
    expect(content.rows).toEqual([
      { label: "CPU used", value: "250m" },
      { label: "Of limit", value: "25%" },
    ]);
    expect(
      tooltipContent(
        { time: 0, value: null },
        { unit, timeZone: "UTC", title: "CPU used" }
      )
    ).toEqual({ rows: [] });
  });
});
