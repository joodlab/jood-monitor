import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
export default defineConfig({
  server: { host: "127.0.0.1", port: 3040, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    ...(process.env.NODE_ENV === "development" ? [devtools()] : []),
    mdx(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({ server: { entry: "./server.ts" } }),
    react(),
  ],
});

import { cloudflare } from "@cloudflare/vite-plugin";
