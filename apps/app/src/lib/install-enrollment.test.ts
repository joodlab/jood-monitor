import type { ClusterView } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { idSchema } from "../schemas/clusters";
import {
  credentialFile,
  hubOriginProblem,
  installSteps,
  tokenFile,
} from "./install-commands";
import {
  countdown,
  deliveryCheckInterval,
  elapsed,
  enrollmentLifetimeMs,
  expiryGraceMs,
  fastCheckMs,
  firstDelivery,
  idProblem,
  inventoryPatienceMs,
  issuedAt,
  minutesLeft,
  slowCheckAfterMs,
  slowCheckMs,
  slugify,
} from "./install-enrollment";
import { requestError } from "./install-errors";

const secretLike = /Bearer|token=/i;
const readsStdin = /\bread\b|\bcat\s*>/;
const fromFile = /--from-file=credential=(\S+)/;
const helperOutput = /enroll-agent\.py \S+ \S+ \S+ (\S+)/;
const tokenRemoval = / && rm -f \.secrets\.enrollment-token$/;
const credentialRemoval = / && rm -f \.secrets\.hub-credential-synthetic-a$/;

function view(
  times: { heartbeatAt?: string | null; receivedAt?: string | null },
  nodes = 0
): ClusterView {
  return {
    cluster: {
      id: "synthetic-a",
      name: "Synthetic A",
      environment: "staging",
      workspaceId: "synthetic",
      revoked: false,
      heartbeatAt: times.heartbeatAt ?? null,
      inventoryTime: times.receivedAt ?? null,
      receivedAt: times.receivedAt ?? null,
    },
    inventory: {
      entities: Array.from({ length: nodes }, (_, index) => ({
        uid: `node-${index}`,
        name: `node-${index}`,
        kind: "Node",
        status: "Ready",
      })),
      edges: [],
      sourceTime: times.receivedAt ?? "0001-01-01T00:00:00Z",
      capabilities: [],
    },
    metrics: [],
    profile: {
      name: "basic",
      revision: 1,
      appliedRevision: 0,
      nodeUids: [],
      namespaces: [],
      paused: false,
    },
    heartbeat: {
      version: "0.1.1",
      appliedRevision: 0,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "",
      capabilities: [],
    },
  } as ClusterView;
}

describe("cluster identifiers", () => {
  it("derives IDs the hub accepts from display names", () => {
    expect(slugify("Payments EU (prod)")).toBe("payments-eu-prod");
    expect(slugify("  Café Ünïcode  ")).toBe("cafe-unicode");
    expect(slugify("---")).toBe("");
    const long = slugify(`${"a".repeat(63)} b`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("-")).toBe(false);
    for (const name of ["Payments EU (prod)", "x".repeat(90), "A_B.C"]) {
      expect(idSchema.safeParse(slugify(name)).success).toBe(true);
    }
  });

  it("explains the ID rule before submit", () => {
    expect(idProblem("")).toBe("Required.");
    expect(idProblem("Prod Cluster")).toContain("uppercase letters");
    expect(idProblem("prod cluster")).toContain("spaces");
    expect(idProblem("prod_cluster")).toContain("“_”");
    expect(idProblem("a".repeat(65))).toContain("at most 64");
    expect(idProblem("global", ["global"])).toContain("reserved");
    expect(idProblem("prod-1")).toBeUndefined();
  });
});

describe("first delivery", () => {
  const expiresAt = "2026-10-22T10:30:00.000Z";
  const since = issuedAt(expiresAt);

  it("uses the hub's own issue time", () => {
    expect(Date.parse(expiresAt) - since).toBe(enrollmentLifetimeMs);
  });

  it("waits until a heartbeat newer than the enrollment arrives", () => {
    expect(firstDelivery([], "synthetic-a", since).state).toBe("waiting");
    // A renewed cluster keeps its earlier heartbeat and inventory.
    const old = view(
      {
        heartbeatAt: "2026-10-21T08:00:00.000Z",
        receivedAt: "2026-10-21T08:00:00.000Z",
      },
      3
    );
    expect(firstDelivery([old], "synthetic-a", since).state).toBe("waiting");
  });

  it("separates the first heartbeat from the first inventory", () => {
    const heartbeat = view({ heartbeatAt: "2026-10-22T10:01:00.000Z" });
    expect(firstDelivery([heartbeat], "synthetic-a", since)).toMatchObject({
      state: "heartbeat",
      servers: 0,
    });
    const inventory = view(
      {
        heartbeatAt: "2026-10-22T10:01:00.000Z",
        receivedAt: "2026-10-22T10:01:05.000Z",
      },
      4
    );
    expect(
      firstDelivery([heartbeat, inventory], "synthetic-a", since)
    ).toMatchObject({ state: "inventory", servers: 4, version: "0.1.1" });
    expect(firstDelivery([inventory], "other", since).state).toBe("waiting");
  });

  it("formats countdowns and elapsed time", () => {
    expect(countdown(90_000, 0)).toBe("1:30");
    expect(countdown(0, 5000)).toBe("0:00");
    expect(minutesLeft(9 * 60_000, 0)).toBe("9 min");
    expect(minutesLeft(30_000, 0)).toBe("under a minute");
    expect(minutesLeft(0, 1)).toBe("now");
    expect(elapsed(0, 65_000)).toBe("1m 05s");
    expect(elapsed(0, 9000)).toBe("9s");
  });
});

