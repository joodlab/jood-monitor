import { Button } from "@jood-monitor/ui/button";
import { Input } from "@jood-monitor/ui/input";
import { Label } from "@jood-monitor/ui/label";
import { cn } from "@jood-monitor/ui/utils";
import { Check, Plus } from "lucide-react";
import { useId, useState } from "react";
import {
  namespaceLimit,
  namespaceProblem,
  type ProfileDraft,
} from "./collection-model";
import { FieldNote } from "./connect-parts";

const filterThreshold = 12;

function NamespaceChip({
  name,
  checked,
  disabled,
  missing,
  onToggle,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  missing: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-full border px-3 text-xs transition-colors hover:bg-muted/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        checked && "border-primary bg-primary/10",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={disabled}
        onChange={onToggle}
        type="checkbox"
      />
      {checked ? (
        <Check aria-hidden className="size-3.5 text-primary" />
      ) : (
        <Plus aria-hidden className="size-3.5 text-muted-foreground" />
      )}
      <span className="font-mono">{name}</span>
      {missing && (
        <span className="text-muted-foreground">· not in inventory</span>
      )}
    </label>
  );
}

function AddNamespace({
  selected,
  disabled,
  onAdd,
}: {
  selected: string[];
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const uid = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  function add() {
    const problem = namespaceProblem(value, selected);
    setError(problem);
    if (!problem) {
      onAdd(value.trim());
      setValue("");
    }
  }
  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={`${uid}-add`}>
        Add a namespace not in the inventory yet
      </Label>
      <div className="flex gap-2">
        <Input
          aria-describedby={`${uid}-add-note`}
          aria-invalid={!!error}
          autoCapitalize="off"
          autoComplete="off"
          className="h-8 max-w-60 font-mono text-xs"
          disabled={disabled}
          id={`${uid}-add`}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="payments"
          spellCheck={false}
          value={value}
        />
        <Button
          className="h-8"
          disabled={disabled || !value.trim()}
          onClick={add}
          size="sm"
          type="button"
          variant="outline"
        >
          Add
        </Button>
      </div>
      <FieldNote error={error} id={`${uid}-add-note`} />
    </div>
  );
}

function NamespaceChoices({
  known,
  inventory,
  selected,
  disabled,
  onChange,
}: {
  known: string[];
  inventory: Set<string>;
  selected: string[];
  disabled: boolean;
  onChange: (namespaces: string[]) => void;
}) {
  const uid = useId();
  const [filter, setFilter] = useState("");
  const atLimit = selected.length >= namespaceLimit;
  const names = [...new Set([...known, ...selected])].sort((a, b) =>
    a.localeCompare(b)
  );
  const visible = filter
    ? names.filter((name) => name.includes(filter.trim().toLowerCase()))
    : names;
  return (
    <div className="space-y-3 pl-6">
      <p
        aria-live="polite"
        className={cn(
          "text-xs tabular-nums",
          atLimit ? "text-warning-text" : "text-muted-foreground"
        )}
        id={`${uid}-count`}
      >
        {selected.length} of {namespaceLimit} selected
        {atLimit &&
          ". Limit reached: remove one to add another, or collect from all namespaces."}
      </p>
      {names.length > filterThreshold && (
        <div className="space-y-1">
          <Label className="sr-only" htmlFor={`${uid}-filter`}>
            Filter namespaces
          </Label>
          <Input
            className="h-8 max-w-60 text-xs"
            id={`${uid}-filter`}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${names.length} namespaces`}
            type="search"
            value={filter}
          />
        </div>
      )}
      {names.length > 0 ? (
        <fieldset
          aria-describedby={`${uid}-count`}
          className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto p-0.5"
        >
          <legend className="sr-only">
            Namespaces to collect pod metrics in
          </legend>
          {visible.map((name) => {
            const checked = selected.includes(name);
            return (
              <NamespaceChip
                checked={checked}
                disabled={disabled || (!checked && atLimit)}
                key={name}
                missing={!inventory.has(name)}
                name={name}
                onToggle={() =>
                  onChange(
                    checked
                      ? selected.filter((item) => item !== name)
                      : [...selected, name]
                  )
                }
              />
            );
          })}
          {visible.length === 0 && (
            <p className="text-muted-foreground text-xs">
              No namespace matches “{filter}”.
            </p>
          )}
        </fieldset>
      ) : (
        <p className="text-muted-foreground text-xs">
          The inventory has no namespaces yet. Add one by name below.
        </p>
      )}
      <AddNamespace
        disabled={disabled || atLimit}
        onAdd={(name) => onChange([...selected, name])}
        selected={selected}
      />
    </div>
  );
}

export function NamespaceField({
  draft,
  known,
  inventory,
  disabled,
  onChange,
}: {
  draft: ProfileDraft;
  known: string[];
  inventory: Set<string>;
  disabled: boolean;
  onChange: (next: Pick<ProfileDraft, "scope" | "namespaces">) => void;
}) {
  const uid = useId();
  const scopes = [
    {
      value: "all" as const,
      label: "All namespaces",
      detail: "Default. Pod metrics come from every namespace.",
    },
    {
      value: "selected" as const,
      label: "Only selected namespaces",
      detail: `Up to ${namespaceLimit}. Other pods keep inventory and status, without usage metrics.`,
    },
  ];
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="font-medium text-sm">Pod metrics namespaces</legend>
      <p className="text-muted-foreground text-xs" id={`${uid}-note`}>
        Limits pod and container usage metrics. Node metrics and inventory are
        unaffected.
        {draft.name === "basic" &&
          " Basic does not collect pod metrics, so this applies once you switch to Standard or Diagnostic."}
      </p>
      <div
        aria-describedby={`${uid}-note`}
        className="space-y-2"
        role="radiogroup"
      >
        {scopes.map((scope) => (
          <label
            className="flex cursor-pointer items-start gap-2.5 rounded-md py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            key={scope.value}
          >
            <input
              checked={draft.scope === scope.value}
              className="mt-1 size-4 accent-primary"
              name={`${uid}-scope`}
              onChange={() =>
                onChange({ scope: scope.value, namespaces: draft.namespaces })
              }
              type="radio"
              value={scope.value}
            />
            <span>
              <span className="block">{scope.label}</span>
              <span className="block text-muted-foreground text-xs">
                {scope.detail}
              </span>
            </span>
          </label>
        ))}
      </div>
      {draft.scope === "selected" && (
        <NamespaceChoices
          disabled={disabled}
          inventory={inventory}
          known={known}
          onChange={(namespaces) => onChange({ scope: "selected", namespaces })}
          selected={draft.namespaces}
        />
      )}
    </fieldset>
  );
}
