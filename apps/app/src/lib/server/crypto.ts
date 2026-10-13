import { createHash, timingSafeEqual } from "node:crypto";

export function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function secretMatches(actual: string, expected: string) {
  return timingSafeEqual(
    Buffer.from(hash(actual)),
    Buffer.from(hash(expected))
  );
}

export function token() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "hex"
  );
}
