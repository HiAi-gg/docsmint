# DeepSeek Harness integration

Status: release candidate under review. Registry publication and live Harness
acceptance are separate gates; neither is established by the simulated tests.

The package is `@hiai-gg/dsh-docsmint`, maintained in `packages/dsh-plugin`.
It has an independent version and `dsh-plugin-v*` release tags. Installing it does
not upgrade the DocsMint server or SDK.

## Installation after candidate publication

```sh
dsh plugin --profile docsmint-release-qa add @hiai-gg/dsh-docsmint@1.0.0-rc.1
dsh --profile docsmint-release-qa --dump-config
dsh --profile docsmint-release-qa
```

Use an isolated profile for acceptance. Keep existing profiles and credentials.
Cloud MCP uses OAuth discovery, DCR and PKCE S256. Self-hosted MCP uses a scoped
Bearer key and requires that the actual instance exposes authenticated POST /mcp.
The presence of transport source in SDK 2.1.0 does not prove a deployment is ready.
Stateless DocsMint does not expose a persistent GET SSE stream.

## Compatibility and data

The initial target is Harness 0.2.1-rc.5, Node 22 and 24, and SDK 2.1.0-compatible
DocsMint endpoints. New release claims require actual CI and live evidence.
The panel requests category/folder/workspace filters and sorting from the server
before pagination. Tool names and mode/action/view/kind branches remain unchanged.
MCP envelopes remain supported; structuredContent is preferred over duplicate text.

## Credentials and privacy

Secrets belong to the Harness credential store, not the browser panel or published
package. Without a writable store, saving credentials must fail clearly. Existing
explicit environment/configuration integration is documented separately in the
package README and must not be confused with secure persisted panel storage.
No telemetry is added by this integration. OAuth requires intentional requests to
the configured authorization server, including discovery and registration.

## Upgrade and removal

Install a specific newer version with the same profile-scoped add command.
Remove the bundle with:

```sh
dsh plugin --profile docsmint-release-qa remove @hiai-gg/dsh-docsmint
```

Uninstalling a bundle does not delete DocsMint documents or revoke unrelated
ChatGPT/owner connections. Disconnect only the plugin's own authorization when
needed. Restore the previous package version if a candidate fails acceptance.

## Publication

Normal package tests run on Node 22 and 24. A dsh-plugin-v* tag publishes this
independent package to npm through OIDC after those tests pass. No GitHub
environment, required reviewer, separate certification or live acceptance gate
is used. Prereleases use next; stable versions use latest.

For first publication the package owner completes npm login and 2FA. Once the
package exists, configure npm trusted publishing for HiAi-gg/docsmint and
dsh-plugin.yml with the environment field left empty. No permanent token is needed.
Existing user Harness use is accepted; another live acceptance cycle is not required.

Published versions stay immutable. Use a new version to correct a release.
