import { describe, expect, test } from "bun:test";
import { z } from "zod";

// ============================================
// Document schemas (from api/routes/documents.ts)
// ============================================

const createDocumentSchema = z.object({
	title: z.string().min(1).max(500).default("Untitled"),
	content: z.string().optional(),
	folderId: z.string().uuid().optional(),
});

const updateDocumentSchema = z.object({
	title: z.string().min(1).max(500).optional(),
	content: z.string().optional(),
	contentJson: z.unknown().optional(),
	metadata: z.unknown().optional(),
	folderId: z.string().uuid().nullable().optional(),
});

const listQuerySchema = z.object({
	folderId: z.string().uuid().optional(),
	tag: z.string().uuid().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ============================================
// Folder schemas (from api/routes/folders.ts)
// ============================================

const createFolderSchema = z.object({
	name: z.string().min(1).max(255),
	parentId: z.string().uuid().optional(),
});

const updateFolderSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	parentId: z.string().uuid().nullable().optional(),
});

// ============================================
// Tag schemas (from api/routes/tags.ts)
// ============================================

const createTagSchema = z.object({
	name: z.string().min(1).max(100),
	color: z.string().max(20).optional(),
});

const updateTagSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	color: z.string().max(20).optional(),
});

const addTagToDocSchema = z.object({
	tagId: z.string().uuid(),
});

// ============================================
// Search schemas (from api/routes/search.ts)
// ============================================

