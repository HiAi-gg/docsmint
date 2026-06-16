import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
	// Use the current origin so cookies are set on the same origin as the
	// frontend (e.g. http://localhost:50701) rather than the backend port.
	// Auth requests are forwarded by the SvelteKit proxy at /api/[...path].
	baseURL: typeof window !== "undefined" ? window.location.origin : "",
});

export const { signIn, signUp, signOut, getSession } = authClient;
