import { publicIntegrationCollections } from "../backend/src/api/routes/integration-collections";

type Spec = { paths: Record<string, Record<string, Record<string, unknown>>> };
const uuid = { type: "string", format: "uuid" };
const documentExample = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "API quickstart",
	content: "Synthetic content.",
};
const document = {
	type: "object",
	required: ["id", "title", "content"],
	properties: {
		id: uuid,
		title: { type: "string" },
		content: { type: "string", nullable: true },
	},
};

function json(schema: object, example: object) {
	return { "application/json": { schema, example } };
}

function failure(description: string, message: string) {
	return {
		description,
		content: json(
			{
				type: "object",
				required: ["error"],
				properties: { error: { type: "string" } },
			},
			{ error: message },
		),
	};
}

export function enrichOpenApi(spec: Spec) {
	for (const [path, methods] of Object.entries(spec.paths)) {
		const collection = path.split("/")[2];
		if (!collection || !publicIntegrationCollections.has(collection)) continue;
		for (const [method, operation] of Object.entries(methods)) {
			if (
				![
					"get",
					"post",
					"patch",
					"put",
					"delete",
					"options",
					"head",
					"trace",
				].includes(method)
			)
				continue;
			operation["x-docsmint-v1-route-alias"] = path.replace(
				/^\/api\//,
				"/api/v1/",
			);
		}
	}
	const create = spec.paths["/api/documents"]?.post;
	if (!create)
		throw new Error("The documented document-create route is missing.");
	const scope = [{ BearerAuth: [] }, { SessionAuth: [] }];
	Object.assign(create, {
		summary: "Create a document",
		description:
			"Creates a document in the authorized workspace or category. An idempotent replay returns the existing accessible document and its current representation. Use a fresh key for each distinct creation.",
		tags: ["Documents"],
		security: scope,
		parameters: [
			{
				name: "Idempotency-Key",
				in: "header",
				required: false,
				description:
					"Scoped to the verified workspace and actor. The operation record is linked to the document. A key with a recorded but inaccessible document returns 409.",
				schema: {
					type: "string",
					pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
				},
			},
		],
		requestBody: {
			required: true,
			content: json(
				{
					type: "object",
					properties: {
						title: {
							type: "string",
							minLength: 1,
							maxLength: 500,
							default: "Untitled",
						},
						content: { type: "string" },
						folderId: uuid,
						categoryId: { ...uuid, nullable: true },
						visibility: {
							type: "string",
							enum: ["private", "shared", "public"],
						},
					},
				},
				{ title: documentExample.title, content: documentExample.content },
			),
		},
		responses: {
			200: {
				description: "Existing document returned on replay.",
				content: json(document, documentExample),
			},
			201: {
				description: "Document created.",
				content: json(document, documentExample),
			},
			400: failure(
				"Invalid document or idempotency key.",
				"Invalid Idempotency-Key",
			),
			401: failure("Authentication required.", "Unauthorized"),
			403: failure(
				"The requested write is outside the current grant.",
				"Forbidden",
			),
			409: failure(
				"Recorded key is unavailable or an account mutation fence is active.",
				"Idempotency key is unavailable",
			),
			429: {
				...failure("Write rate limit exceeded.", "Too many requests"),
				headers: { "Retry-After": { schema: { type: "integer" } } },
			},
		},
	});
	return spec;
}
