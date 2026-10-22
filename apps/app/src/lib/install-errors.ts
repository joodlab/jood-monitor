// Turns hub errors from operator requests into text that says what happened
// and what to do next. Unknown errors keep the hub's own message.

import { INVENTORY_RETENTION_DAYS, RAW_RETENTION_DAYS } from "./time";

type RequestErrorKind =
  | "duplicate-cluster"
  | "duplicate-workspace"
  | "active-credential"
  | "concurrent-profile"
  | "unknown-node"
  | "other";

export interface RequestError {
  kind: RequestErrorKind;
  message: string;
}

const known: [string, RequestErrorKind, string][] = [
  [
    "cluster registration failed",
    "duplicate-cluster",
    "The hub refused this cluster ID. Cluster IDs are unique across every workspace, so this ID is probably taken. Choose another ID, or renew the existing cluster's enrollment.",
  ],
  [
    "workspace creation failed",
    "duplicate-workspace",
    "The hub refused this workspace ID. It is probably taken; choose another ID.",
  ],
  [
    "active credential must be revoked",
    "active-credential",
    "This cluster still has an active credential, so its enrollment cannot be renewed. If a helper saved that credential, install the observer with it instead. If it is lost or compromised, an authorized operator revokes it with the operator API first (see “Revoke an active credential”), then renews. Renewal never revokes or rotates credentials for you.",
  ],
  [
    "profile changed concurrently",
    "concurrent-profile",
    "Collection settings changed elsewhere since this page loaded. The latest settings are loading; review them and apply again.",
  ],
  [
    "unknown node scope",
    "unknown-node",
    "The selected node is no longer in the cluster inventory. Choose another node.",
  ],
  [
    "diagnostics need node scope",
    "other",
    "Choose a node for the diagnostic. A diagnostic runs for at most 10 minutes.",
  ],
  [
    "unknown workspace",
    "other",
    "The selected workspace no longer exists. Choose or create another workspace.",
  ],
  ["cluster missing", "other", "This cluster no longer exists on the hub."],
  [
    "authentication required",
    "other",
    "Your operator session is no longer valid. Reload the page and sign in again.",
  ],
  [
    "origin and CSRF header required",
    "other",
    "The hub only accepts changes from its own address. Reload the hub and try again.",
  ],
  [
    "same-origin browser connection required",
    "other",
    "The hub only accepts changes from its own address. Reload the hub and try again.",
  ],
  [
    "recovery window; operator writes closed",
    "other",
    "The hub is in a recovery window. Changes are closed until recovery finishes.",
  ],
];

const fieldLabels: Record<string, string> = {
  id: "ID",
  name: "Name",
  workspaceId: "Workspace",
  environment: "Environment",
  namespaces: "Namespaces",
  nodeUids: "Diagnostic node",
  expiresAt: "Diagnostic expiry",
};

interface Issue {
  code?: string;
  format?: string;
  message?: string;
  path?: (string | number)[];
}

// Server-side validation failures arrive as a JSON list of schema issues.
function validationMessage(message: string) {
  if (!message.trimStart().startsWith("[")) {
    return;
  }
  try {
    const issues = JSON.parse(message) as Issue[];
    if (!Array.isArray(issues) || issues.length === 0) {
      return;
    }
    return issues
      .slice(0, 3)
      .map((issue) => {
        const field = issue.path
          ?.filter((part): part is string => typeof part === "string")
          .at(-1);
        const label = field ? (fieldLabels[field] ?? field) : "Value";
        const text =
          issue.format === "regex"
            ? "use lowercase letters, digits and hyphens (1–64 characters)"
            : (issue.message ?? "is invalid");
        return `${label}: ${text}`;
      })
      .join(". ");
  } catch {
    return;
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

export function requestError(error: unknown): RequestError {
  const message = errorText(error);
  const match = known.find(([needle]) => message.includes(needle));
  if (match) {
    return { kind: match[1], message: match[2] };
  }
  const validation = validationMessage(message);
  if (validation) {
    return {
      kind: "other",
      message: `The hub rejected the input. ${validation}.`,
    };
  }
  if (error instanceof TypeError || message.includes("Failed to fetch")) {
    return {
      kind: "other",
      message: "The hub could not be reached. Check your connection and retry.",
    };
  }
  return {
    kind: "other",
    message: message ? `The request failed: ${message}` : "The request failed.",
  };
}

export interface ReadError {
  detail: string;
  // Repeating the same request can succeed; otherwise Retry is hidden.
  retryable: boolean;
  title: string;
}

// Server-function errors keep the hub's message but not always its status,
// so reads are recognised by the message text. The more specific needle
// comes first.
const readErrors: [string, ReadError][] = [
  [
    "snapshot outside retention",
    {
      title: `This time is outside the ${INVENTORY_RETENTION_DAYS}-day retention`,
      detail: `Saved inventory and events cover the last ${INVENTORY_RETENTION_DAYS} days. Choose a time within them, or use Return to live above.`,
      retryable: false,
    },
  ],
  [
    "invalid timestamp",
    {
      title: "This link's time could not be read",
      detail:
        "Choose a saved observation time instead, or use Return to live above.",
      retryable: false,
    },
  ],
  [
    "precision boundary too broad",
    {
      title: "The saved inventory at this time could not be resolved",
      detail: "Choose a nearby time, or use Return to live above.",
      retryable: false,
    },
  ],
  [
    "too broad",
    {
      title: "This scope is too large to load; narrow it to a cluster",
      detail: "The hub limits how much one request can load.",
      retryable: false,
    },
  ],
  [
    "archive restore in progress",
    {
      title: "Archive restore in progress; retry shortly",
      detail: "The hub is restoring archived observations.",
      retryable: true,
    },
  ],
  [
    "authentication required",
    {
      title: "Reload and sign in again",
      detail: "Your operator session is no longer valid.",
      retryable: false,
    },
  ],
];

// Browsers word a failed fetch differently: Chromium, Firefox, Safari.
const networkFailure = /Failed to fetch|NetworkError|Load failed/i;

function readError(error: unknown, fallback: string): ReadError {
  const message = errorText(error);
  const match = readErrors.find(([needle]) => message.includes(needle));
  if (match) {
    return match[1];
  }
  const validation = validationMessage(message);
  if (validation) {
    return {
      title: "The hub rejected this request",
      detail: `${validation}.`,
      retryable: false,
    };
  }
  if (networkFailure.test(message)) {
    return {
      title: "The hub could not be reached",
      detail: "Check your connection and retry.",
      retryable: true,
    };
  }
  return { title: fallback, detail: message, retryable: true };
}

// Why the dashboard's observations could not load. Only a failed fetch
// claims the hub is unreachable.
export function snapshotError(error: unknown) {
  return readError(error, "The hub could not load observations");
}

const rawRetention: ReadError = {
  title: `Raw samples are kept for ${RAW_RETENTION_DAYS} days; this saved observation is older`,
  detail: "",
  retryable: false,
};

// The hub's refusal text for raw history outside its window; the dashboard
// raises the same error before asking, so both read alike.
export const rawRetentionMessage = `history range must be within ${RAW_RETENTION_DAYS} days`;

export function historyError(error: unknown): ReadError {
  const message = errorText(error);
  if (message.includes(rawRetentionMessage)) {
    return rawRetention;
  }
  // History is already one entity and metric; only a shorter window helps.
  if (message.includes("query too broad")) {
    return {
      title: "This window holds too many samples to load",
      detail: "Choose a shorter range.",
      retryable: false,
    };
  }
  return readError(error, "History unavailable");
}
