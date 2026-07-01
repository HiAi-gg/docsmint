import { Elysia } from "elysia";
import * as Y from "yjs";
import { auth } from "../../lib/auth";
import { config } from "../../lib/config";
import { logger } from "../../lib/logger";
import {
	addClient,
	broadcastUpdate,
	getYjsDoc,
	removeClient,
} from "../../lib/yjs-provider";

interface CollabSession {
	docId: string;
	clientId: number;
}

interface CollabMessage {
	type: "update" | "ping" | "sync";
	update?: string;
}

// Elysia's WS handlers (`open` / `message` / `close`) each receive a
// *fresh* `ElysiaWS` wrapper instance over the same underlying uWebSockets.js
// `ServerWebSocket`. The wrapper has a `.raw` field that points to the stable
// underlying handle, so we key our session WeakMap on `.raw` (which is
// identical across all three handler invocations for a given connection).
//
// Route params arrive as `rawWs.data.params.documentId`; the query string
// is `rawWs.data.query`. Both are populated by Elysia before `open` fires —
// if either is missing the WS upgrade itself was malformed and we close with
// a policy-violation code.
type RawCollabWs = {
	raw?: unknown;
	data?: {
		params?: { documentId?: string };
		query?: Record<string, string>;
	};
	send: (data: string) => void;
	close: (code: number, reason: string) => void;
};

const sessions = new WeakMap<object, CollabSession>();

async function verifyWsAuth(token: string | null): Promise<string | null> {
	if (!token) return null;
	const apiKey = config.HIAI_DOCS_API_KEY;
	if (apiKey && token === apiKey) return config.OWNER_ID;
	try {
		const session = await auth.api.getSession({
			headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
		});
		return session?.user?.id ?? null;
	} catch {
		return null;
	}
}

export const collaborationRoutes = new Elysia();

collaborationRoutes.ws("/ws/collab/:documentId", {
	open: async (rawWs) => {
		const ws = rawWs as unknown as RawCollabWs;
		const documentId = ws.data?.params?.documentId;
		if (!documentId) {
			ws.close(1008, "Missing documentId");
			return;
		}

		const token = ws.data?.query?.token ?? null;
		const userId = await verifyWsAuth(token);
		if (!userId) {
			ws.close(1008, "Authentication required");
			return;
		}

		const doc = await getYjsDoc(documentId);
		const clientId = doc.clientID;
		addClient(documentId);
		// Use `.raw` (the underlying uWebSockets.js ServerWebSocket) as the
		// session key — see the comment on `RawCollabWs` above. Each
		// `open`/`message`/`close` invocation gets a fresh ElysiaWS
		// wrapper but the `.raw` handle is identical.
		sessions.set(ws.raw ?? ws, { docId: documentId, clientId });

		const state = Y.encodeStateAsUpdate(doc);
		ws.send(
			JSON.stringify({
				type: "sync",
				state: Buffer.from(state).toString("base64"),
				clientId,
			}),
		);
		logger.debug({ documentId, clientId }, "WebSocket client connected");
	},

	message: async (rawWs, message) => {
		const ws = rawWs as unknown as RawCollabWs;
		try {
			// Elysia auto-parses string messages that start with `{`, `[`,
			// `"`, or `/` (see `createWSMessageParser` in
			// `node_modules/elysia/dist/ws/index.js`), so a `ping` envelope
			// arrives as a parsed object. Buffer paths are still possible
			// if the client sends a binary frame, so handle both: prefer
			// the parsed object when present, fall back to JSON.parse for
			// a raw string.
			let data: CollabMessage;
			if (typeof message === "object" && message !== null) {
				data = message as CollabMessage;
			} else if (Buffer.isBuffer(message)) {
				data = JSON.parse(message.toString("utf-8")) as CollabMessage;
			} else if (typeof message === "string") {
				data = JSON.parse(message) as CollabMessage;
			} else {
				return;
			}
			const session = sessions.get(ws.raw ?? ws);
			if (!session) {
				logger.debug(
					{ type: data.type },
					"WebSocket message received but no session — likely a stale frame from a recently-closed connection",
				);
				return;
			}

			const doc = await getYjsDoc(session.docId);

			if (data.type === "update" && data.update) {
				const update = Buffer.from(data.update, "base64");
				Y.applyUpdate(doc, update);
				broadcastUpdate(session.docId, update, session.clientId);
			} else if (data.type === "ping") {
				logger.debug(
					{ documentId: session.docId, clientId: session.clientId },
					"WebSocket ping received, sending pong",
				);
				ws.send(JSON.stringify({ type: "pong" }));
			}
		} catch (err) {
			logger.error({ err }, "WebSocket message error");
		}
	},

	close: (rawWs) => {
		const ws = rawWs as unknown as RawCollabWs;
		const session = sessions.get(ws.raw ?? ws);
		if (!session) return;
		removeClient(session.docId);
		sessions.delete(ws.raw ?? ws);
		logger.debug(
			{ documentId: session.docId, clientId: session.clientId },
			"WebSocket client disconnected",
		);
	},

	drain: () => {
		logger.debug("WebSocket backpressure relieved");
	},
});
