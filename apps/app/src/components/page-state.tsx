import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { snapshotError } from "../lib/install-errors";

// One automatic retry, and none where the request fails the same way every
// time (a time outside retention, a signed-out session).
export function retrySnapshot(failures: number, error: unknown) {
  return failures < 1 && snapshotError(error).retryable;
}

// Why the dashboard's observations are missing or may be out of date, and
// the skeleton while the first snapshot loads.
export function PageState({
  snapshot,
  loading,
  onRetry,
  onChooseTime,
}: {
  snapshot: { isError: boolean; error: unknown; data?: unknown };
  loading: boolean;
  onRetry: () => void;
  // Opens the saved-observation picker for errors another time can fix.
  onChooseTime?: () => void;
}) {
  // Retry only where repeating the request can succeed. A time outside
  // retention or an unreadable link offers another time instead, beside the
  // project bar's Return to live.
  const problem = snapshot.isError ? snapshotError(snapshot.error) : undefined;
  return (
    <>
      {problem && (
        <div
          className="m-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm"
          role="alert"
        >
          <span className="min-w-0 flex-1">
            <span className="font-medium">{problem.title}.</span>
            {problem.detail && ` ${problem.detail}`}
            {/* Earlier observations stay on screen only when one loaded. */}
            {snapshot.data != null && " Observations below may be out of date."}
          </span>
          {problem.retryable && (
            <Button onClick={onRetry} size="sm" variant="outline">
              Retry
            </Button>
          )}
          {problem.chooseTime && onChooseTime && (
            <Button
              className="h-9 sm:h-8"
              onClick={onChooseTime}
              size="sm"
              variant="outline"
            >
              Choose another time…
            </Button>
          )}
        </div>
      )}
      {loading && !snapshot.isError && (
        <div aria-busy="true" className="space-y-4 p-4">
          <span className="sr-only" role="status">
            Loading observations…
          </span>
          <Skeleton className="h-28" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[1, 2, 3, 4].map((item) => (
              <Skeleton className="h-24" key={item} />
            ))}
          </div>
          <Skeleton className="h-40" />
        </div>
      )}
    </>
  );
}
