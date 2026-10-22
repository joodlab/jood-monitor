// Turns hub errors from operator requests into text that says what happened
// and what to do next. Unknown errors keep the hub's own message.

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
