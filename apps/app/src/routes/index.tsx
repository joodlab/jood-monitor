import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../components/dashboard";
import { validateMonitorSearch } from "../schemas/monitor";

export const Route = createFileRoute("/")({
  validateSearch: validateMonitorSearch,
  component: Dashboard,
});
