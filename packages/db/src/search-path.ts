/**
 * Inject `options=-csearch_path=public,ag_catalog` into a libpq-style
 * PostgreSQL connection URL so every connection from this process opens
 * with `public` first in `search_path`. Defense-in-depth on top of the
 * `ALTER ROLE aiuser SET search_path` default in postgres/init.sql:
 *   - The role default only takes effect on new connections when the
 *     role setting hasn't been overridden.
 *   - If a future migration creates a new role with a different default,
 *     the URL-level `options` keeps behavior identical.
 *   - If the existing dev DB has shadow tables in `ag_catalog` from a
 *     prior bad init, the URL-level `options` overrides the role default
 *     on every fresh connection — no need to ALTER ROLE on existing DBs
 *     for *new* clients, though we still apply the ALTER ROLE so
 *     psql/CLI tools behave correctly too.
 *
 * IMPORTANT format note: libpq's `options` parameter is parsed as a
 * whitespace-separated argv list, identical to the command line. The
 * PostgreSQL GUC parser splits on the first space after `-c`, so
 * `-c search_path=public,ag_catalog` (with a space) sets `search_path`
 * to `public,ag_catalog` BUT leaves a stray `ag_catalog` token. We use
 * the no-space form `-csearch_path=public,ag_catalog` which is parsed
 * correctly as a single `-c` argument. (We also avoid any internal
 * spaces in the value for the same reason.)
 *
 * Behavior:
 *   - URL has no query string  → `?options=-csearch_path=...`
 *   - URL has query, no `options` → `&options=-csearch_path=...`
 *   - URL has `options=...`   → merge: drop any prior `-c search_path`
 *                               chunks, append ours last (libpq honors
 *                               the last `-c` for any given GUC).
 *   - URL fragment is preserved verbatim.
 *
 * `SEARCH_PATH_OVERRIDE` env var can disable the override (for tests
 * that want the role default).
 */
const DEFAULT_SEARCH_PATH = "public,ag_catalog";
const OPTIONS_KEY = "options";
const FLAG = `-csearch_path=${DEFAULT_SEARCH_PATH}`;

export function withSearchPath(url: string): string {
  if (!url) return url;
  // Allow tests to disable the override.
  if (process.env.SEARCH_PATH_OVERRIDE === "0") return url;

  const hashIdx = url.indexOf("#");
  const fragment = hashIdx >= 0 ? url.slice(hashIdx) : "";
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;

  const qIdx = base.indexOf("?");
  if (qIdx < 0) {
    return `${base}?${OPTIONS_KEY}=${FLAG}${fragment}`;
  }

  const query = base.slice(qIdx + 1);
  const prefix = base.slice(0, qIdx);
  const params = new URLSearchParams(query);

  // If `options` is already set, append our override last. libpq honors
  // the last `-c` for any given GUC. Strip out any prior `-c
  // search_path=...` chunks first so we don't leave a stale
  // `ag_catalog` first that overrides our `public` first.
  const existing = params.get(OPTIONS_KEY);
  if (existing) {
    const cleaned = existing
      .replace(/-c\s*search_path\s*=\s*"[^"]*"/gi, "")
      .replace(/-c\s*search_path\s*=\s*'[^']*'/gi, "")
      .replace(/-csearch_path\s*=\s*"[^"]*"/gi, "")
      .replace(/-csearch_path\s*=\s*'[^']*'/gi, "")
      .replace(/-c\s*search_path\s*=\s*[^\s'"]+/gi, "")
      .replace(/-csearch_path\s*=\s*[^\s'"]+/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const merged = cleaned ? `${cleaned} ${FLAG}` : FLAG;
    params.set(OPTIONS_KEY, merged);
  } else {
    params.set(OPTIONS_KEY, FLAG);
  }

  return `${prefix}?${params.toString()}${fragment}`;
}