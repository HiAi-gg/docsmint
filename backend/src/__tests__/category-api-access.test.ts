import { describe, expect, test } from "bun:test";
import { buildApiAccessValues } from "../lib/category-api-access";

describe("category API access PATCH merge", () => {
	const existing = {
		apiMode: "global",
		apiPermissionRead: true,
		apiPermissionEdit: false,
		apiPermissionWrite: true,
	};

	test("keeps omitted permissions and mode from the locked row", () => {
		expect(buildApiAccessValues({ existing })).toEqual({
			apiMode: "global",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
		});
	});

	test("applies only the supplied permission without clearing siblings", () => {
		expect(
			buildApiAccessValues({
				existing,
				apiPermissionEdit: true,
			}),
		).toEqual({
			apiMode: "global",
			apiPermissionRead: true,
			apiPermissionEdit: true,
			apiPermissionWrite: true,
		});
	});

	test("turning the mode off zeros every permission", () => {
		expect(
			buildApiAccessValues({
				existing,
				apiMode: "unavailable",
			}),
		).toEqual({
			apiMode: "unavailable",
			apiPermissionRead: false,
			apiPermissionEdit: false,
			apiPermissionWrite: false,
		});
	});
});
