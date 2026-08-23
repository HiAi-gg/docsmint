import { documents, versions } from "@hiai-docs/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Elysia } from "elysia";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Awareness } from "y-protocols/awareness";
import * as awarenessProtocol from "y-protocols/awareness";
import type * as Y from "yjs";
import {
	createYDocFromDocument,
	materializeYDoc,
} from "../../lib/collaboration-document";
import { createYjsRoomKey } from "../../lib/collaboration-room-key";
import { config } from "../../lib/config";
import {
	canAccessContent,
	isAuthorizedCategory,
	resolveContentAccess,
	tenantOwnerCondition,
} from "../../lib/content-access";
import { contentHash } from "../../lib/content-hash";
import {
	invalidateDocCache,
	invalidateDocListCache,
} from "../../lib/doc-cache";
import { logger } from "../../lib/logger";
import { enqueueReembed } from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import {
	createInitialMessages,
	encodeSyncUpdate,
	handleYWebSocketMessage,
	MESSAGE_AWARENESS,
} from "../../lib/y-websocket-protocol";
import {
	acquireYjsRoom,
	releaseYjsRoom,
	subscribeYjsRoom,
	type YjsRoom,
} from "../../lib/yjs-provider";

interface RawCollabWs {
	raw?: {
		send(data: Uint8Array): unknown;
	};
	data?: {
		params?: { documentId?: string };
		query?: Record<string, string>;
		request?: Request;
		headers?: HeadersInit;
	};
	send(data: Uint8Array | string): unknown;
	close(code: number, reason: string): void;
}

interface CollabSession {
	room: YjsRoom;
	socket: RawCollabWs;
	awarenessClientIds: Set<number>;
	assertionDeadlineMs?: number;
	expiryTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new WeakMap<object, CollabSession>();
const pendingMessages = new WeakMap<object, Uint8Array[]>();
const roomSockets = new Map<string, Set<RawCollabWs>>();
const roomBroadcastUnsubscribes = new Map<string, () => void>();
const MAX_PENDING_MESSAGES = 32;
const MAX_PENDING_BYTES = 256 * 1024;

function socketKey(ws: RawCollabWs): object {
	return ws.raw ?? ws;
}

/**
 * Elysia's high-level `ws.send()` serializes object values as JSON. A
 * Uint8Array would therefore become `{"0":0,...}` instead of a binary
 * y-websocket frame. The raw Bun socket preserves the bytes on the wire.
 */
function sendBinary(ws: RawCollabWs, message: Uint8Array): void {
	if (ws.raw) {
		ws.raw.send(message);
		return;
	}
	ws.send(message);
}

function websocketRequest(ws: RawCollabWs): Request {
	const source = ws.data?.request;
	const headers = new Headers(source?.headers ?? ws.data?.headers);
	const token = ws.data?.query?.token;
	if (token) {
		headers.set("authorization", `Bearer ${token}`);
		if (!headers.has("cookie"))
			headers.set("cookie", `better-auth.session_token=${token}`);
	}
	return new Request(source?.url ?? "http://localhost/api/ws/collab", {
		headers,
	});
}

function messageBytes(message: unknown): Uint8Array | null {
	if (message instanceof Uint8Array) return message;
	if (message instanceof ArrayBuffer) return new Uint8Array(message);
	if (Buffer.isBuffer(message)) return new Uint8Array(message);
	return null;
}

function awarenessClientIds(message: Uint8Array): number[] {
	try {
		const outer = decoding.createDecoder(message);
		if (decoding.readVarUint(outer) !== MESSAGE_AWARENESS) return [];
		const update = decoding.createDecoder(decoding.readVarUint8Array(outer));
		const count = decoding.readVarUint(update);
		const ids: number[] = [];
		for (let index = 0; index < count; index += 1) {
			ids.push(decoding.readVarUint(update));
			decoding.readVarUint(update);
			decoding.readVarString(update);
		}
		return ids;
	} catch {
		return [];
	}
}

function awarenessMessage(awareness: Awareness, clients: number[]): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
	encoding.writeVarUint8Array(
		encoder,
		awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
	);
	return encoding.toUint8Array(encoder);
}

function broadcast(
	roomKey: string,
	message: Uint8Array,
	exclude?: RawCollabWs,
): void {
	for (const peer of roomSockets.get(roomKey) ?? []) {
		if (peer !== exclude) sendBinary(peer, message);
	}
}

function processMessage(
	ws: RawCollabWs,
	session: CollabSession,
	bytes: Uint8Array,
): void {
	if (
		session.assertionDeadlineMs !== undefined &&
		Date.now() >= session.assertionDeadlineMs
	) {
		ws.close(1008, "Workspace assertion expired");
		return;
	}
	for (const clientId of awarenessClientIds(bytes))
		session.awarenessClientIds.add(clientId);
	const result = handleYWebSocketMessage(
		session.room.doc,
		session.room.awareness,
		bytes,
		ws,
	);
	if (result.reply) sendBinary(ws, result.reply);
	if (result.broadcast) broadcast(session.room.key, result.broadcast, ws);
}

function queuePendingMessage(key: object, bytes: Uint8Array): void {
	const pending = pendingMessages.get(key) ?? [];
	const pendingBytes = pending.reduce(
		(total, item) => total + item.byteLength,
		0,
	);
	if (
		pending.length >= MAX_PENDING_MESSAGES ||
		pendingBytes + bytes.byteLength > MAX_PENDING_BYTES
	) {
		return;
	}
	pending.push(bytes.slice());
	pendingMessages.set(key, pending);
}