describe("install commands", () => {
  it("never embeds the token and prefills hub and cluster", () => {
    const steps = installSteps({
      origin: "https://monitor.example.com",
      clusterId: "synthetic-a",
    });
    const text = steps.map((step) => step.command).join("\n");
    expect(steps.map((step) => step.id)).toEqual([
      "token",
      "credential",
      "secrets",
      "chart",
    ]);
    expect(text).toContain(
      "python3 scripts/enroll-agent.py https://monitor.example.com synthetic-a .secrets.enrollment-token .secrets.hub-credential-synthetic-a && rm -f .secrets.enrollment-token"
    );
    expect(text).toContain("--set hubURL=https://monitor.example.com");
    expect(text).toContain("jood-monitor-hub --from-file=credential=");
    expect(text).toContain("jood-monitor-observer-tls");
    expect(text).toContain("jood-monitor-observer-ca --from-file=ca.crt=");
    expect(text).not.toMatch(secretLike);
  });

  it("uses a placeholder for non-HTTPS origins", () => {
    expect(hubOriginProblem("https://monitor.example.com")).toBeUndefined();
    expect(hubOriginProblem("http://127.0.0.1:3040")).toContain("HTTPS");
    expect(hubOriginProblem("https://monitor.example.com/app")).toBeDefined();
    const [, step] = installSteps({
      origin: "http://127.0.0.1:3040",
      clusterId: "synthetic-a",
    });
    expect(step.id).toBe("credential");
    expect(step.command).toContain("https://<hub-origin> synthetic-a");
  });

  it("reads the token alone on one silent line", () => {
    for (const kind of ["new", "recover"] as const) {
      const steps = installSteps({
        origin: "https://monitor.example.com",
        clusterId: "synthetic-a",
        kind,
      });
      const reading = steps.filter((step) => readsStdin.test(step.command));
      expect(reading.map((step) => step.id)).toEqual(["token"]);
      expect(reading[0].command.split("\n")).toHaveLength(1);
      expect(reading[0].command).toContain("umask 077");
      expect(reading[0].command).toContain("read -rs");
      expect(reading[0].command).toContain(`> ${tokenFile}`);
    }
  });

  it("keeps private files ignored and removes them only after success", () => {
    const steps = installSteps({
      origin: "https://monitor.example.com",
      clusterId: "synthetic-a",
    });
    const lines = steps.flatMap((step) => step.command.split("\n"));
    const removals = lines.filter((line) => line.includes("rm "));
    expect(removals).toHaveLength(2);
    expect(removals[0]).toMatch(tokenRemoval);
    expect(removals[1]).toMatch(credentialRemoval);
    for (const file of [
      tokenFile,
      credentialFile("synthetic-a", "new"),
      credentialFile("synthetic-a", "recover"),
    ]) {
      expect(file.startsWith(".secrets.")).toBe(true);
    }
  });

  it("replaces the credential in place for a renewal", () => {
    const steps = installSteps({
      origin: "https://monitor.example.com",
      clusterId: "synthetic-a",
      kind: "recover",
    });
    expect(steps.map((step) => step.id)).toEqual([
      "token",
      "credential",
      "replace",
    ]);
    const replace = steps[2].command;
    expect(replace).toContain(
      "kubectl apply -f - && rm -f .secrets.hub-credential-synthetic-a-renewed"
    );
    expect(replace).not.toContain("rollout restart");
  });

  it("gives a renewal its own credential file end to end", () => {
    const output = (kind: "new" | "recover", fullInstall?: boolean) => {
      const text = installSteps({
        origin: "https://monitor.example.com",
        clusterId: "synthetic-a",
        kind,
        fullInstall,
      })
        .map((step) => step.command)
        .join("\n");
      return {
        helper: helperOutput.exec(text)?.[1],
        stored: fromFile.exec(text)?.[1],
      };
    };
    const fresh = output("new");
    const renewed = output("recover");
    expect(fresh.helper).toBe(".secrets.hub-credential-synthetic-a");
    expect(renewed.helper).toBe(".secrets.hub-credential-synthetic-a-renewed");
    expect(fresh.stored).toBe(fresh.helper);
    expect(renewed.stored).toBe(renewed.helper);
    // The full installation for a renewal still uses the renewed file.
    expect(output("recover", true)).toEqual(renewed);
  });
});

