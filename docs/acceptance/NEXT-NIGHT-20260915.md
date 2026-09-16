# NEXT-NIGHT-20260915 — docsmint-oss

Date: **2026-09-15** UTC. Worker: grok. Coordinator: Codex.
Project: `docsmint-oss` at `/mnt/data/projects/docsmint-oss`. Worked in the real tree (no worktree, no copy).
Start authorization: `docs/dispatch/next-night-20260915/START_AUTHORIZATION.md` supersedes PAUSED plan text.

Kind: **library**. Not a public website. DNS `docsmint.com` was not changed. DOCSMINT-01 was not mutated. Status for this packet: **review** (not accepted-live).

## Before

| Item | Evidence |
| --- | --- |
| Working tree | Dirty 2026-09-14 tests on stale `review/portfolio-20260913-access-retrieval` @ `e99b34a` (0.8.3). Draft PR [#63](https://github.com/HiAi-gg/docsmint/pull/63) **CONFLICTING** with `main`. |
| `origin/main` | `2e85740` **v0.8.4** (`release: v0.8.4 Cloud MCP onboarding and access verification (#65)`), tag `v0.8.4`. CI on that push: SUCCESS run `34903639911`. |
| 2026-09-14 dirty tests | Identical to `origin/main` (already merged via #65). Preserved on disk at `/tmp/docsmint-oss-preserve-20260915/`, not re-committed. |
| Owner ROADMAP banner | Preserved as uncommitted local dirty on 0.8.4 ROADMAP; not part of this commit. |
| Recorded gaps | Historical CI ordering follow-up; no live rerank / browser / compose / DOCSMINT-01 verify; DNS frozen. |
| Local compose | `docsmint-oss-web-1` healthy on `0.0.0.0:51701`. `docsmint-oss-api-1` restarting (exit 1). postgres/redis/seaweedfs stopped. API env `DATABASE_URL` host=`host.docker.internal:5432`. Operator `.env` sets `DB_PORT=5432` and `STORAGE_PORT=18333` (shared-stack ports). |
| Login interaction (old image) | Desktop/mobile, light/dark. Keyboard fill + Enter. `POST /api/auth/sign-in/email` → **502** `{"error":"Failed to proxy request"}`. UI showed **Invalid email or password**. |

## After

Switched to `review/next-night-20260915` from `origin/main` (`2e85740`). Stale PR #63 left open for coordinator close. Smallest source fix for the reproduced login mislabel:

- `frontend/src/lib/auth/auth-failure-message.ts` maps proxy 502 / `Failed to proxy request` to the network error, and keeps explicit 401 credential copy.
- Login page and registration submission use that helper.
- TDD: missing-module RED, then 8 auth/login/register tests GREEN.

Live retrieval eval (fixture, 12 queries) now has fresh evidence. Compose was **not** started: operator ports collide with shared Postgres/Redis/Seaweed. DOCSMINT-01 and DNS untouched.

## Tasks

| ID | Status | This pass |
| --- | --- | --- |
| DOCSMINT-OSS-T01 | **review** | 0.8.4 already contains 2026-09-14 tenant/access regressions. Reproduced 47/47 auth-tenant tests on `2e85740`. Added login/register 502 mapping. |
| DOCSMINT-OSS-T02 | **review** | Offline baseline nDCG@10 **0.826458** (12 queries). Live rerank `--mode=rerank --live`: nDCG@10 **1.000**, MRR **1.000**, Recall@10 **1.000**, 12/12 queries. |
| DOCSMINT-OSS-T03 | **review** | CLI/SDK public-surface 3/3. `test:package:artifacts` 0. Frontend lint 0, svelte-check 0 errors 0 warnings. No packed tarball (no extra copies). |

Coordinator alone marks **accepted**. This packet is **not** accepted-live.

## Commands and results

Heavy commands used `flock /tmp/portfolio-next-night-heavy.lock` and `TMPDIR=/tmp/docsmint-oss-bun`. `PATH` included `/home/vlgalib/.bun/bin`.

| Command | Exit | Summary |
| --- | --- | --- |
| backend focused auth/tenant 7 files | **0** | 47 pass / 0 fail / 194 expect |
| retrieval-failure-matrix + public-surface + eval-metrics | **0** | 10 pass / 0 fail / 192 expect |
| auth-failure-message.test.ts (RED, missing module) | **1** | Cannot find module `./auth-failure-message` |
| auth-failure + register-submission + login-feedback + autosave | **0** | 16 pass / 0 fail / 42 expect |
| CLI client + SDK public-surface-client | **0** | 3 pass / 0 fail / 13 expect |
| frontend `bun run lint` (after format) | **0** | biome check `src/` |
| frontend `bun run typecheck` | **0** | svelte-check 0 errors, 0 warnings |
| `bun run test:package:artifacts` | **0** | in-place public export files |
| `eval-retrieval.ts --mode=baseline` | **0** | nDCG@10 0.826458, MRR 0.775794, Recall@10 1.0 |
| `eval-retrieval.ts --mode=rerank --live` | **0** | nDCG@10 1.0, MRR 1.0, Recall@10 1.0, 12 queries, p50 480ms, p95 1405ms |

Root `bun run build` (`docker compose build`) was not run locally. GitHub Actions Docker Build & Scan and Clean Bun Consumer on PR #66 cover compose validation, image smoke, and packed-tarball consumer on a clean runner.

## Graphical interaction

Named agent-browser session `dmo-nn15` (namespace `dmo-nn15`) against `http://127.0.0.1:51701` (running `docsmint-web:local`, created 2026-09-04 — **does not include this source fix**).

| Surface | Result |
| --- | --- |
| Desktop 1440×900 light | Login form: Welcome back, email/password, Sign in, Create account. Screenshot `login-desktop-light.png`. |
| Keyboard | Tab + fill `verify@example.test` + Enter. |
| Submit | Network `POST /api/auth/sign-in/email` **502**. Visible alert: Invalid email or password. Screenshot `login-desktop-light-submit.png`. |
| Desktop dark | Theme class `dark` + `prefers-color-scheme: dark`. Screenshot `login-desktop-dark.png`. |
| Mobile 390×844 light/dark | Login usable; PWA install prompt on mobile. Screenshots `login-mobile-light.png`, `login-mobile-dark.png`. |
| Register | Create account form (name/email/password) light mobile + dark desktop. |

HTTP 200 on `/login` is not the proof; the submit path and 502 body are. Console/network logs: `build/next-night-20260915/browser/login-desktop-light.network.txt`.

## GitHub / production (not executed here)

| Step | Status |
| --- | --- |
| Source RC branch `review/next-night-20260915` | Prepared from `origin/main` `2e85740` plus the login 502 mapping. |
| PR [#66](https://github.com/HiAi-gg/docsmint/pull/66) @ `2dd58e9` | CI **SUCCESS** run [35027351003](https://github.com/HiAi-gg/docsmint/actions/runs/35027351003): Lint, Typecheck, Unit & Contract, PostgreSQL integrations, Build Every Workspace + artifact gate, Docker Build & Scan (compose validate, port contract, image smoke), Clean Bun Consumer. Tag/publish jobs skipped on PR (expected). |
| Draft PR #63 | Superseded by merged #65 / v0.8.4. Leave close to coordinator. |
| Merge to `main` / tag / npm / MCP registry | Not done. |
| Hosted `docsmint` submodule pin | Still historical `ecd4274` until the hosted consumer worker verifies. |
| Coolify / DOCSMINT-01 | Not mutated. First-stage production freeze. |
| DNS `docsmint.com` / www | Frozen. Not changed. |

## Remaining blockers

- Local compose must not be started from this operator `.env`: `DB_PORT=5432` and `STORAGE_PORT=18333` collide with shared systemd Postgres and SeaweedFS S3. Recreating API/web would also publish onto those ports.
- Running API container is stale and crash-looping (`ECONNREFUSED 172.17.0.1:5432` in earlier logs). Local `docsmint-web:local` on `:51701` still predates this source fix; do not treat that container as proof of the mapping.
- Local packed-tarball smoke not run in this tree; CI Clean Bun Consumer on PR #66 succeeded.
- In-memory attachment harness still does not evaluate SQL category predicates (0.8.4 policy tests cover the grant).
- Hosted pin / Coolify / npm / tag remain coordinator-owned. This packet is not accepted-live.
- Draft PR #63 is still OPEN and CONFLICTING (superseded by v0.8.4 / #65).

## Follow-up 2026-09-16 (readiness)

Worker: grok. No worktree, no stash pop/drop, no reset. Owner `docs/ROADMAP.md` banner, `TEAM_BACKLOG.md`, and 2026-09-13/14 acceptance files left uncommitted. Stash `next-night-20260915-preserve-owner` untouched.

Audit of PR [#66](https://github.com/HiAi-gg/docsmint/pull/66) @ `1453f44`: mapping source was already correct for the better-fetch object `{ status: 502, statusText: "Bad Gateway", error: "Failed to proxy request" }` (no `message`, which is why the old `result.error.message ?? credential` path lied). Missing was **graphical proof of that source**, because 2026-09-15 screenshots hit the stale `:51701` image.

Concrete follow-up:

- Typed `statusText` on `AuthClientFailure` and added tests for the exact better-fetch 502 object plus status-only 502.
- Built current frontend (`vite build` / adapter-node) and served it on `127.0.0.1:50701` with `API_URL=http://127.0.0.1:50700` (API down). Did not start compose; shared systemd Postgres `:5432` and SeaweedFS S3 `:18333` were not mutated.
- Named agent-browser session `dmo-nn15-fu` (namespace `dmo-nn15-fu`).

| Surface | Result |
| --- | --- |
| Keyboard login submit desktop 1440×900 light | `POST /api/auth/sign-in/email` **502** `{"error":"Failed to proxy request"}`. Visible alert: **Network error. Please check your connection.** Not credential copy. |
| Desktop dark / mobile 390×844 light+dark | Same alert remains. |
| Register mobile light + desktop dark | `POST /api/auth/sign-up/email` **502**. Same network alert. |

Read-only production probe (no SSH writes, no DNS writes): `https://docsmint.com` HTTP/2 **200** via Cloudflare + Caddy (`x-sveltekit-page`, `via: 1.1 Caddy`). `https://www.docsmint.com` **301** → `https://docsmint.com/`. HTTP apex **301** → HTTPS. A/AAAA are Cloudflare anycast (`104.21.54.36`, `172.67.223.30` + `2606:4700:3034::…` / `3037::…`). Inventory: `docsmint.com` is owned, **frozen**, Cloudflare NS; product host is **DOCSMINT-01**, not this OSS tree. `ssh docsmint docker ps` (read-only): SaaS stack healthy including `docsmint-saas-docsmint-oss-api-1`. No production mutation.

HEAD after this follow-up commit is the RC. CI on previous HEAD `1453f44` was SUCCESS run [35028658164](https://github.com/HiAi-gg/docsmint/actions/runs/35028658164) (Lint, Typecheck, Unit & Contract, Postgres integrations, Build, Docker Build & Scan, Clean Bun Consumer).

## Rollback

Revert the follow-up commit, then `2dd58e9` / `1453f44` if the whole RC is rejected. v0.8.4 on `main` (`2e85740`) remains the last published source. No production host or DNS change to roll back. Local owner ROADMAP banner and TEAM_BACKLOG stay uncommitted.

## Old-host disposition

None. This is the OSS library, not a website cutover. Hosted DocsMint remains on DOCSMINT-01 with its own worker/coordinator path. `docsmint.com` DNS/mail records were not changed.

## Next action

Coordinator/Codex: review PR #66 (this follow-up SHA), close superseded draft PR #63, and only then consider merge / hosted submodule pin / Coolify / tag / npm. Do not treat this packet as accepted-live.
