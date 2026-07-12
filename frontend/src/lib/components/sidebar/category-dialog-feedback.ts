export function categoryDialogErrorMessage(
	error: unknown,
	fallback: string,
): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		error.status === 409
	) {
		return "A category with this name already exists.";
	}

	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	return fallback;
}
