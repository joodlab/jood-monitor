import { createChartScene, viewportInteractionPoints } from "@tanstack/charts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chartDefinition, MetricChart } from "../components/resource-chart";
import { DisplayProvider } from "../hooks/display";
import {
  chartAria,
  countText,
  displayUnit,
  displayUnitFor,
  formatInUnit,
  formatUsage,
  historySamples,
  intervalText,
  isolatedRows,
  isolatedSamples,
  needsDate,
  percentOf,
  references,
  rowStats,
  sampleStats,
  tickLabel,
  timeTicks,
  tooltipContent,
  valueAxis,
  valueDomainTop,
  withGaps,
} from "./chart-scale";

const roundHour = /:00$/;
const plotLabel = /<text[^>]*>[^<]*Diagnostic/;
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

describe("unit families", () => {
  it("map cores and bytes onto the existing display units", () => {
    expect(displayUnitFor("cores", 0.25)).toBe(displayUnit("cpu", 0.25));
    expect(displayUnitFor("cores", 6)).toBe(displayUnit("cpu", 6));
    expect(displayUnitFor("bytes", 512 * 1024 ** 2)).toBe(
      displayUnit("memory", 512 * 1024 ** 2)
    );
    expect(displayUnitFor("bytes", 30 * 1024 ** 3).label).toBe("GiB");
    expect(displayUnitFor("cores", undefined).label).toBe("millicores");
  });
});

describe("chart rows", () => {
  const samples = [
    { time: t0, value: 4 },
    { time: t0 + 30_000, value: 1 },
    { time: t0 + 200_000, value: 2 },
    { time: t0 + 500_000, value: 3 },
  ];

  it("summarize like samples, one break per null row", () => {
    expect(rowStats(withGaps(samples))).toEqual(sampleStats(samples));
    expect(rowStats([])).toEqual(sampleStats([]));
  });

  it("dot exactly the samples with no neighbour inside the gap window", () => {
    expect(isolatedRows(withGaps(samples))).toEqual(isolatedSamples(samples));
    expect(
      isolatedRows([
        { time: t0, value: null },
        { time: t0 + 1, value: 5 },
        { time: t0 + 2, value: null },
      ])
    ).toEqual([{ time: t0 + 1, value: 5 }]);
  });

  it("labels a multi-series tooltip by series and adds same-time readings", () => {
    const unit = displayUnit("cpu", 2);
    const content = tooltipContent(
      {
        time: Date.parse("2026-10-22T12:00:05Z"),
        value: 1.5,
        label: "Busy",
        detail: [{ label: "idle", value: "6.5 cores" }],
      },
      { unit, timeZone: "UTC", title: "Host CPU busy" }
    );
    expect(content.rows).toEqual([
      { label: "Busy", value: "1.5 cores" },
      { label: "idle", value: "6.5 cores" },
    ]);
  });
});

// The strings the Pod and Node charts have always announced, written out in
// full so a change to the shared builder cannot pass unnoticed.
describe("chart accessible strings", () => {
  const from = Date.parse("2026-10-22T11:00:00Z");
  const to = Date.parse("2026-10-22T12:00:00Z");
  const samples = historySamples(
    [
      metric(-3_600_000 + 60_000, "0.25"),
      metric(-3_600_000 + 90_000, "0.5"),
      metric(-1_800_000, "0.125"),
    ],
    "k8s.pod.cpu.usage"
  );
  const stats = sampleStats(samples);
  const unit = displayUnit("cpu", stats.max);

  it("keeps the interval, name and description byte for byte", () => {
    const interval = intervalText(from, to, "UTC");
    expect(interval).toBe("Oct 22, 11:00:00 to Oct 22, 12:00:00 UTC");
    expect(
      chartAria({
        title: "CPU used",
        subject: "Pod checkout-b4n8s",
        unit,
        stats: rowStats(withGaps(samples)),
        interval,
      })
    ).toEqual({
      label: "CPU used for Pod checkout-b4n8s, in millicores",
      description:
        "Latest 125m, minimum 125m, maximum 500m, 3 samples. Interval Oct 22, 11:00:00 to Oct 22, 12:00:00 UTC. Gaps longer than 90 seconds are left blank.",
    });
  });

  it("appends Diagnostic periods after the fixed sentences", () => {
    expect(
      chartAria({
        title: "Host CPU busy",
        subject: "Node synthetic-node-a",
        unit,
        stats,
        interval: intervalText(from, to, "UTC"),
        extra: [
          "Diagnostic · samples every 5 s, Oct 22, 11:10:00 to Oct 22, 11:19:00 UTC.",
        ],
      }).description
    ).toBe(
      "Latest 125m, minimum 125m, maximum 500m, 3 samples. Interval Oct 22, 11:00:00 to Oct 22, 12:00:00 UTC. Gaps longer than 90 seconds are left blank. Diagnostic · samples every 5 s, Oct 22, 11:10:00 to Oct 22, 11:19:00 UTC."
    );
  });
});

