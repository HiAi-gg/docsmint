import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
	type DocsmintRealtimeAdapter,
	resolveCollaborationConnection,
} from "./realtime";

export interface CollaborationSession {
	provider: WebsocketProvider;
	doc: Y.Doc;
	destroy: () => void;
}

const activeSessions = new Set<CollaborationSession>();

export function startCollaboration(
	documentId: string,
	accessToken?: string,
	onUpdate?: (update: Uint8Array) => void,
	realtime?: DocsmintRealtimeAdapter,
): CollaborationSession {
	const doc = new Y.Doc();
	const connection = resolveCollaborationConnection(
		documentId,
		accessToken,
		window.location.protocol,
		window.location.host,
		realtime,
	);
	const provider = new WebsocketProvider(
		connection.serverUrl,
		connection.roomName,
		doc,
		{
			connect: true,
			params: connection.params,
		},
	);

	provider.on("sync", (_synced: boolean) => {});

	provider.on("status", (_status: { status: string }) => {});

	provider.on("connection-close", () => {});

	const updateHandler = onUpdate;
	if (updateHandler) {
		doc.on("update", updateHandler);
	}

	const session: CollaborationSession = {
		provider,
		doc,
		destroy: () => {
			if (updateHandler) {
				doc.off("update", updateHandler);
			}
			provider.disconnect();
			provider.destroy();
			doc.destroy();
		},
	};
	const destroy = session.destroy;
	session.destroy = () => {
		if (!activeSessions.delete(session)) return;
		destroy();
	};
	activeSessions.add(session);
	return session;
}

export function stopCollaboration(session?: CollaborationSession): void {
	if (session) {
		session.destroy();
		return;
	}
	for (const active of [...activeSessions]) active.destroy();
}

/** @deprecated Track the session returned by startCollaboration instead. */
export function getActiveSession(): CollaborationSession | null {
	return [...activeSessions].at(-1) ?? null;
}
