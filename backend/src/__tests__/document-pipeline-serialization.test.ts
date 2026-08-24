import { describe, expect, test } from "bun:test";
import {
	documentPipelineLockIdentity,
	documentPipelineLockKey,
} from "../lib/document-pipeline-serialization";

describe("document pipeline serialization", () => {
	test("derives stable unambiguous per-document lock identities", () => {
		const first = "00000000-0000-4000-8000-000000000001";
		const second = "00000000-0000-4000-8000-000000000002";

		expect(documentPipelineLockIdentity(first)).toBe(
			'["docsmint:document-pipeline:v1","00000000-0000-4000-8000-000000000001"]',
		);
		expect(documentPipelineLockKey(first)).toBe(6088401783718103163n);
		expect(documentPipelineLockKey(first)).not.toBe(
			documentPipelineLockKey(second),
		);
	});
});
