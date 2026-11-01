# Local deepmerge remediation

Date: 2026-11-01

Mandatory CI audit identified GHSA-gcqx-w48m-w2h4 in deepmerge 4.3.1, reached via
Svelte Vite and PWA/Workbox/Rollup. Upstream lists no patched npm release.
The upstream defect was reproduced against the integrity-checked npm CommonJS
bundle: a null-prototype target lets an own source __proto__ invoke the setter on
the newly allocated ordinary output object. An own target __proto__ is another path.

The MIT-preserving local fork 4.3.2-docsmint.1 defines own enumerable, writable,
configurable data properties at all three output writes. It retains the upstream
guard, cloning, array and custom-merge decisions. This is an actual code patch,
not an advisory ignore or an official upstream release. Source, integrity, license
and exact diff are retained in vendor/deepmerge.

Validation before CI: the original reproduction failed; seven regression/API and
actual parent-resolution tests passed with 37 assertions; all 117 upstream JS
assertions from tag v4.3.1 passed; the new tests pass strict TypeScript 6. Frozen
Bun lock resolution and unmodified bun audit --production pass with zero findings.
Local validation used Bun 1.4.2; repository CI must independently pass on Bun 1.4.0.

Both vulnerable parent paths resolve the patched bundle. Docker install, build,
migration and runtime stages carry its local dependency target. Full CI, Docker
smoke, clean packed-consumer checks and independent review remain merge gates.
No audit command or vulnerability severity threshold has been weakened.

The Better Auth family is also aligned on the minimum patched 1.7.7. No database
migration, account grant change, SDK publication or Cloud deployment is performed
by this source change. package.public.json has no local file override, and this
patch does not secure independent consumer build toolchains or certify A+ safety.

References:
- https://github.com/advisories/GHSA-gcqx-w48m-w2h4
- https://github.com/TehShrike/deepmerge/tree/v4.3.1
- https://github.com/advisories/GHSA-965c-763c-88jm
- https://github.com/advisories/GHSA-r4xp-prcw-77qf

Remove the local fork after an upstream fixed release is available, retaining the
security tests and repeating every required gate before switching resolution.
