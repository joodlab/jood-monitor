import type { Metric } from "@jood-monitor/api-client";
import { defineChart, dot, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
export function ResourceChart({
  samples,
  name,
  unit,
  valueScale = 1,
}: {
  samples: Metric[];
  name: string;
  unit: string;
  valueScale?: number;
}) {
  const definition = useMemo(() => {
    const rows = samples
      .filter((m) => m.name === name)
      .map((m) => ({
        time: Date.parse(m.sourceTime),
        value: Number(m.value) * valueScale,
      }))
      .sort((a, b) => a.time - b.time);
    const segments: { time: number; value: number; segment: string }[] = [];
    let segment = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].time - rows[i - 1].time > 90_000) {
        segment++;
      }
      segments.push({ ...rows[i], segment: String(segment) });
    }
    return defineChart({
      marks: [
        lineY(segments, {
          x: "time",
          y: "value",
          z: "segment",
          stroke: "var(--primary)",
        }),
        dot(segments, { x: "time", y: "value", fill: "var(--primary)", r: 2 }),
      ],
      scales: {
        x: {
          scale: scaleLinear,
          axis: {
            ticks: {
              format: (v) =>
                new Date(v).toLocaleTimeString("en", {
                  timeZone: "Asia/Riyadh",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
            },
          },
        },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { label: unit },
        },
      },
      tooltip,
    });
  }, [samples, name, unit, valueScale]);
  if (!samples.some((sample) => sample.name === name)) {
    return (
      <div className="flex h-52 items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
        No observations in this interval
      </div>
    );
  }
  return (
    <Chart
      ariaLabel={`${name} history in ${unit}; gaps remain disconnected`}
      definition={definition}
      height={240}
    />
  );
}
