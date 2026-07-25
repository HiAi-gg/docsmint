import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { config } from "./config";
import { logger } from "./logger";
import { redis } from "./redis";

const SAVE_INTERVAL_MS = 30_000;
const PERSIST_DEBOUNCE_MS = 1_000;
const DOC_PREFIX = "yjs:doc:";
const CHANNEL_PREFIX = "yjs:channel:";
const instanceId = randomUUID();
const REMOTE_REDIS_ORIGIN = Symbol("remote-redis");

type UpdateListener = (update: Uint8Array, origin: unknown) => void;
type PersistDocument = (doc: Y.Doc) => Promise<void>;

export type YjsRoom = Readonly<{
	key: string;
	doc: Y.Doc;
	awareness: Awareness;
}>;

type ManagedRoom = YjsRoom & {
	clients: number;
	listeners: Set<UpdateListener>;
	persist?: PersistDocument;
	saveInterval: ReturnType<typeof setInterval>;
	persistTimer?: ReturnType<typeof setTimeout>;
};

const rooms = new Map<string, ManagedRoom>();
const loadingRooms = new Map<string, Promise<ManagedRoom>>();
const closingRooms = new Map<string, Promise<void>>();
let pubSubRedis: Redis | null = null;
let subRedis: Redis | null = null;
let subscriptionHandlerInstalled = false;

function getPubSub(): Redis {
	if (!pubSubRedis)
		pubSubRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
	return pubSubRedis;
}

function getSub(): Redis {
	if (!subRedis)
		subRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
	if (!subscriptionHandlerInstalled) {
		subscriptionHandlerInstalled = true;
		subRedis.on("message", (channel: string, message: string) => {
			if (!channel.startsWith(CHANNEL_PREFIX)) return;
			const key = channel.slice(CHANNEL_PREFIX.length);
			const room = rooms.get(key);
			if (!room) return;
			try {
				const payload = JSON.parse(message) as {
					instanceId: string;
					update: string;
				};
				if (payload.instanceId === instanceId) return;
				Y.applyUpdate(
					room.doc,
					Buffer.from(payload.update, "base64"),
					REMOTE_REDIS_ORIGIN,
				);
			} catch (error) {
				logger.error({ error, key }, "Failed to apply Redis Yjs update");
			}
		});
	}
	return subRedis;
}

async function saveRoom(room: ManagedRoom): Promise<void> {
	const update = Y.encodeStateAsUpdate(room.doc);
	await redis.set(
		`${DOC_PREFIX}${room.key}`,
		Buffer.from(update).toString("base64"),
	);
}

function schedulePersistence(room: ManagedRoom): void {
	if (!room.persist || room.persistTimer) return;
	room.persistTimer = setTimeout(() => {
		room.persistTimer = undefined;
		void room
			.persist?.(room.doc)
			.catch((error) =>
				logger.error(
					{ error, roomKey: room.key },
					"Failed to materialize Yjs document",
				),
			);
	}, PERSIST_DEBOUNCE_MS);
}

async function loadRoom(
	key: string,
	seed: () => Promise<Y.Doc>,
	persist?: PersistDocument,
): Promise<ManagedRoom> {
	let doc: Y.Doc;
	const state = await redis.get(`${DOC_PREFIX}${key}`).catch((error) => {
		logger.error({ error, key }, "Failed to load Yjs document from Redis");
		return null;
	});
	if (state) {
		doc = new Y.Doc();
		Y.applyUpdate(doc, Buffer.from(state, "base64"));
	} else {
		doc = await seed();
	}
	const awareness = new Awareness(doc);
	const room = {
		key,
		doc,
		awareness,
		clients: 0,
		listeners: new Set<UpdateListener>(),
		persist,
		saveInterval: setInterval(() => void saveRoom(room), SAVE_INTERVAL_MS),
	} satisfies ManagedRoom;
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		for (const listener of room.listeners) listener(update, origin);
		if (origin !== REMOTE_REDIS_ORIGIN) {
			void getPubSub()
				.publish(
					`${CHANNEL_PREFIX}${key}`,
					JSON.stringify({
						instanceId,
						update: Buffer.from(update).toString("base64"),
					}),
				)
				.catch((error) =>
					logger.error({ error, key }, "Failed to publish Yjs update"),
				);
		}
		schedulePersistence(room);
	});
	rooms.set(key, room);
	await getSub().subscribe(`${CHANNEL_PREFIX}${key}`);
	if (!state) await saveRoom(room);
	return room;
}

export async function acquireYjsRoom(options: {
	key: string;
	seed: () => Promise<Y.Doc>;
	persist?: PersistDocument;
}): Promise<YjsRoom> {
	// A shared Redis subscriber cannot safely unsubscribe an old incarnation
	// after a replacement has subscribed to the same channel. Serialize room
	// incarnations so teardown always completes before a replacement is loaded.
	await closingRooms.get(options.key);
	let room = rooms.get(options.key);
	if (!room) {
		let pending = loadingRooms.get(options.key);
		if (!pending) {
			pending = loadRoom(options.key, options.seed, options.persist).finally(
				() => loadingRooms.delete(options.key),
			);
			loadingRooms.set(options.key, pending);
		}
		room = await pending;
	}
	room.clients += 1;
	return room;
}

export function subscribeYjsRoom(
	room: YjsRoom,
	listener: UpdateListener,
): () => void {
	const managed = rooms.get(room.key);
	if (!managed) throw new Error("Yjs room is not active");
	managed.listeners.add(listener);
	return () => managed.listeners.delete(listener);
}

export async function releaseYjsRoom(room: YjsRoom): Promise<void> {
	const managed = rooms.get(room.key);
	if (!managed) return;
	managed.clients = Math.max(0, managed.clients - 1);
	if (managed.clients > 0) return;
	// Detach synchronously so another release cannot tear down the same room.
	rooms.delete(managed.key);
	const teardown = (async () => {
		clearInterval(managed.saveInterval);
		if (managed.persistTimer) clearTimeout(managed.persistTimer);
		await Promise.allSettled([
			saveRoom(managed),
			managed.persist?.(managed.doc),
		]);
		await getSub().unsubscribe(`${CHANNEL_PREFIX}${managed.key}`);
		managed.awareness.destroy();
		managed.doc.destroy();
	})().finally(() => closingRooms.delete(managed.key));
	closingRooms.set(managed.key, teardown);
	await teardown;
}

export function getConnectedUsers(roomKey: string): number {
	return rooms.get(roomKey)?.clients ?? 0;
}
