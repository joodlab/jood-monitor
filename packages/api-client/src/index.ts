import createClient from "openapi-fetch";
import type { components, paths } from "./schema";
export const api = createClient<paths>({
  baseUrl: "",
  headers: { "X-Jood-CSRF": "1" },
});
export type Snapshot = components["schemas"]["SnapshotResponse"];
export type Entity = components["schemas"]["Entity"];
export type Metric = components["schemas"]["Metric"];
export type Profile = components["schemas"]["Profile"];
export type ClusterView = components["schemas"]["ClusterView"];
export type Lifecycle = components["schemas"]["Lifecycle"];
