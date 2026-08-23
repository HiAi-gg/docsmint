export function requireIntegrationUrl(name: string): string {
	const value = process.env[name]?.trim();
	if (!value)
		throw new Error(`${name} is required for database integration tests`);
	return value;
}
