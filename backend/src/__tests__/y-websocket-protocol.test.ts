import { expect, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
	createInitialMessages,
	handleYWebSocketMessage,
	MESSAGE_SYNC,
} from "../lib/y-websocket-protocol";

function syncStep1(doc: Y.Doc): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	syncProtocol.writeSyncStep1(encoder, doc);
	return encoding.toUint8Array(encoder);
}

test("answers a y-websocket sync step and synchronizes two documents", () => {
	const server = new Y.Doc();
	server.getText("note").insert(0, "hello");
	const client = new Y.Doc();
	const awareness = new Awareness(server);
	const response = handleYWebSocketMessage(
		server,
		awareness,
		syncStep1(client),
		"client-a",
	);
	expect(response.reply).toBeDefined();
	if (!response.reply) throw new Error("Expected sync reply");
	const decoder = decoding.createDecoder(response.reply);
	expect(decoding.readVarUint(decoder)).toBe(MESSAGE_SYNC);
	const sink = encoding.createEncoder();
	syncProtocol.readSyncMessage(decoder, sink, client, "server");
	expect(client.getText("note").toString()).toBe("hello");
});

test("initial handshake is binary y-websocket sync plus awareness query response", () => {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	const messages = createInitialMessages(doc, awareness);
	expect(messages.length).toBe(3);
	for (const message of messages) expect(message).toBeInstanceOf(Uint8Array);
});

test("room keys isolate personal users and workspaces for the same document", async () => {
	const { createYjsRoomKey } = await import("../lib/collaboration-room-key");
	const personalA = createYjsRoomKey({ documentId: "doc", userId: "user-a" });
	const personalB = createYjsRoomKey({ documentId: "doc", userId: "user-b" });
	const workspaceA = createYjsRoomKey({
		documentId: "doc",
		userId: "user-a",
		workspaceId: "workspace-a",
	});
	const workspaceB = createYjsRoomKey({
		documentId: "doc",
		userId: "user-a",
		workspaceId: "workspace-b",
	});
	expect(new Set([personalA, personalB, workspaceA, workspaceB]).size).toBe(4);
});
