import { describe, test, expect } from "bun:test";

describe("database schema", () => {
  test("schema exports all expected tables", async () => {
    const schema = await import("@hiai-docs/db/schema");
    expect(schema.users).toBeDefined();
    expect(schema.sessions).toBeDefined();
    expect(schema.accounts).toBeDefined();
    expect(schema.verifications).toBeDefined();
    expect(schema.documents).toBeDefined();
    expect(schema.folders).toBeDefined();
    expect(schema.tags).toBeDefined();
    expect(schema.documentTags).toBeDefined();
    expect(schema.shareLinks).toBeDefined();
    expect(schema.guestAccess).toBeDefined();
    expect(schema.attachments).toBeDefined();
    expect(schema.versions).toBeDefined();
  });

  test("schema exports relations", async () => {
    const schema = await import("@hiai-docs/db/schema");
    expect(schema.documentRelations).toBeDefined();
    expect(schema.folderRelations).toBeDefined();
    expect(schema.shareLinkRelations).toBeDefined();
    expect(schema.tagRelations).toBeDefined();
    expect(schema.documentTagRelations).toBeDefined();
    expect(schema.guestAccessRelations).toBeDefined();
    expect(schema.attachmentRelations).toBeDefined();
    expect(schema.versionRelations).toBeDefined();
  });
});
