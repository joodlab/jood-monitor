/**
 * Prisma 8 (RC) runtime on Cloudflare D1.
 *
 * `@prisma/orm-sqlite/runtime`'s `sqlite()` facade is hard-wired to a driver that imports
 * `node:sqlite` (`DatabaseSync`), which does not exist in workerd. This module rebuilds the same
 * facade (`db.orm`, `db.sql`, `db.raw`, `db.enums`, `db.prepare`, `db.runtime()`) on top of the
 * SAME target / adapter / codecs / ORM client, swapping only the driver for one that talks to a
 * `D1Database` binding (or a `D1DatabaseSession`).
 *
 * Imports only `@prisma/orm-sqlite/*` facade subpaths (works under pnpm's strict layout) and never
 * `node:sqlite`, so it bundles for Workers (`compatibility_flags: ["nodejs_compat"]` is required
 * because the Prisma runtime itself imports `node:crypto` and uses `Buffer`).
 *
 * Transactions: D1 has NO interactive transactions (no BEGIN/COMMIT over the Worker API).
 *  - `db.batch(...)`  -> atomic: SQL-builder / raw plans flushed through `D1Database.batch()`.
 *  - `db.transaction(...)` -> rejected by default (D1.INTERACTIVE_TRANSACTION_UNSUPPORTED);
 *    opt in to a NON-atomic "pseudo" transaction with `{ pseudoTransactions: true }`.
 *  - ORM internals that open a mutation scope (single-row `update()` / `delete()`, nested
 *    relation `create()`, `include(...).create()`) run their statements sequentially WITHOUT
 *    atomicity. See docs/database.md for the D1 transaction boundary.
 */
import sqliteAdapter from "@prisma/orm-sqlite/adapter/runtime";
import {
  sql as buildSql,
  createRawLane,
} from "@prisma/orm-sqlite/builder/runtime";
import type { RuntimeDriverDescriptor } from "@prisma/orm-sqlite/components/execution";
import { instantiateExecutionStack } from "@prisma/orm-sqlite/components/execution";
import { UNBOUND_NAMESPACE_ID } from "@prisma/orm-sqlite/components/ir";
import { buildNamespacedEnums } from "@prisma/orm-sqlite/contract/enum-accessor";
import type { Contract } from "@prisma/orm-sqlite/contract/types";
import type { SqlStorage } from "@prisma/orm-sqlite/family-contract/types";
import type {
  ExecutionContext,
  Runtime,
  RuntimeConnection,
  SqlMiddleware,
  SqlRuntimeExtensionDescriptor,
} from "@prisma/orm-sqlite/family-runtime";
import {
  createExecutionContext,
  createSqlExecutionStack,
  SqlRuntimeBase,
  withTransaction,
} from "@prisma/orm-sqlite/family-runtime";
import { orm, prepareQuery } from "@prisma/orm-sqlite/orm-client";
import type {
  SqlConnection,
  SqlDriver,
  SqlExecuteRequest,
  SqlQueryable,
  SqlStatementStats,
  SqlTransaction,
} from "@prisma/orm-sqlite/relational-core/ast";
import type { SqliteClient } from "@prisma/orm-sqlite/runtime";
import sqliteTarget, {
  SqliteContractSerializer,
} from "@prisma/orm-sqlite/target/runtime";
import { structuredError } from "@prisma/orm-sqlite/utils/structured-error";

// ---------------------------------------------------------------------------------------------
// Minimal structural D1 types. `D1Database` and `D1DatabaseSession` from
// @cloudflare/workers-types (or `wrangler types`) both satisfy `D1Like`.
// ---------------------------------------------------------------------------------------------

interface D1ResultLike<T = Record<string, unknown>> {
  readonly meta?: {
    readonly changes?: number;
    readonly last_row_id?: number;
    readonly [k: string]: unknown;
  };
  readonly results?: T[];
  readonly success?: boolean;
}
interface D1PreparedStatementLike {
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  bind(...values: unknown[]): D1PreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}
export interface D1Like {
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[]
  ): Promise<D1ResultLike<T>[]>;
  prepare(query: string): D1PreparedStatementLike;
}

// ---------------------------------------------------------------------------------------------
// Errors. The ORM / runtime classify errors by duck type (`kind === 'sql_query'` + `sqlState`,
// see SqlQueryError.is / isUniqueConstraintViolation), so these are fully compatible with
// Prisma's own SqlQueryError / SqlConnectionError without importing non-facade packages.
// ---------------------------------------------------------------------------------------------

