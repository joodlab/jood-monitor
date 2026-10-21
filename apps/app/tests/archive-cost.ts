import { expiredArchives } from "../src/data-access/clusters";
import { getDb } from "../src/db";

export async function archiveCost(binding: D1Database) {
  let rowsRead = 0;
  const measured = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          let statement = target.prepare(sql);
          const proxy: D1PreparedStatement = new Proxy(statement, {
            get(_target, key) {
              if (key === "bind") {
                return (...values: unknown[]) => {
                  statement = statement.bind(...values);
                  return proxy;
                };
              }
              if (key === "all") {
                return async () => {
                  const result = await statement.all();
                  rowsRead += result.meta.rows_read;
                  return result;
                };
              }
              const value = Reflect.get(statement, key);
              return typeof value === "function"
                ? value.bind(statement)
                : value;
            },
          });
          return proxy;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await binding.batch(
    Array.from({ length: 100 }, (_, index) =>
      binding
        .prepare(
          "INSERT INTO \"Archive\"(id,clusterId,kind,entityUid,sourceStart,sourceEnd,objectKey,contentHash,receivedAt,expiresAt,points) VALUES(?,'cost-only','raw','synthetic','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',?,'synthetic','2026-01-01T00:00:00Z','2100-01-01T00:00:00Z',1)"
        )
        .bind(`synthetic-expiry-${index}`, `synthetic-expiry-${index}`)
    )
  );
  try {
    const rows = await expiredArchives(
      getDb(measured),
      "2000-01-01T00:00:00Z",
      "cost-only"
    );
    return { rows: rows.length, rowsRead };
  } finally {
    await binding
      .prepare("DELETE FROM \"Archive\" WHERE clusterId='cost-only'")
      .run();
  }
}
