import type { ClusterView } from "@jood-monitor/api-client";

export interface WorkspacesPageProps {
  onNewWorkspace: () => void;
  onOpen: (workspace: string) => void;
  views: ClusterView[];
  workspaces: { id: string; name: string }[];
}

// Railway-style workspace grid. Placeholder until the grid lands.
export function WorkspacesPage({ workspaces, onOpen }: WorkspacesPageProps) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {workspaces.map((workspace) => (
        <li key={workspace.id}>
          <button
            className="w-full rounded-xl border bg-card p-5 text-left"
            onClick={() => onOpen(workspace.id)}
            type="button"
          >
            {workspace.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