describe("first delivery checks", () => {
  const expiresAt = "2026-10-22T10:30:00.000Z";
  const expiry = Date.parse(expiresAt);
  const startedAt = expiry - 20 * 60_000;
  const plan = (
    now: number,
    state: "waiting" | "heartbeat" | "inventory" = "waiting",
    heartbeatAt?: string
  ) => deliveryCheckInterval({ state, startedAt, expiresAt, heartbeatAt, now });

  it("checks every 10 seconds, then every 30 after ten minutes", () => {
    expect(fastCheckMs).toBe(10_000);
    expect(slowCheckMs).toBe(30_000);
    expect(plan(startedAt)).toBe(fastCheckMs);
    expect(plan(startedAt + slowCheckAfterMs - 1)).toBe(fastCheckMs);
    expect(plan(startedAt + slowCheckAfterMs)).toBe(slowCheckMs);
  });

  it("stops once the token expired plus grace with no heartbeat", () => {
    expect(plan(expiry + expiryGraceMs - 1)).toBe(slowCheckMs);
    expect(plan(expiry + expiryGraceMs)).toBe(false);
    expect(
      deliveryCheckInterval({
        state: "waiting",
        startedAt,
        expiresAt: "not a time",
        now: startedAt,
      })
    ).toBe(false);
  });

  it("checks slowly for inventory after a heartbeat, for a bounded time", () => {
    // The token was exchanged a minute before it expired.
    const heartbeat = expiry - 60_000;
    const at = new Date(heartbeat).toISOString();
    // A heartbeat keeps checks going past the token's expiry.
    expect(plan(expiry + expiryGraceMs, "heartbeat", at)).toBe(slowCheckMs);
    expect(plan(heartbeat + inventoryPatienceMs - 1, "heartbeat", at)).toBe(
      slowCheckMs
    );
    expect(plan(heartbeat + inventoryPatienceMs, "heartbeat", at)).toBe(false);
    expect(plan(startedAt + inventoryPatienceMs, "heartbeat")).toBe(false);
    expect(plan(startedAt, "inventory")).toBe(false);
  });
});

describe("request errors", () => {
  it("maps hub refusals to next steps", () => {
    expect(
      requestError(new Error("cluster registration failed; check identity"))
    ).toMatchObject({ kind: "duplicate-cluster" });
    expect(
      requestError(
        new Error(
          "active credential must be revoked before renewing enrollment"
        )
      )
    ).toMatchObject({
      kind: "active-credential",
      message: expect.stringContaining("Revoke an active credential"),
    });
    expect(
      requestError(new Error("profile changed concurrently; refresh")).kind
    ).toBe("concurrent-profile");
    expect(
      requestError(new Error("workspace creation failed; check identity")).kind
    ).toBe("duplicate-workspace");
  });

  it("summarizes schema issues instead of raw JSON", () => {
    const issues = JSON.stringify([
      {
        origin: "string",
        code: "invalid_format",
        format: "regex",
        path: ["id"],
        message: "Invalid string: must match pattern /^[a-z0-9-]{1,64}$/",
      },
    ]);
    const { message } = requestError(new Error(issues));
    expect(message).toContain("ID: use lowercase letters");
    expect(message).not.toContain("[");
  });

  it("keeps unknown messages and network failures readable", () => {
    expect(requestError(new TypeError("Failed to fetch")).message).toContain(
      "could not be reached"
    );
    expect(requestError(new Error("teapot")).message).toBe(
      "The request failed: teapot"
    );
    expect(requestError(undefined).message).toBe("The request failed.");
  });
});