class D1QueryError extends Error {
  readonly kind = "sql_query" as const;
  readonly sqlState: string;
  readonly constraint: string | undefined;
  constructor(
    message: string,
    options: { cause: unknown; sqlState: string; constraint?: string }
  ) {
    super(message, { cause: options.cause });
    this.name = "SqlQueryError";
    this.sqlState = options.sqlState;
    this.constraint = options.constraint;
  }
}

class D1ConnectionError extends Error {
  readonly kind = "sql_connection" as const;
  readonly transient: boolean;
  constructor(
    message: string,
    options: { cause: unknown; transient: boolean }
  ) {
    super(message, { cause: options.cause });
    this.name = "SqlConnectionError";
    this.transient = options.transient;
  }
}

/** SQLSTATE 23505 — what Prisma's isUniqueConstraintViolation() checks. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";

/** True for unique / primary-key violations, whether thrown by the driver or wrapped by the runtime. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === "object" &&
      (e as { kind?: unknown }).kind === "sql_query" &&
      (e as { sqlState?: unknown }).sqlState === UNIQUE_VIOLATION
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

/** Maps D1 / SQLite error text onto SQLSTATE classes, mirroring the node:sqlite driver. */
const extendedConstraint =
  /SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY|FOREIGNKEY|NOTNULL|CHECK)\b/;
