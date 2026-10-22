import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@jood-monitor/ui/select";
import { History } from "lucide-react";
import { useDisplay } from "../hooks/display";
import { rangeLabel } from "../lib/time";

const ranges = ["1", "6", "24"];

// History window for events and charts, shown on the pages it affects. A
// frozen view's window ends at the saved observation, and the labels say so.
export function RangeSelect({
  range,
  onRange,
}: {
  range: string;
  onRange: (range: string) => void;
}) {
  const { at, timeZone } = useDisplay();
  return (
    <Select onValueChange={(value) => onRange(value ?? "1")} value={range}>
      <SelectTrigger
        aria-label="History range for events and charts"
        className="h-8 w-auto gap-1.5 text-sm"
      >
        <History className="size-3.5 text-muted-foreground" />
        <SelectValue>{rangeLabel(range, at, timeZone)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ranges.map((value) => (
          <SelectItem key={value} value={value}>
            {rangeLabel(value, at, timeZone)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
