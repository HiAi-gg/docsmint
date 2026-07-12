import { describe, expect, test } from "bun:test";
import {
	documentReferencesAttachment,
	documentReferencesRemoteImage,
	verifyShareScopePassword,
} from "../lib/share-access";

describe("legacy duplicated attachment references", () => {
	test("matches only an exact protected attachment URL", () => {
		expect(
			documentReferencesAttachment(
				{
					contentJson: {
						attrs: { src: "/api/attachments/attachment-id/raw" },
					},
				},
				"attachment-id",
			),
		).toBe(true);
		expect(
			documentReferencesAttachment(
				{ content: "/api/attachments/different-id/raw" },
				"attachment-id",
			),
		).toBe(false);
	});
});

describe("verifyShareScopePassword", () => {
	test("requires and verifies passwords only for protected shares", async () => {
		expect(await verifyShareScopePassword({ passwordHash: null }, null)).toBe(
			true,
		);
		expect(
			await verifyShareScopePassword(
				{ passwordHash: "hash" },
				null,
				async () => true,
			),
		).toBe(false);
		expect(
			await verifyShareScopePassword(
				{ passwordHash: "hash" },
				"wrong",
				async () => false,
			),
		).toBe(false);
		expect(
			await verifyShareScopePassword(
				{ passwordHash: "hash" },
				"correct",
				async () => true,
			),
		).toBe(true);
	});
});

describe("documentReferencesRemoteImage", () => {
	const source = "https://images.example.test/photo.png";

	test("matches exact image nodes and Markdown destinations", () => {
		expect(
			documentReferencesRemoteImage(
				{ contentJson: { type: "image", attrs: { src: source } } },
				source,
			),
		).toBe(true);
		expect(
			documentReferencesRemoteImage({ content: `![photo](${source})` }, source),
		).toBe(true);
	});

	test("does not authorize plain text or substring lookalikes", () => {
		expect(
			documentReferencesRemoteImage(
				{ content: `Mention ${source} here` },
				source,
			),
		).toBe(false);
		expect(
			documentReferencesRemoteImage(
				{ content: `![photo](${source}?attacker=1)` },
				source,
			),
		).toBe(false);
	});
});