const textualConstraint =
  /(UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed(?::\s*([^:()]+?))?\s*(?::|\(|$)/m;
const genericConstraint = /constraint failed|SQLITE_CONSTRAINT/;
const transientFailure =
  /SQLITE_BUSY|database is locked|Network connection lost|storage caused object to be reset|Internal error|overloaded|timed? ?out/i;
const queryFailure =
  /D1_ERROR|SQLITE_ERROR|no such (table|column)|syntax error|too many SQL variables/i;
const constraintStates: Record<string, string> = {
  UNIQUE: UNIQUE_VIOLATION,
  PRIMARYKEY: UNIQUE_VIOLATION,
  FOREIGNKEY: FOREIGN_KEY_VIOLATION,
  NOTNULL: NOT_NULL_VIOLATION,
  CHECK: "23514",
};

export function normalizeD1Error(error: unknown): Error {
  const message = messageOf(error);
  const base = error instanceof Error ? error : new Error(message);
  // D1 text, e.g.: "D1_ERROR: UNIQUE constraint failed: workspace.slug: SQLITE_CONSTRAINT
  // (extended: SQLITE_CONSTRAINT_UNIQUE) (...)" or "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT ...".
  const extended = extendedConstraint.exec(message)?.[1];
  const textual = textualConstraint.exec(message);
  const kind = extended ?? textual?.[1]?.replace(" ", "");
  if (kind || genericConstraint.test(message)) {
    const sqlState = constraintStates[kind ?? ""] ?? "23000";
    const name = textual?.[2]?.trim();
    const constraint = name && !name.startsWith("SQLITE_") ? name : undefined;
    return new D1QueryError(message, {
      cause: base,
      sqlState,
      ...(constraint ? { constraint } : {}),
    });
  }
  if (transientFailure.test(message)) {
    return new D1ConnectionError(message, { cause: base, transient: true });
  }
  if (queryFailure.test(message)) {
    return new D1QueryError(message, { cause: base, sqlState: "HY000" });
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Parameter binding + row normalisation
// ---------------------------------------------------------------------------------------------

/**
 * Converts codec-encoded params into values D1 accepts. Prisma's SQLite codecs already encode
 * DateTime -> ISO text, Json -> JSON text, Int -> number, so most values pass through.
 * D1 rejects `undefined` and `bigint`; SQLite cannot store NaN.
 */
export function toD1Value(value: unknown, index: number): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (Number.isNaN(value)) {
        throw structuredError(
          "RUNTIME.ENCODE_FAILED",
          `Parameter ${index + 1} is NaN, which SQLite cannot store.`,
          {
            meta: { paramIndex: index, received: "NaN" },
          }
        );
      }
      return value;
    case "boolean":
      return value ? 1 : 0;
    case "bigint": {
      const asNumber = Number(value);
      // Lossless: small values as numbers, large ones as digit text (INTEGER affinity converts it back).
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    case "object":
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof ArrayBuffer) {
        return value;
      }
      if (ArrayBuffer.isView(value)) {
        return value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        );
      }
      return JSON.stringify(value);
    default:
      throw structuredError(
        "RUNTIME.ENCODE_FAILED",
        `Parameter ${index + 1} has unsupported type ${typeof value}.`,
        {
          meta: { paramIndex: index, received: typeof value },
        }
      );
  }
}

function bindStatement(
  d1: D1Like,
  request: SqlExecuteRequest
): D1PreparedStatementLike {
  const stmt = d1.prepare(request.sql);
  const params = request.params ?? [];
  return params.length === 0 ? stmt : stmt.bind(...params.map(toD1Value));
}

/** D1 returns BLOB columns as number[] (remote) or ArrayBuffer; Prisma's blob codec expects Uint8Array. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [key, v] of Object.entries(row)) {
    if (Array.isArray(v) || v instanceof ArrayBuffer) {
      copy ??= { ...row };
      copy[key] = Array.isArray(v)
        ? Uint8Array.from(v as number[])
        : new Uint8Array(v);
    }
  }
  return copy ?? row;
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

interface D1Binding {
  readonly database: D1Like;
  readonly kind: "d1";
}

class D1Queryable implements SqlQueryable {
  protected readonly d1: D1Like;
  constructor(d1: D1Like) {
    this.d1 = d1;
  }

  async *query<Row = Record<string, unknown>>(
    request: SqlExecuteRequest
  ): AsyncIterable<Row> {
    let result: D1ResultLike;
    try {
      result = await bindStatement(this.d1, request).all();
    } catch (error) {
      throw normalizeD1Error(error);
    }
    for (const row of result.results ?? []) {
      yield normalizeRow(row) as Row;
    }
  }

  async execute(request: SqlExecuteRequest): Promise<SqlStatementStats> {
    try {
      const result = await bindStatement(this.d1, request).run();
      return { affectedRows: Number(result.meta?.changes ?? 0) };
    } catch (error) {
      throw normalizeD1Error(error);
    }
  }
}

/**
 * NOT a real transaction. D1 exposes no BEGIN/COMMIT to Workers, so statements run immediately and
 * rollback() cannot undo them. Needed because the ORM opens a mutation scope (connection +
 * transaction) for single-row update()/delete() and nested creates.
 */
class D1PseudoTransaction extends D1Queryable implements SqlTransaction {
  commit(): Promise<void> {
    return Promise.resolve();
  }
  rollback(): Promise<void> {
    return Promise.resolve();
  }
}

class D1Connection extends D1Queryable implements SqlConnection {
  beginTransaction(): Promise<SqlTransaction> {
    return Promise.resolve(new D1PseudoTransaction(this.d1));
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Collects statements instead of running them; `flush()` sends all of them in ONE D1 batch
 * (an implicit SQL transaction: all succeed or all roll back).
 */
class D1BatchCollector extends D1Connection {
  readonly #entries: Array<{
    readonly request: SqlExecuteRequest;
    readonly resolve: (r: D1ResultLike) => void;
    readonly reject: (e: unknown) => void;
  }> = [];
  #sealed = false;
  #waiter:
    | { readonly target: () => number; readonly resolve: () => void }
    | undefined;

  get size(): number {
    return this.#entries.length;
  }

  /** Re-evaluates the waiter (called on every registration and whenever the target shrinks). */
  poke(): void {
    if (this.#waiter && this.#entries.length >= this.#waiter.target()) {
      this.#waiter.resolve();
    }
  }

  #register(request: SqlExecuteRequest): Promise<D1ResultLike> {
    if (this.#sealed) {
      return Promise.reject(
        structuredError(
          "D1.BATCH_SEALED",
          "A statement was issued after the D1 batch was flushed.",
          {
            why: "Only single-statement plans can be part of db.batch(); this operation needed a second round trip.",
            fix: "Pass SQL-builder / raw plans to db.batch(), not multi-step ORM operations.",
          }
        )
      );
    }
    return new Promise<D1ResultLike>((resolve, reject) => {
      this.#entries.push({ request, resolve, reject });
      this.poke();
    });
  }

  override async *query<Row = Record<string, unknown>>(
    request: SqlExecuteRequest
  ): AsyncIterable<Row> {
    const result = await this.#register(request);
    for (const row of result.results ?? []) {
      yield normalizeRow(row) as Row;
    }
  }

  override async execute(
    request: SqlExecuteRequest
  ): Promise<SqlStatementStats> {
    const result = await this.#register(request);
    return { affectedRows: Number(result.meta?.changes ?? 0) };
  }

  override beginTransaction(): Promise<SqlTransaction> {
    return Promise.reject(
      structuredError(
        "D1.BATCH_NESTED_TRANSACTION",
        "Cannot open a transaction inside db.batch()."
      )
    );
  }

  /** Resolves once `target()` statements are registered (target may shrink; call poke()). */
  waitFor(target: () => number): Promise<void> {
    if (this.#entries.length >= target()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiter = { target, resolve };
    });
  }

  async flush(): Promise<void> {
    this.#sealed = true;
    const entries = this.#entries.splice(0);
    if (entries.length === 0) {
      return;
    }
    let results: D1ResultLike[];
    try {
      results = await this.d1.batch(
        entries.map((e) => bindStatement(this.d1, e.request))
      );
    } catch (error) {
      const normalized = normalizeD1Error(error);
      for (const e of entries) {
        e.reject(normalized);
      }
      throw normalized;
    }
    entries.forEach((e, i) => {
      e.resolve(results[i] ?? {});
    });
  }

  rejectAll(error: unknown): void {
    this.#sealed = true;
    for (const e of this.#entries.splice(0)) {
      e.reject(error);
    }
  }
}

