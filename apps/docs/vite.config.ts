import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
export default defineConfig({
  build: { assetsDir: "docs-assets" },
  server: { host: "127.0.0.1", port: 3041, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [
    mdx(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart({ serverFns: { base: "/docs-serverFn" } }),
    react(),
  ],
});

import { cloudflare } from "@cloudflare/vite-plugin";
