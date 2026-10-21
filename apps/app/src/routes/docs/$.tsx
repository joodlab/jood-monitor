import { createFileRoute, notFound } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { Suspense } from "react";
import { getMDXComponents } from "@/components/docs-mdx";
import { loadDocsPage, type source } from "@/docs-source";

interface DocsData {
  description?: string;
  pageTree: Awaited<ReturnType<typeof source.serializePageTree>>;
  path: string;
  title: string;
}

const loadPage = createIsomorphicFn()
  .server(loadDocsPage)
  .client(async (slugs: string[]): Promise<DocsData> => {
    const query = new URLSearchParams({ path: slugs.join("/") });
    const response = await fetch(`/api/docs/page?${query}`);
    if (response.status === 404) {
      throw notFound();
    }
    if (!response.ok) {
      throw new Error("Documentation unavailable; retry");
    }
    return response.json();
  });

const content = browserCollections.docs.createClientLoader({
  component({ default: MDX, frontmatter, toc }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export const Route = createFileRoute("/docs/$")({
  component: Docs,
  head: ({ loaderData }: { loaderData?: DocsData }) => ({
    meta: [
      { title: `${loaderData?.title ?? "Jood Monitor"} - Jood Monitor docs` },
      {
        content: loaderData?.description ?? "Jood Monitor documentation",
        name: "description",
      },
    ],
  }),
  loader: async ({ params }) => {
    const data = await loadPage(
      params._splat?.split("/").filter(Boolean) ?? []
    );
    await content.preload(data.path);
    return data;
  },
});

function Docs() {
  const data = Route.useLoaderData() as DocsData;
  const { pageTree, path } = useFumadocsLoader(data);
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout
        links={[
          { text: "Dashboard", url: "/", external: true },
          { text: "GitHub", url: "https://github.com/joodlab/jood-monitor" },
        ]}
        nav={{ title: "Jood Monitor docs", url: "/docs" }}
        themeSwitch={{ enabled: false }}
        tree={pageTree}
      >
        <Suspense>{content.useContent(path)}</Suspense>
      </DocsLayout>
    </RootProvider>
  );
}