describe("chart counts and zoom", () => {
  const from = Date.parse("2026-10-22T11:00:00Z");
  const to = Date.parse("2026-10-22T12:00:00Z");
  const samples = historySamples(
    [
      metric(-3_600_000 + 60_000, "0.25"),
      metric(-3_600_000 + 90_000, "0.5"),
      metric(-1_800_000, "0.125"),
    ],
    "k8s.pod.cpu.usage"
  );
  const stats = sampleStats(samples);
  const unit = displayUnit("cpu", stats.max);
  const rate = { one: "rate", other: "rates" };

  it("names what the rows count, one or many", () => {
    expect(countText(1)).toBe("1 sample");
    expect(countText(3)).toBe("3 samples");
    expect(countText(1, rate)).toBe("1 rate");
    expect(countText(59, rate)).toBe("59 rates");
  });

  it("counts rates, not samples, for a rate chart", () => {
    const { description } = chartAria({
      title: "Host CPU busy",
      subject: "Node synthetic-node-a",
      unit,
      stats,
      interval: intervalText(from, to, "UTC"),
      count: rate,
    });
    expect(description).toContain("maximum 500m, 3 rates.");
    expect(description).not.toContain("samples.");
  });

  it("says the axis is zoomed and the summary is the full interval", () => {
    const zoom = intervalText(
      Date.parse("2026-10-22T11:10:00Z"),
      Date.parse("2026-10-22T11:20:00Z"),
      "UTC"
    );
    expect(
      chartAria({
        title: "Host CPU busy",
        subject: "Node synthetic-node-a",
        unit,
        stats,
        interval: intervalText(from, to, "UTC"),
        zoom,
        extra: [
          "Diagnostic · samples every 5 s, Oct 22, 11:10:00 to Oct 22, 11:19:00 UTC.",
        ],
      }).description
    ).toBe(
      "Latest 125m, minimum 125m, maximum 500m, 3 samples. Interval Oct 22, 11:00:00 to Oct 22, 12:00:00 UTC. Gaps longer than 90 seconds are left blank. Time axis zoomed to Oct 22, 11:10:00 to Oct 22, 11:20:00 UTC; the summary covers the full interval. Diagnostic · samples every 5 s, Oct 22, 11:10:00 to Oct 22, 11:19:00 UTC."
    );
  });
});

// Synthetic node and values only.
describe("metric chart", () => {
  const from = Date.parse("2026-10-22T11:00:00Z");
  const to = Date.parse("2026-10-22T12:00:00Z");
  // One busy rate a minute, 0.5 cores.
  const rows = Array.from({ length: 61 }, (_, index) => ({
    time: from + index * 60_000,
    value: 0.5,
  }));
  const series = [{ id: "busy", label: "Busy", rows }];
  const label = "Diagnostic · samples every 5 s";
  const spans = [
    { start: from + 20 * 60_000, end: from + 25 * 60_000, label },
    { start: from + 26 * 60_000, end: from + 29 * 60_000, label },
  ];
  const zoom: [number, number] = [from + 19 * 60_000, from + 30 * 60_000];

  function render(domain?: [number, number]) {
    return renderToStaticMarkup(
      createElement(
        DisplayProvider,
        null,
        createElement(MetricChart, {
          title: "Host CPU busy",
          subject: "Node synthetic-node-a",
          family: "cores",
          from,
          to,
          series,
          spans,
          domain,
          countLabel: { one: "rate", other: "rates" },
        })
      )
    );
  }

  it("counts rates in the visible summary", () => {
    const html = render();
    expect(html).toContain("61 rates");
    expect(html).not.toContain("61 samples");
  });

  it("names Diagnostic periods once in the legend, not in the plot", () => {
    const html = render();
    const caption = html.slice(
      html.indexOf("<figcaption"),
      html.indexOf("</figcaption>")
    );
    expect(caption.split(label).length - 1).toBe(1);
    expect(html).not.toMatch(plotLabel);
  });

  it("notes a zoomed axis beside the full-range summary", () => {
    expect(render()).not.toContain("summary covers the full range");
    const html = render(zoom);
    expect(html).toContain(
      "summary covers the full range, not only the zoomed axis"
    );
    expect(html).toContain("61 rates");
  });

  it("keeps focus on the samples inside a zoomed axis", () => {
    const definition = (view?: readonly [number, number]) =>
      chartDefinition({
        series,
        unit: displayUnit("cpu", 0.5),
        from,
        to,
        view,
        timeZone: "UTC",
        title: "Host CPU busy",
        references: [],
        spans: [],
        top: 0.5,
      });
    const size = { width: 640, height: 200 };
    const full = createChartScene(definition(), size);
    expect(viewportInteractionPoints(full)).toHaveLength(full.points.length);
    const zoomed = createChartScene(definition(zoom), size);
    const times = viewportInteractionPoints(zoomed).map(
      (point) => (point.datum as { time: number }).time
    );
    expect(times.length).toBeGreaterThan(0);
    expect(times.length).toBeLessThan(rows.length);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(zoom[0]);
      expect(time).toBeLessThanOrEqual(zoom[1]);
    }
    // The axis shows the zoomed interval; the content spans the whole read.
    expect(zoomed.scales.x.viewport?.domain).toEqual(zoom);
    expect(zoomed.scales.x.viewport?.contentDomain).toEqual([from, to]);
  });
});
