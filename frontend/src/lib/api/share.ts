import { apiFetch } from "./client.js";

export interface ShareLink {
	id: string;
	token: string;
	documentId?: string;
	folderId?: string;
	hasPassword: boolean;
	expiresAt?: string | null;
	createdAt: string;
	title?: string;
	type?: "document" | "folder";
	guestEmails: string[];
}

export interface ShareContent {
	type: "document" | "folder";
	data: unknown;
}

export interface CreateShareLinkInput {
	documentId?: string;
	folderId?: string;
	password?: string;
	expiresIn?: "1h" | "1d" | "7d" | "30d" | "never";
	guestEmails?: string[];
}

// --- Share Links ---

export function createShareLink(
	data: CreateShareLinkInput,
): Promise<ShareLink> {
	if (!data.documentId && !data.folderId) {
		return Promise.reject(
			new Error("createShareLink: documentId or folderId is required"),
		);
	}
	return apiFetch("/api/share", { method: "POST", body: JSON.stringify(data) });
}

export function listShareLinks(params?: { documentId?: string }): Promise<{
	links: ShareLink[];
}> {
	const qs = params?.documentId ? `?documentId=${params.documentId}` : "";
	return apiFetch(`/api/share${qs}`);
}

export function getShareLink(token: string): Promise<ShareContent> {
	if (!token) {
		return Promise.reject(new Error("getShareLink: token is required"));
	}
	return apiFetch(`/api/share/${token}`);
}

export function revokeShareLink(id: string): Promise<void> {
	return apiFetch(`/api/share/${id}`, { method: "DELETE" });
}

// --- Guests ---

export function addGuest(linkId: string, email: string): Promise<ShareLink> {
	return apiFetch(`/api/share/${linkId}/guests`, {
		method: "POST",
		body: JSON.stringify({ email }),
	});
}

export function removeGuest(linkId: string, email: string): Promise<ShareLink> {
	return apiFetch(`/api/share/${linkId}/guests/${encodeURIComponent(email)}`, {
		method: "DELETE",
	});
}
