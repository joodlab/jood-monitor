import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-sqlite/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./src/db/contract.prisma",
    db: { connection: "file:./.prisma/scratch.db" },
    migrations: { dir: "src/db/migrations/prisma" },
  }),
});
