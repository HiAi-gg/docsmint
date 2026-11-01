# DocsMint local deepmerge security fork

This MIT-preserving local fork uses the integrity-checked npm deepmerge 4.3.1
CommonJS bundle and its original types. It is not an upstream release or an audit
certification. PROVENANCE.json records its source; source.patch is the exact diff.

The original guard checks the input target, but writes into a new ordinary output
object. A null-prototype target or an own enumerable __proto__ target property can
activate the output object's inherited setter. All three output writes now define
own enumerable, writable, configurable data properties. The API, cloning choices,
arrays, symbols, custom merge callbacks and propertyIsUnsafe guard are retained.

The root override selects this fork for both Svelte Vite and Workbox/Rollup paths.
Docker install/build/runtime stages must carry the vendor tree. package.public.json
intentionally has no file override: this does not patch independent consumers'
build toolchains. No npm package named deepmerge 4.3.2 is being published.

Run bun test scripts/deepmerge-security.test.ts. The original bundle is retained
only as a test fixture, outside the vendor package/Docker copies, to prove the
reported defect. Upstream JS tests from tag v4.3.1 were also run against the patched
entrypoint in an isolated test fixture. Remove this fork after an upstream fix,
then repeat the security/API, container and clean consumer gates.