class D1Driver implements SqlDriver<D1Binding> {
  readonly familyId = "sql" as const;
  readonly targetId = "sqlite" as const;
  #d1: D1Like | undefined;
  #nextConnection: D1Connection | undefined;

  get state(): "unbound" | "connected" {
    return this.#d1 ? "connected" : "unbound";
  }

  #require(): D1Like {
    if (!this.#d1) {
      throw structuredError(
        "DRIVER.NOT_CONNECTED",
        "D1 driver has no database binding.",
        {
          fix: "Create the client with createD1Client(env.DB, contractJson).",
        }
      );
    }
    return this.#d1;
  }

  connect(binding: D1Binding): Promise<void> {
    this.#d1 = binding.database;
    return Promise.resolve();
  }

  /** Synchronous so it can be set right before runtime.connection() picks it up (see D1Client.batch). */
  connectSync(binding: D1Binding): void {
    this.#d1 = binding.database;
  }

  /** Hands the given connection to the NEXT acquireConnection() call only (undefined disarms). */
  armNextConnection(connection: D1Connection | undefined): void {
    this.#nextConnection = connection;
  }

  acquireConnection(): Promise<SqlConnection> {
    const armed = this.#nextConnection;
    this.#nextConnection = undefined;
    return Promise.resolve(armed ?? new D1Connection(this.#require()));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  query<Row = Record<string, unknown>>(
    request: SqlExecuteRequest
  ): AsyncIterable<Row> {
    return new D1Queryable(this.#require()).query<Row>(request);
  }

  execute(request: SqlExecuteRequest): Promise<SqlStatementStats> {
    return new D1Queryable(this.#require()).execute(request);
  }
}

/** Runtime driver descriptor — same shape as @prisma/orm-target-sqlite/driver/runtime's. */
const d1RuntimeDriverDescriptor = {
  kind: "driver",
  familyId: "sql",
  targetId: "sqlite",
  id: "d1",
  version: "0.0.1",
  capabilities: {},
  create(): D1Driver {
    return new D1Driver();
  },
} as const satisfies RuntimeDriverDescriptor<"sql", "sqlite", void, D1Driver>;

// ---------------------------------------------------------------------------------------------
// Client facade
// ---------------------------------------------------------------------------------------------

type AnyContract = Contract<SqlStorage>;
type Base<C extends AnyContract> = SqliteClient<C>;
type PlanArg = Parameters<Runtime["query"]>[0];

interface BatchQuery<Row> {
  readonly _row?: Row;
  readonly kind: "query";
  readonly plan: PlanArg;
}
interface BatchExecute {
  readonly kind: "execute";
  readonly plan: PlanArg;
}
type BatchOp = BatchQuery<unknown> | BatchExecute;
type BatchResults<T extends readonly BatchOp[]> = {
  -readonly [K in keyof T]: T[K] extends BatchQuery<infer Row>
    ? Row[]
    : SqlStatementStats;
};
interface BatchBuilder {
  /** A non-returning write: resolves { affectedRows }. */
  execute(plan: PlanArg): BatchExecute;
  /** A row-returning plan: select, or insert/update/delete with .returning(...), or raw .returnsRow(). */
  query<Row>(plan: PlanArg & { readonly _row?: Row }): BatchQuery<Row>;
}

export interface D1Client<C extends AnyContract> {
  /**
   * Atomic: every plan runs inside ONE `D1Database.batch()` (all-or-nothing). Plans cannot depend
   * on each other's results — generate ids up front (the SQL builder applies cuid/now defaults).
   */
  batch<const T extends readonly BatchOp[]>(
    build: (b: BatchBuilder) => T
  ): Promise<BatchResults<T>>;
  /** No-op (D1 bindings own no connection); kept for API parity. */
  close(): Promise<void>;
  readonly context: Base<C>["context"];
  readonly contract: C;
  /** The D1Database / D1DatabaseSession this client runs against. */
  readonly d1: D1Like;
  readonly enums: Base<C>["enums"];
  readonly orm: Base<C>["orm"];
  prepare: Base<C>["prepare"];
  readonly raw: Base<C>["raw"];
  runtime(): Runtime;
  readonly sql: Base<C>["sql"];
  /**
   * Rejected unless `pseudoTransactions: true` — D1 cannot hold a transaction open across awaits.
   * With the option, statements run immediately and are NOT rolled back on error.
   */
  transaction: Base<C>["transaction"];
}

export interface D1ClientOptions {
  readonly extensions?: readonly SqlRuntimeExtensionDescriptor<"sqlite">[];
  readonly middleware?: readonly SqlMiddleware[];
  /** Allow db.transaction() as a NON-atomic sequence. Default false (throws). */
  readonly pseudoTransactions?: boolean;
}

interface StaticParts {
  readonly context: ExecutionContext<AnyContract>;
  readonly contract: AnyContract;
  readonly enums: unknown;
  readonly raw: unknown;
  readonly sql: unknown;
  readonly stack: ReturnType<typeof createSqlExecutionStack>;
}

class D1RuntimeImpl extends SqlRuntimeBase<AnyContract> {}

// Contract deserialisation + codec registry building costs a few ms: do it once per isolate.
const staticCache = new WeakMap<object, StaticParts>();

function buildStatic(
  contractJson: unknown,
  extensions: D1ClientOptions["extensions"]
): StaticParts {
  const key = contractJson as object;
  const cached = extensions === undefined ? staticCache.get(key) : undefined;
  if (cached) {
    return cached;
  }
  const contract = new SqliteContractSerializer().deserializeContract(
    contractJson
  );
  const stack = createSqlExecutionStack({
    target: sqliteTarget,
    adapter: sqliteAdapter,
    driver: d1RuntimeDriverDescriptor,
    extensions: extensions ?? [],
  });
  const context = createExecutionContext({
    contract,
    stack,
    driver: d1RuntimeDriverDescriptor,
  });
  const rawCodecInferer = stack.adapter.rawCodecInferer;
  const sql = (
    buildSql({ context, rawCodecInferer }) as Record<string, unknown>
  )[UNBOUND_NAMESPACE_ID];
  const raw = createRawLane({ context, rawCodecInferer });
  const enums = (
    buildNamespacedEnums(context.contract.domain, (codecId) =>
      context.contractCodecs.forCodecRef({ codecId })
    ) as Record<string, unknown>
  )[UNBOUND_NAMESPACE_ID];
  const parts: StaticParts = {
    contract: context.contract,
    stack,
    context,
    sql,
    raw,
    enums,
  };
  if (extensions === undefined) {
    staticCache.set(key, parts);
  }
  return parts;
}

function unbound<T>(value: unknown): T {
  return (value as Record<string, unknown>)[UNBOUND_NAMESPACE_ID] as T;
}

function interactiveTransactionUnsupported(): Error {
  return structuredError(
    "D1.INTERACTIVE_TRANSACTION_UNSUPPORTED",
    "Cloudflare D1 does not support interactive transactions.",
    {
      why: "A D1 transaction cannot stay open across awaits; only D1Database.batch() is atomic.",
      fix: "Use db.batch((b) => [b.execute(plan), b.query(plan)]) for atomic writes, or opt in to non-atomic pseudo transactions with createD1Client(d1, contractJson, { pseudoTransactions: true }).",
    }
  );
}

/**
 * Creates a Prisma 8 client bound to a D1 database. Cheap to call per request: the contract,
 * codecs and execution context are cached per `contractJson` object.
 *
 * ```ts
 * const db = createD1Client<Contract>(env.DB, contractJson);
 * const people = await db.orm.Employee.where({ workspaceId }).orderBy((e) => e.fullName.asc()).limit(20).all();
 * ```
 */
export function createD1Client<C extends AnyContract>(
  d1: D1Like,
  contractJson: unknown,
  options: D1ClientOptions = {}
): D1Client<C> {
  const parts = buildStatic(contractJson, options.extensions);
  const { context, stack } = parts;
  const stackInstance = instantiateExecutionStack(stack);
  const driver = d1RuntimeDriverDescriptor.create();
  driver.connectSync({ kind: "d1", database: d1 });
  const runtime = new D1RuntimeImpl({
    context,
    adapter: stackInstance.adapter,
    driver,
    // D1 schema is tracked by wrangler's d1_migrations table, not Prisma's _prisma_marker.
    // Must stay false: the marker probe would otherwise run through a held batch connection.
    verifyMarker: false,
    ...(options.middleware ? { middleware: options.middleware } : {}),
    closeRefusal: "at-once",
  });

  const ormClient = unbound<Base<C>["orm"]>(orm({ context, runtime }));

  function prepare(declaration: unknown, callback: unknown) {
    // biome-ignore lint/suspicious/noExplicitAny: forwarded verbatim to Prisma's typed prepareQuery
    return prepareQuery(runtime, declaration as any, callback as any);
  }

  async function batch<const T extends readonly BatchOp[]>(
    build: (b: BatchBuilder) => T
  ): Promise<BatchResults<T>> {
    const builder: BatchBuilder = {
      query: (plan) => ({ kind: "query", plan }),
      execute: (plan) => ({ kind: "execute", plan }),
    };
    const ops = build(builder);
    if (ops.length === 0) {
      return [] as unknown as BatchResults<T>;
    }
    const collector = new D1BatchCollector(d1);
    driver.armNextConnection(collector);
    let connection: RuntimeConnection;
    try {
      connection = await runtime.connection(); // acquireConnection() picks up the armed collector
    } finally {
      driver.armNextConnection(undefined);
    }
    try {
      // Run every plan through the normal pipeline (middleware, encode, decode); the collector
      // parks each statement until all are registered, then flushes them in one D1 batch.
      const pending: Promise<unknown>[] = ops.map((op) =>
        op.kind === "query"
          ? connection.query(op.plan).toArray()
          : connection.execute(op.plan)
      );
      // A plan that settles BEFORE the flush never reached the driver (e.g. a middleware's
      // interceptQuery answered it), so it stops counting towards the statements we wait for.
      let flushed = false;
      let answeredWithoutDriver = 0;
      for (const p of pending) {
        p.then(
          () => {
            if (!flushed) {
              answeredWithoutDriver++;
              collector.poke();
            }
          },
          () => {} // rejections surface via failedEarly / Promise.all below
        );
      }
      const failedEarly = Promise.race(
        pending.map((p) =>
          p.then(
            () =>
              new Promise<never>(() => {
                /* A successful plan never wins the early-failure race. */
              })
          )
        )
      );
      await Promise.race([
        collector.waitFor(() => ops.length - answeredWithoutDriver),
        failedEarly,
      ]);
      flushed = true;
      await collector.flush();
      return (await Promise.all(pending)) as unknown as BatchResults<T>;
    } catch (error) {
      collector.rejectAll(error);
      throw error;
    } finally {
      await connection.release();
    }
  }

  const transaction = ((fn: (tx: unknown) => PromiseLike<unknown>) => {
    if (!options.pseudoTransactions) {
      return Promise.reject(interactiveTransactionUnsupported());
    }
    return withTransaction(runtime, (txCtx) => {
      const txOrm = unbound(
        orm({
          context,
          runtime: {
            query: (plan) => txCtx.query(plan),
            execute: (plan) => txCtx.execute(plan),
          },
        })
      );
      return fn(
        Object.assign(Object.create(txCtx), {
          sql: parts.sql,
          orm: txOrm,
          enums: parts.enums,
        })
      );
    });
  }) as Base<C>["transaction"];

  return {
    sql: parts.sql as Base<C>["sql"],
    orm: ormClient,
    enums: parts.enums as Base<C>["enums"],
    raw: parts.raw as Base<C>["raw"],
    context: context as Base<C>["context"],
    contract: parts.contract as C,
    d1,
    runtime: () => runtime,
    prepare: prepare as Base<C>["prepare"],
    batch,
    transaction,
    close: () => Promise.resolve(),
  };
}
