import { describe, expect, test } from "bun:test";
import { withSearchPath } from "./search-path";

describe("withSearchPath", () => {
	test("appends options to a URL with no query string", () => {
		const url = "postgresql://aiuser:changeme@localhost:5433/hiai_docs";
		const result = withSearchPath(url);
		expect(result.startsWith(url + "?")).toBe(true);
		expect(result).toContain("options=");
		// libpq parses options as space-separated argv; we use the
		// no-space form `-csearch_path=...` to avoid leaving stray tokens.
		expect(decodeURIComponent(result)).toContain(
			"-csearch_path=public,ag_catalog",
		);
	});

	test("appends options to a URL that already has query params", () => {
		const url =
			"postgresql://aiuser:changeme@localhost:5433/hiai_docs?sslmode=require";
		const result = withSearchPath(url);
		expect(result.startsWith(url + "&")).toBe(true);
		expect(result).toContain("sslmode=require");
		expect(result).toContain("options=");
	});

	test("merges when options already present", () => {
		const url = "postgresql://user:pass@host/db?options=-cfoo%3Dbar";
		const result = withSearchPath(url);
		const u = new URL(result);
		const opts = u.searchParams.get("options");
		expect(opts).toContain("-cfoo=bar");
		expect(opts).toContain("-csearch_path=public,ag_catalog");
	});

	test("replaces an existing -c search_path (with space)", () => {
		const url =
			"postgresql://user:pass@host/db?options=-c%20search_path%3Dag_catalog%2Cpublic";
		const result = withSearchPath(url);
		const u = new URL(result);
		const opts = u.searchParams.get("options");
		expect(opts).not.toMatch(/-c\s*search_path\s*=\s*ag_catalog/i);
		expect(opts).toContain("-csearch_path=public,ag_catalog");
	});

	test("replaces an existing -csearch_path (no space)", () => {
		const url =
			"postgresql://user:pass@host/db?options=-csearch_path%3Dag_catalog%2Cpublic";
		const result = withSearchPath(url);
		const u = new URL(result);
		const opts = u.searchParams.get("options");
		expect(opts).not.toMatch(/-csearch_path\s*=\s*ag_catalog/i);
		expect(opts).toContain("-csearch_path=public,ag_catalog");
	});

	test("preserves URL fragment", () => {
		const url = "postgresql://user:pass@host/db#section";
		const result = withSearchPath(url);
		expect(result.endsWith("#section")).toBe(true);
	});

	test("respects SEARCH_PATH_OVERRIDE=0", () => {
		const prev = process.env.SEARCH_PATH_OVERRIDE;
		process.env.SEARCH_PATH_OVERRIDE = "0";
		try {
			const url = "postgresql://user:pass@host/db";
			expect(withSearchPath(url)).toBe(url);
		} finally {
			if (prev === undefined) delete process.env.SEARCH_PATH_OVERRIDE;
			else process.env.SEARCH_PATH_OVERRIDE = prev;
		}
	});

	test("returns input unchanged on empty URL", () => {
		expect(withSearchPath("")).toBe("");
	});

	test("output value is space-free (libpq argv safe)", () => {
		const url = "postgresql://user:pass@host/db";
		const u = new URL(withSearchPath(url));
		const opts = u.searchParams.get("options");
		expect(opts).not.toMatch(/\s/);
	});
});