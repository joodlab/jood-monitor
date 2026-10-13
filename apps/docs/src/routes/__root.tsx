import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type { ReactNode } from "react";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    links: [
      { href: styles, rel: "stylesheet" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { content: "Jood Monitor documentation", name: "description" },
      { title: "Jood Monitor docs" },
    ],
  }),
  shellComponent: Document,
});

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <RootProvider>{children}</RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
