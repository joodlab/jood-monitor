import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { History } from "lucide-react";

const rangeLabels: Record<string, string> = {
  "1": "Last hour",
  "6": "Last 6 hours",
  "24": "Last day",
};

// History window for events and charts, shown on the pages it affects.
export function RangeSelect({
  range,
  onRange,
}: {
  range: string;
  onRange: (range: string) => void;
}) {
  return (
    <Select onValueChange={(value) => onRange(value ?? "1")} value={range}>
      <SelectTrigger
        aria-label="History range for events and charts"
        className="h-8 w-auto gap-1.5 text-sm"
      >
        <History className="size-3.5 text-muted-foreground" />
        <SelectValue>{rangeLabels[range]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(rangeLabels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
