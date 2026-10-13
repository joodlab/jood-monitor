import type { Contract } from "./contract.d";
import contract from "./contract.json";
import { createD1Client, type D1Like } from "./d1-driver";

export type Db = ReturnType<typeof createD1Client<Contract>>;
const clients = new WeakMap<D1Like, Db>();

export function getDb(binding: D1Like): Db {
  let db = clients.get(binding);
  if (!db) {
    db = createD1Client<Contract>(binding, contract);
    clients.set(binding, db);
  }
  return db;
}
