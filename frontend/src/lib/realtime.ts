/** y-websocket connection coordinates owned by an embedded DocsMint host. */
export interface DocsmintRealtimeConnection {
	serverUrl: string;
	roomName: string;
	params?: Record<string, string>;
}

/** Host-owned resolver for workspace-aware realtime collaboration. */
export interface DocsmintRealtimeAdapter {
	resolveRealtimeConnection(input: {
		documentId: string;
		accessToken?: string;
	}): DocsmintRealtimeConnection;
}

/** Constructs the one canonical standalone collaboration endpoint. */
export function buildCollaborationConnection(
	documentId: string,
	accessToken: string | undefined,
	pageProtocol: string,
	pageHost: string,
): DocsmintRealtimeConnection {
	const wsProtocol = pageProtocol === "https:" ? "wss:" : "ws:";
	return {
		serverUrl: `${wsProtocol}//${pageHost}/api/ws/collab`,
		roomName: documentId,
		params: accessToken ? { token: accessToken } : undefined,
	};
}

/** Resolves standalone or host-owned collaboration coordinates through one contract. */
export function resolveCollaborationConnection(
	documentId: string,
	accessToken: string | undefined,
	pageProtocol: string,
	pageHost: string,
	adapter?: DocsmintRealtimeAdapter,
): DocsmintRealtimeConnection {
	return (
		adapter?.resolveRealtimeConnection({ documentId, accessToken }) ??
		buildCollaborationConnection(
			documentId,
			accessToken,
			pageProtocol,
			pageHost,
		)
	);
}