const searchQuerySchema = z.object({
	q: z.string().optional(),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

const suggestQuerySchema = z.object({
	q: z.string().optional(),
});

// ============================================
// Share schemas (from api/routes/share.ts)
// ============================================

const createShareSchema = z
	.object({
		documentId: z.string().uuid().optional(),
		folderId: z.string().uuid().optional(),
		password: z.string().min(1).optional(),
		expiresIn: z.enum(["1h", "1d", "7d", "30d", "never"]).default("never"),
	})
	.refine((d) => d.documentId || d.folderId, {
		message: "Either documentId or folderId must be provided",
	});

const addGuestSchema = z.object({
	email: z.string().email("Invalid email address"),
});

// ============================================
// Tests: Document schemas
// ============================================

describe("createDocumentSchema", () => {
	test("accepts valid input with title and content", () => {
		const result = createDocumentSchema.safeParse({
			title: "Test Doc",
			content: "Hello",
		});
		expect(result.success).toBe(true);
	});

	test("defaults title to 'Untitled' when omitted", () => {
		const result = createDocumentSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.title).toBe("Untitled");
	});

	test("rejects empty title", () => {
		const result = createDocumentSchema.safeParse({ title: "" });
		expect(result.success).toBe(false);
	});

	test("rejects title over 500 characters", () => {
		const result = createDocumentSchema.safeParse({ title: "x".repeat(501) });
		expect(result.success).toBe(false);
	});

	test("accepts title at exactly 500 characters", () => {
		const result = createDocumentSchema.safeParse({ title: "x".repeat(500) });
		expect(result.success).toBe(true);
	});

	test("accepts valid UUID folderId", () => {
		const result = createDocumentSchema.safeParse({
			folderId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid UUID folderId", () => {
		const result = createDocumentSchema.safeParse({ folderId: "not-a-uuid" });
		expect(result.success).toBe(false);
	});

	test("content is optional", () => {
		const result = createDocumentSchema.safeParse({ title: "Doc" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.content).toBeUndefined();
	});
});

describe("updateDocumentSchema", () => {
	test("accepts partial title update", () => {
		const result = updateDocumentSchema.safeParse({ title: "New Title" });
		expect(result.success).toBe(true);
	});

	test("accepts partial content update", () => {
		const result = updateDocumentSchema.safeParse({ content: "new body" });
		expect(result.success).toBe(true);
	});

	test("accepts null folderId (move to root)", () => {
		const result = updateDocumentSchema.safeParse({ folderId: null });
		expect(result.success).toBe(true);
	});

	test("accepts contentJson (rich editor format)", () => {
		const result = updateDocumentSchema.safeParse({
			contentJson: { type: "doc", content: [{ type: "paragraph" }] },
		});
		expect(result.success).toBe(true);
	});

	test("accepts metadata object", () => {
		const result = updateDocumentSchema.safeParse({
			metadata: { key: "value" },
		});
		expect(result.success).toBe(true);
	});

	test("accepts empty object (no fields to update)", () => {
		const result = updateDocumentSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test("rejects empty title when provided", () => {
		const result = updateDocumentSchema.safeParse({ title: "" });
		expect(result.success).toBe(false);
	});

	test("rejects title over 500 characters", () => {
		const result = updateDocumentSchema.safeParse({ title: "x".repeat(501) });
		expect(result.success).toBe(false);
	});
});

describe("listQuerySchema", () => {
	test("defaults page to 1 and limit to 20", () => {
		const result = listQuerySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.page).toBe(1);
			expect(result.data.limit).toBe(20);
		}
	});

	test("coerces string page to number", () => {
		const result = listQuerySchema.safeParse({ page: "3" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.page).toBe(3);
	});

	test("coerces string limit to number", () => {
		const result = listQuerySchema.safeParse({ limit: "50" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.limit).toBe(50);
	});

	test("rejects page < 1", () => {
		const result = listQuerySchema.safeParse({ page: 0 });
		expect(result.success).toBe(false);
	});

	test("rejects limit > 100", () => {
		const result = listQuerySchema.safeParse({ limit: 101 });
		expect(result.success).toBe(false);
	});

	test("rejects limit < 1", () => {
		const result = listQuerySchema.safeParse({ limit: 0 });
		expect(result.success).toBe(false);
	});

	test("accepts limit at boundary 100", () => {
		const result = listQuerySchema.safeParse({ limit: 100 });
		expect(result.success).toBe(true);
	});

	test("accepts valid folderId filter", () => {
		const result = listQuerySchema.safeParse({
			folderId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("accepts valid tag filter", () => {
		const result = listQuerySchema.safeParse({
			tag: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid folderId UUID", () => {
		const result = listQuerySchema.safeParse({ folderId: "bad" });
		expect(result.success).toBe(false);
	});
});

// ============================================
// Tests: Folder schemas
// ============================================

describe("createFolderSchema", () => {
	test("requires name", () => {
		const result = createFolderSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("rejects empty name", () => {
		const result = createFolderSchema.safeParse({ name: "" });
		expect(result.success).toBe(false);
	});

	test("rejects name over 255 characters", () => {
		const result = createFolderSchema.safeParse({ name: "x".repeat(256) });
		expect(result.success).toBe(false);
	});

	test("accepts name at exactly 255 characters", () => {
		const result = createFolderSchema.safeParse({ name: "x".repeat(255) });
		expect(result.success).toBe(true);
	});

	test("accepts valid input with name only", () => {
		const result = createFolderSchema.safeParse({ name: "My Folder" });
		expect(result.success).toBe(true);
	});

	test("accepts valid parentId UUID", () => {
		const result = createFolderSchema.safeParse({
			name: "Subfolder",
			parentId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid parentId UUID", () => {
		const result = createFolderSchema.safeParse({
			name: "Sub",
			parentId: "not-uuid",
		});
		expect(result.success).toBe(false);
	});
});

describe("updateFolderSchema", () => {
	test("accepts partial name update", () => {
		const result = updateFolderSchema.safeParse({ name: "Renamed" });
		expect(result.success).toBe(true);
	});

	test("accepts null parentId (move to root)", () => {
		const result = updateFolderSchema.safeParse({ parentId: null });
		expect(result.success).toBe(true);
	});

	test("accepts empty object (no-op)", () => {
		const result = updateFolderSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	test("rejects empty name", () => {
		const result = updateFolderSchema.safeParse({ name: "" });
		expect(result.success).toBe(false);
	});
});

// ============================================
// Tests: Tag schemas
// ============================================

describe("createTagSchema", () => {
	test("requires name", () => {
		const result = createTagSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("rejects empty name", () => {
		const result = createTagSchema.safeParse({ name: "" });
		expect(result.success).toBe(false);
	});

	test("rejects name over 100 characters", () => {
		const result = createTagSchema.safeParse({ name: "x".repeat(101) });
		expect(result.success).toBe(false);
	});

	test("accepts name at exactly 100 characters", () => {
		const result = createTagSchema.safeParse({ name: "x".repeat(100) });
		expect(result.success).toBe(true);
	});

	test("accepts optional color", () => {
		const result = createTagSchema.safeParse({
			name: "important",
			color: "#ff0000",
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.color).toBe("#ff0000");
	});

	test("color is undefined when omitted", () => {
		const result = createTagSchema.safeParse({ name: "tag" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.color).toBeUndefined();
	});

	test("rejects color over 20 characters", () => {
		const result = createTagSchema.safeParse({
			name: "tag",
			color: "x".repeat(21),
		});
		expect(result.success).toBe(false);
	});
});

describe("updateTagSchema", () => {
	test("accepts partial name update", () => {
		const result = updateTagSchema.safeParse({ name: "new-name" });
		expect(result.success).toBe(true);
	});

	test("accepts partial color update", () => {
		const result = updateTagSchema.safeParse({ color: "#00ff00" });
		expect(result.success).toBe(true);
	});

	test("accepts empty object (no-op)", () => {
		const result = updateTagSchema.safeParse({});
		expect(result.success).toBe(true);
	});
});

describe("addTagToDocSchema", () => {
	test("requires tagId", () => {
		const result = addTagToDocSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("rejects non-UUID tagId", () => {
		const result = addTagToDocSchema.safeParse({ tagId: "not-uuid" });
		expect(result.success).toBe(false);
	});

	test("accepts valid UUID tagId", () => {
		const result = addTagToDocSchema.safeParse({
			tagId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});
});

// ============================================
// Tests: Search schemas
// ============================================

describe("searchQuerySchema", () => {
	test("q is optional (defaults to undefined)", () => {
		const result = searchQuerySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.q).toBeUndefined();
	});

	test("accepts search query string", () => {
		const result = searchQuerySchema.safeParse({ q: "hello world" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.q).toBe("hello world");
	});

	test("defaults page and limit", () => {
		const result = searchQuerySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.page).toBe(1);
			expect(result.data.limit).toBe(20);
		}
	});

	test("coerces string page to number", () => {
		const result = searchQuerySchema.safeParse({ q: "test", page: "2" });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.page).toBe(2);
	});

	test("rejects page < 1", () => {
		const result = searchQuerySchema.safeParse({ page: 0 });
		expect(result.success).toBe(false);
	});

	test("rejects limit > 100", () => {
		const result = searchQuerySchema.safeParse({ limit: 101 });
		expect(result.success).toBe(false);
	});
});

describe("suggestQuerySchema", () => {
	test("q is optional", () => {
		const result = suggestQuerySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.q).toBeUndefined();
	});

	test("accepts query string", () => {
		const result = suggestQuerySchema.safeParse({ q: "hello" });
		expect(result.success).toBe(true);
	});
});

// ============================================
// Tests: Share schemas
// ============================================

describe("createShareSchema", () => {
	test("accepts documentId with default expiresIn", () => {
		const result = createShareSchema.safeParse({
			documentId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.expiresIn).toBe("never");
		}
	});

	test("accepts folderId", () => {
		const result = createShareSchema.safeParse({
			folderId: "550e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("accepts both documentId and folderId", () => {
		const result = createShareSchema.safeParse({
			documentId: "550e8400-e29b-41d4-a716-446655440000",
			folderId: "660e8400-e29b-41d4-a716-446655440000",
		});
		expect(result.success).toBe(true);
	});

	test("rejects when neither documentId nor folderId provided", () => {
		const result = createShareSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("accepts valid expiresIn values", () => {
		for (const exp of ["1h", "1d", "7d", "30d", "never"]) {
			const result = createShareSchema.safeParse({
				documentId: "550e8400-e29b-41d4-a716-446655440000",
				expiresIn: exp,
			});
			expect(result.success).toBe(true);
		}
	});

	test("rejects invalid expiresIn value", () => {
		const result = createShareSchema.safeParse({
			documentId: "550e8400-e29b-41d4-a716-446655440000",
			expiresIn: "2d",
		});
		expect(result.success).toBe(false);
	});

	test("accepts optional password", () => {
		const result = createShareSchema.safeParse({
			documentId: "550e8400-e29b-41d4-a716-446655440000",
			password: "secret123",
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.password).toBe("secret123");
	});

	test("rejects empty password", () => {
		const result = createShareSchema.safeParse({
			documentId: "550e8400-e29b-41d4-a716-446655440000",
			password: "",
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid documentId UUID", () => {
		const result = createShareSchema.safeParse({ documentId: "bad-uuid" });
		expect(result.success).toBe(false);
	});
});

describe("addGuestSchema", () => {
	test("accepts valid email", () => {
		const result = addGuestSchema.safeParse({ email: "user@example.com" });
		expect(result.success).toBe(true);
	});

	test("rejects invalid email", () => {
		const result = addGuestSchema.safeParse({ email: "not-an-email" });
		expect(result.success).toBe(false);
	});

	test("requires email field", () => {
		const result = addGuestSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});
