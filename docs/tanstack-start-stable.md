# TanStack Start stable migration

Both the monitoring hub (`apps/app`) and Fumadocs Worker (`apps/docs`) pin
`@tanstack/react-start` 1.169.1 and `@tanstack/react-router` 1.170.44. The Router
version matches Start's published dependency; TanStack packages do not share
one version number. Query, Form, Table, Charts and devtools keep their existing
compatible pins.

The dependency migration landed in PR #16. This follow-up corrects Start's hub
entry resolution and strengthens the existing production Worker checks without
replacing that migration or the later domain-routing and archival changes.

Start requires Node.js 22.12 or newer and Vite 8. The full workspace has the
stricter Node ranges `^22.19.0 || ^24.11.0 || >=26.0.0` required by its tooling.
Contributors and CI continue to use Node.js 24 and pnpm 10.30.3. Both apps pin Vite 8.2.1 and
`@vitejs/plugin-react` 6.0.5. The existing Cloudflare Vite adapter accepts Vite
8, and Fumadocs MDX 15.0.10 accepts Vite 8. No Vite downgrade or hosting adapter
change is needed. Keep using the Cloudflare build output and `cf` deployment
scripts.

The hub's Start `server.entry` is `./server.ts`, relative to the default `src`
directory. The previous `./src/server.ts` did not resolve through Start's entry
resolver and could silently select its default entry. Cloudflare's own
`worker.entrypoint` remains `./src/server.ts`, relative to the app root. Keep
these two resolution bases distinct so the hub's Worker wrapper is retained.

## Application contract audit

| Contract in the stable migration guide | Application usage and decision |
| --- | --- |
| `.inputValidator()` | Absent. All eight validated hub/docs server functions already use `.validator()`. |
| Start `useSession` | Absent. The hub uses operator Basic Auth, plus Origin and CSRF checks for writes. No cookie rename, sign-in transition or session library replacement applies. |
| `@tanstack/nitro-v2-vite-plugin` | Absent. Both apps use the existing Cloudflare adapter. |
| Obsolete Start umbrella imports | Absent. The React-specific Start package and server entry remain. |
| `createStartHandler`, `createServerEntry`, `handleStartError` | No direct application calls to these APIs. The hub's custom Worker delegates UI/RPC requests to the built-in server entry; docs use that entry directly. Start handles its own uncaught errors and thrown Responses. |
| Endpoint-specific error responses | The hub dispatches its machine/operator REST API before Start. Its own `apiError` returns explicit JSON Responses with authentication challenges and retry headers. Preserve this separate protocol. |
| Thrown Responses and falsy errors in server functions | Hub functions return data and throw typed errors; docs throw Router `notFound()` and `redirect()`. No function expects a thrown Response or a falsy throw to resolve successfully. |
| Response-helper precedence and valid status range | No application calls to `setResponseStatus` or `setResponseHeader`. Existing API Responses set their own status and headers. |
| Additive cookies | No Start cookie helpers or `Set-Cookie` writes. The hub's security-header wrapper copies the built-in Response headers. |
| Serialized Location, content headers and bodyless statuses | No response helpers used on server functions. Docs navigation uses Router redirects. |
| Missing versus empty request headers | Authentication reads the native `Request.headers`; no `getRequestHeader` calls. Both missing and empty Authorization are denied. |
| Malformed percent encoding | Start now rejects malformed UI/docs paths with 400. Keep the existing REST dispatcher and authentication boundary; test the rejection on authenticated hub requests and public docs requests. |
| Undefined `sendContext` | No application reads `sendContext`. The function middleware explicitly passes `{ env }` through server `context`. |

Router type registration remains in each app's `src/router.tsx`; generated
route trees and Start's SSR integration must still pass generation, type checks,
builds and runtime verification.

## Verification boundaries

Run the standard repository checks and production builds with a frozen lockfile.
Native D1/Durable Object tests cover the storage and machine API separately from
Start's production SSR, server functions and docs navigation. Browser evidence
must use local, clearly labeled synthetic data and exclude credentials.

After building both apps, run `pnpm test:start` for regression coverage against
the actual Cloudflare Worker bundles. It creates isolated synthetic storage and
fresh local credentials, exercises both server-function transports with Start's
serialization plugins, checks SSR, and disposes each Worker before starting the
next. CI runs it after the production builds. Set `START_TEST_PORT=48000` to use
loopback ports 48000 and 48001 on a shared machine. For interactive verification,
run `pnpm test:start --serve`; it keeps both Workers running. Fixture credentials
stay in ignored `apps/app/.tmp` files. Browser checks also verify referenced assets.

A local Worker build or passing CI does not establish deployment, live agent
acceptance, source-value correctness on a real fleet, or provider approval. This
migration does not authorize a production cutover or agent rollout. Docker image
builds remain confined to the existing manual workflow.

Sources: [TanStack's stable migration guide](https://raw.githubusercontent.com/TanStack/router/main/docs/start/framework/react/migrate-from-release-candidate.md),
[server entry and error handling](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point),
[Vite migration guide](https://vite.dev/guide/migration), and the published npm
metadata for the exact pinned package versions.
