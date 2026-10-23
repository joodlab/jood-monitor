import type { Severity } from "./attention";

// What a list of attention rows is called. Info rows alone are notes, as the
// widget heading calls them, rows without info are problems, and a mix of
// both is items, so a note is never offered or announced as a problem.
export function rowsNoun(rows: { severity: Severity }[]) {
  const notes = rows.filter((row) => row.severity === "info").length;
  if (notes === 0) {
    return "problems";
  }
  return notes === rows.length ? "notes" : "items";
}
