# Third-party notices

Jood Monitor's original application and agent code is licensed under MIT.
Its dependencies retain their respective licenses.

OpenTelemetry protocol definitions in `contracts/proto` and generated TypeScript
bindings in `apps/app/src/contracts/generated` are derived from
[OpenTelemetry Proto v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0),
copyright OpenTelemetry Authors, licensed under Apache-2.0. The license is included
at `contracts/proto/LICENSE`, and generated files retain their copyright notices.

The Prisma runtime packages are Apache-2.0. The application uses their published
facade modules with a D1 driver adapted from JoodLab's HR-Hajj project. HR-Hajj and
Keenpix inform the project conventions; Keenpix application code is not included.

React and TanStack packages use MIT licenses. Fumadocs is MIT licensed.
Kubernetes Go client libraries use Apache-2.0. Consult the lockfiles and installed
packages for each dependency's complete license and notices.

The bundled Geist variable font is distributed under the SIL Open Font License
1.1. Its original license is included in `licenses/Geist-OFL.txt`.

Builds include `/third-party-licenses.txt` with original dependency notices.
Go release artifacts also include a consolidated dependency license inventory.
Some build dependencies use MPL-2.0, Python-2.0 or CC-BY-4.0; their notices remain
included. They do not change the license of Jood Monitor's original MIT code.
