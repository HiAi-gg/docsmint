import type { PageLoad } from "./$types";

type ShareData = {
	type?: string;
	data?: {
		id?: string;
		title?: string;
		content?: string;
		contentJson?: object | null;
		name?: string;
		parentId?: string | null;
		folders?: Array<{ id: string; name: string }>;
		documents?: Array<{ id: string; title: string }>;
	};
};

export const load: PageLoad = async ({ params, fetch }) => {
	const token = params.token;

	// Token is the dynamic [token] route param — if it is missing or
	// "undefined" (which happens when navigation lands on a partially
	// resolved route), skip the network call and surface a clear
	// error instead of letting the fetch hit /api/share/undefined.
	if (!token || token === "undefined") {
		return {
			token: null,
			shareData: null,
			requiresPassword: false,
			shareError: "Missing share token",
		};
	}

	try {
		const res = await fetch(`/api/share/${token}`);
		const data = (await res.json().catch(() => ({}))) as {
			requiresPassword?: boolean;
			error?: string;
		} & ShareData;

		// 401 with requiresPassword means the share exists but is
		// protected — render the password form rather than an error.
		if (res.status === 401) {
			return {
				token,
				shareData: null,
				requiresPassword: true,
				shareError: null,
			};
		}

		if (!res.ok) {
			return {
				token,
				shareData: null,
				requiresPassword: false,
				shareError: data.error ?? "Failed to load share",
			};
		}

		return {
			token,
			shareData: data,
			requiresPassword: false,
			shareError: null,
		};
	} catch (_e) {
		return {
			token,
			shareData: null,
			requiresPassword: false,
			shareError: "Network error",
		};
	}
};
