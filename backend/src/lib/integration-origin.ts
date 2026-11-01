/** New integration endpoints must not alter legacy browser/Better Auth origin policy. */
export function integrationAllowedOrigins(config: {
	CORS_ORIGINS?: string;
	PUBLIC_APP_URL?: string;
	BETTER_AUTH_URL: string;
}): string[] {
	if (config.CORS_ORIGINS?.trim())
		return config.CORS_ORIGINS.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean);
	return [
		...new Set(
			[config.PUBLIC_APP_URL, config.BETTER_AUTH_URL]
				.filter((value): value is string => !!value)
				.map((value) => new URL(value).origin),
		),
	];
}
export function rejectIntegrationOrigin(
	request: Request,
	allowedOrigins: readonly string[],
): Response | undefined {
	const path = new URL(request.url).pathname;
	const origin = request.headers.get("origin");
	if (
		path.startsWith("/api/v1/") &&
		origin &&
		!allowedOrigins.includes(origin)
	) {
		return Response.json(
			{ error: "Origin not allowed" },
			{ status: 403, headers: { Vary: "Origin" } },
		);
	}
}
