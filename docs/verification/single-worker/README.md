# Single Worker verification

All images and the recording use a local native workerd runtime with a disposable
synthetic workspace and credentials. They contain no production telemetry.

The production bundle serves the authenticated dashboard and operator functions,
public Fumadocs pages, the bounded documentation page loader and search in one
Worker. Native acceptance covers unauthenticated denials, CSRF, validated D1
writes, MDX SSR, search, client-navigation data and missing pages. Telemetry's
native durability and storage tests also pass.

Browser verification covered documentation links and search, the Dashboard link
opening an authenticated document, the existing dark theme, and 1440 px desktop
and 390 px mobile layouts without horizontal overflow. The authenticated
dashboard document had no browser errors. The empty fleet is synthetic; it is
not evidence of production ingestion. No topology behavior changes in this PR.

- [Desktop docs](docs-desktop.png)
- [Mobile docs](docs-mobile.png)
- [Documentation search](docs-search.png)
- [Synthetic mobile dashboard](dashboard-mobile.png)
- [Docs navigation and search recording](docs-navigation.webm)

Billing analytics, account settings, backups and live resource-retirement
receipts remain private. Local checks do not establish a Free-plan guarantee.
