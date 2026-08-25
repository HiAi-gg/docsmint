import { expect, test } from "bun:test";
import { resolveCollaborationConnection } from "./realtime";

test("builds one canonical y-websocket endpoint without duplicating documentId", () => {
	expect(
		resolveCollaborationConnection(
			"doc-1",
			"token",
			"https:",
			"docs.example.test",
		),
	).toEqual({
		serverUrl: "wss://docs.example.test/api/ws/collab",
		roomName: "doc-1",
		params: { token: "token" },
	});
});

test("allows an external host to provide workspace-aware connection coordinates", () => {
	expect(
		resolveCollaborationConnection(
			"doc-1",
			"token",
			"http:",
			"localhost:50701",
			{
				resolveRealtimeConnection: ({ documentId, accessToken }) => ({
					serverUrl: "wss://host.example.test/api/ws/collab",
					roomName: `workspace-a:${documentId}`,
					params: { access: accessToken ?? "" },
				}),
			},
		),
	).toEqual({
		serverUrl: "wss://host.example.test/api/ws/collab",
		roomName: "workspace-a:doc-1",
		params: { access: "token" },
	});
});
