import "@fontsource-variable/geist";
import { TooltipProvider } from "@jood-monitor/ui/tooltip";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { formDevtoolsPlugin } from "@tanstack/react-form-devtools";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import styles from "../styles.css?url";
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Jood Monitor" },
      ],
      links: [
        { rel: "stylesheet", href: styles },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      ],
    }),
    component: Root,
    shellComponent: Document,
  }
);
function Root() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
      {import.meta.env.DEV && (
        <>
          <ReactQueryDevtools />
          <TanStackRouterDevtools />
          <TanStackDevtools plugins={[formDevtoolsPlugin()]} />
        </>
      )}
    </QueryClientProvider>
  );
}
function Document({ children }: { children: ReactNode }) {
  return (
    <html className="dark" lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
