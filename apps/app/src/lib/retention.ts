// What the hub keeps, measured on its own clock, and the refusal it sends
// for raw history outside that window. The hub's read actions and the
// dashboard share these: the dashboard reads the refusal by its text, so the
// two cannot drift apart.

export const DAY_MS = 86_400_000;
// Saved inventory and events.
export const INVENTORY_RETENTION_DAYS = 180;
// Raw CPU/memory samples.
export const RAW_RETENTION_DAYS = 7;
// Raw samples taken during a Diagnostic, counted from each sample's source time.
export const DIAGNOSTIC_RETENTION_DAYS = 1;

export const rawRetentionMessage = `history range must be within ${RAW_RETENTION_DAYS} days`;