async function authorizeDocument(ws: RawCollabWs, documentId: string) {
	const access = await resolveContentAccess(websocketRequest(ws));
	if (access.ctx.role === "none") throw new Error("Authentication required");
	if (!canAccessContent(access, "edit"))
		throw new Error("Edit permission required");
	const rows = await withTenant(access.ctx, (tx) =>
		tx
			.select({
				id: documents.id,
				ownerId: documents.ownerId,
				workspaceId: documents.workspaceId,
				title: documents.title,
				content: documents.content,
				contentJson: documents.contentJson,
				categoryId: documents.categoryId,
			})
			.from(documents)
			.where(
				and(
					eq(documents.id, documentId),
					tenantOwnerCondition(
						documents.ownerId,
						documents.workspaceId,
						access.ctx,
					),
					isNull(documents.deletedAt),
				),
			)
			.limit(1),
	);
	const document = rows[0];
	if (!document || !isAuthorizedCategory(access, document.categoryId)) {
		throw new Error("Document not found");
	}
	return { access, document };
}

export const collaborationRoutes = new Elysia();

collaborationRoutes.ws("/api/ws/collab/:documentId", {
	open: async (rawWs) => {
		const ws = rawWs as unknown as RawCollabWs;
		const documentId = ws.data?.params?.documentId;
		if (!documentId) return ws.close(1008, "Missing documentId");
		try {
			const { access, document } = await authorizeDocument(ws, documentId);
			const roomKey = createYjsRoomKey({
				documentId,
				userId: access.userId,
				workspaceId: access.ctx.workspaceId,
			});
			const persist = async (doc: Y.Doc) => {
				const materialized = materializeYDoc(doc);
				await withTenant(access.ctx, async (tx) => {
					await tx.insert(versions).values({
						documentId,
						workspaceId: access.ctx.workspaceId,
						content: materialized.content,
						contentJson: materialized.contentJson,
						createdBy: access.userId,
					});
					await tx
						.update(documents)
						.set({
							content: materialized.content,
							contentJson: materialized.contentJson,
							contentHash: contentHash(document.title, materialized.content),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(documents.id, documentId),
								tenantOwnerCondition(
									documents.ownerId,
									documents.workspaceId,
									access.ctx,
								),
							),
						);
				});
				await Promise.all([
					invalidateDocCache(documentId),
					invalidateDocListCache(access.userId),
				]);
				enqueueReembed(
					[
						{
							id: documentId,
							revision: contentHash(document.title, materialized.content),
						},
					],
					access.ctx.workspaceId,
					{ reason: "content", refreshMode: "incremental" },
				);
			};
			const room = await acquireYjsRoom({
				key: roomKey,
				seed: () => createYDocFromDocument(document),
				persist,
			});
			const peers = roomSockets.get(roomKey) ?? new Set<RawCollabWs>();
			peers.add(ws);
			roomSockets.set(roomKey, peers);
			if (!roomBroadcastUnsubscribes.has(roomKey)) {
				roomBroadcastUnsubscribes.set(
					roomKey,
					subscribeYjsRoom(room, (update, origin) => {
						broadcast(
							roomKey,
							encodeSyncUpdate(update),
							origin as RawCollabWs | undefined,
						);
					}),
				);
			}
			const assertionDeadlineMs =
				access.ctx.assertionExpiresAt === undefined
					? undefined
					: (access.ctx.assertionExpiresAt +
							config.DOCSMINT_WORKSPACE_CLOCK_SKEW_SECONDS) *
						1000;
			const session: CollabSession = {
				room,
				socket: ws,
				awarenessClientIds: new Set(),
				assertionDeadlineMs,
			};
			if (assertionDeadlineMs !== undefined) {
				session.expiryTimer = setTimeout(
					() => ws.close(1008, "Workspace assertion expired"),
					Math.max(0, assertionDeadlineMs - Date.now()),
				);
			}
			sessions.set(socketKey(ws), session);
			const pending = pendingMessages.get(socketKey(ws)) ?? [];
			pendingMessages.delete(socketKey(ws));
			for (const bytes of pending) processMessage(ws, session, bytes);
			for (const message of createInitialMessages(room.doc, room.awareness))
				sendBinary(ws, message);
		} catch (error) {
			logger.warn({ error, documentId }, "Collaboration upgrade rejected");
			ws.close(1008, error instanceof Error ? error.message : "Forbidden");
		}
	},
	message: (rawWs, message) => {
		const ws = rawWs as unknown as RawCollabWs;
		const bytes = messageBytes(message);
		if (!bytes) return;
		const key = socketKey(ws);
		const session = sessions.get(key);
		if (!session) {
			queuePendingMessage(key, bytes);
			return;
		}
		try {
			processMessage(ws, session, bytes);
		} catch (error) {
			logger.warn(
				{ error, roomKey: session.room.key },
				"Invalid collaboration frame",
			);
			ws.close(1003, "Invalid collaboration frame");
		}
	},
	close: (rawWs) => {
		const ws = rawWs as unknown as RawCollabWs;
		const key = socketKey(ws);
		pendingMessages.delete(key);
		const session = sessions.get(key);
		if (!session) return;
		sessions.delete(key);
		if (session.expiryTimer) clearTimeout(session.expiryTimer);
		const peers = roomSockets.get(session.room.key);
		peers?.delete(ws);
		if (peers?.size === 0) {
			roomSockets.delete(session.room.key);
			roomBroadcastUnsubscribes.get(session.room.key)?.();
			roomBroadcastUnsubscribes.delete(session.room.key);
		}
		const clients = Array.from(session.awarenessClientIds);
		if (clients.length) {
			awarenessProtocol.removeAwarenessStates(
				session.room.awareness,
				clients,
				ws,
			);
			broadcast(
				session.room.key,
				awarenessMessage(session.room.awareness, clients),
			);
		}
		void releaseYjsRoom(session.room);
	},
});
