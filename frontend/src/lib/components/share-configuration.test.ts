import { describe, expect, test } from "bun:test";
import {
	buildShareLinkRequest,
	shareAccessModesForDisplay,
} from "./share-configuration";

describe("share configuration", () => {
	test("renders only the public option for standalone callers", () => {
		expect(shareAccessModesForDisplay("standalone")).toEqual(["public"]);
		expect(shareAccessModesForDisplay("host-managed")).toEqual([
			"public",
			"restricted",
		]);
	});

	test("maps a host-managed restricted link with password, expiry, and guests", () => {
		expect(
			buildShareLinkRequest({
				displayMode: "host-managed",
				documentId: "document-id",
				folderId: "",
				categoryId: "",
				usePassword: true,
				password: "eight-char-password",
				expiresIn: "30d",
				accessMode: "restricted",
				allowPasswordFallback: true,
				guests: [{ email: "reader@example.com", role: "viewer" }],
			}),
		).toEqual({
			documentId: "document-id",
			folderId: undefined,
			categoryId: undefined,
			password: "eight-char-password",
			expiresIn: "30d",
			accessMode: "restricted",
			allowPasswordFallback: true,
			guests: [{ email: "reader@example.com", role: "viewer" }],
		});
	});

	test("forces standalone requests to public links without restricted guests", () => {
		expect(
			buildShareLinkRequest({
				displayMode: "standalone",
				documentId: "document-id",
				folderId: "",
				categoryId: "",
				usePassword: true,
				password: "eight-char-password",
				expiresIn: "7d",
				accessMode: "restricted",
				allowPasswordFallback: true,
				guests: [{ email: "reader@example.com", role: "viewer" }],
			}),
		).toEqual({
			documentId: "document-id",
			folderId: undefined,
			categoryId: undefined,
			password: "eight-char-password",
			expiresIn: "7d",
			accessMode: "public",
			allowPasswordFallback: undefined,
			guests: undefined,
		});
	});
});
