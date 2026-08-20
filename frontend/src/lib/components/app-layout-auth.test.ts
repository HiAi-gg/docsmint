import { expect, test } from "bun:test";

const source = await Bun.file(
	`${import.meta.dir}/../../routes/(app)/+layout.server.ts`,
).text();

test("all private app routes redirect anonymous requests before mounting sidebar data loaders", () => {
	expect(source).toContain(
		'import { hasSessionCookie } from "$lib/server/session-cookie"',
	);
	expect(source).toContain("hasSessionCookie(cookies)");
	expect(source).toContain('redirect(302, "/login")');
});
