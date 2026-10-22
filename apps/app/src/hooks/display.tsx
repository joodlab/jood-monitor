import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  resolveTimeZone,
  type TimeZonePreference,
  timeZoneOptions,
} from "../lib/time";

// Browser-local display preferences and the shared observation clock. The
// clock starts at zero during SSR so server and client markup agree.

export type Theme = "dark" | "light";

interface Display {
  // Saved-observation time, when the dashboard is frozen.
  at?: string;
  frozen: boolean;
  // Wall clock, refreshed every 15 seconds after hydration; zero before.
  now: number;
  // The moment observations are evaluated against: `at` or `now`.
  referenceTime: number;
  setTheme: (theme: Theme) => void;
  setTimeZonePreference: (preference: TimeZonePreference) => void;
  theme: Theme;
  timeZone: string;
  timeZonePreference: TimeZonePreference;
}

const DisplayContext = createContext<Display | null>(null);

function stored<T extends string>(key: string, allowed: readonly T[]) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : undefined;
  } catch {
    return;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Preferences remain usable for this page. */
  }
}

export function DisplayProvider({
  at,
  children,
}: {
  at?: string;
  children: ReactNode;
}) {
  const [now, setNow] = useState(0);
  const [theme, setThemeState] = useState<Theme>("dark");
  const [timeZonePreference, setPreference] =
    useState<TimeZonePreference>("local");
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setThemeState(stored<Theme>("monitor-theme", ["dark", "light"]) ?? "dark");
    setPreference(stored("monitor-time-zone", timeZoneOptions) ?? "local");
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const value = useMemo<Display>(() => {
    const parsed = at ? Date.parse(at) : Number.NaN;
    return {
      at,
      frozen: !!at,
      now,
      referenceTime: Number.isFinite(parsed) ? parsed : now,
      theme,
      setTheme: (next) => {
        setThemeState(next);
        save("monitor-theme", next);
      },
      timeZonePreference,
      timeZone: resolveTimeZone(timeZonePreference),
      setTimeZonePreference: (next) => {
        setPreference(next);
        save("monitor-time-zone", next);
      },
    };
  }, [at, now, theme, timeZonePreference]);
  return (
    <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>
  );
}

export function useDisplay() {
  const value = useContext(DisplayContext);
  if (!value) {
    throw new Error("useDisplay requires DisplayProvider");
  }
  return value;
}
