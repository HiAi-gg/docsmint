import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Awareness } from "y-protocols/awareness";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

export type YWebSocketMessageResult = Readonly<{
	reply?: Uint8Array;
	broadcast?: Uint8Array;
}>;

function toMessage(
	type: number,
	write: (encoder: encoding.Encoder) => void,
): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, type);
	write(encoder);
	return encoding.toUint8Array(encoder);
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
	return toMessage(MESSAGE_SYNC, (encoder) =>
		syncProtocol.writeUpdate(encoder, update),
	);
}

export function createInitialMessages(
	doc: Y.Doc,
	awareness: Awareness,
): Uint8Array[] {
	const sync = toMessage(MESSAGE_SYNC, (encoder) =>
		syncProtocol.writeSyncStep1(encoder, doc),
	);
	// The upgrade callback performs asynchronous auth and tenant lookup. A
	// provider can send its own step-1 before that work has completed, so send
	// an explicit step-2 snapshot as part of the server handshake as well.
	// y-websocket uses this frame to mark the provider synchronized, while the
	// preceding step-1 still requests and merges any client-side state.
	const snapshot = toMessage(MESSAGE_SYNC, (encoder) =>
		syncProtocol.writeSyncStep2(encoder, doc),
	);
	const clients = Array.from(awareness.getStates().keys());
	const awarenessState = toMessage(MESSAGE_AWARENESS, (encoder) => {
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
		);
	});
	return [sync, snapshot, awarenessState];
}

export function handleYWebSocketMessage(
	doc: Y.Doc,
	awareness: Awareness,
	message: Uint8Array,
	origin: unknown,
): YWebSocketMessageResult {
	const decoder = decoding.createDecoder(message);
	const type = decoding.readVarUint(decoder);
	if (type === MESSAGE_SYNC) {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
		const reply =
			encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined;
		return { reply };
	}
	if (type === MESSAGE_AWARENESS) {
		awarenessProtocol.applyAwarenessUpdate(
			awareness,
			decoding.readVarUint8Array(decoder),
			origin,
		);
		return { broadcast: message };
	}
	if (type === MESSAGE_QUERY_AWARENESS) {
		return {
			reply: toMessage(MESSAGE_AWARENESS, (encoder) => {
				encoding.writeVarUint8Array(
					encoder,
					awarenessProtocol.encodeAwarenessUpdate(
						awareness,
						Array.from(awareness.getStates().keys()),
					),
				);
			}),
		};
	}
	return {};
}
