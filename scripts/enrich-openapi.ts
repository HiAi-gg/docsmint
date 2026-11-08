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

const scope = [{ BearerAuth: [] }, { SessionAuth: [] }];
const success = {
	type: "object",
	required: ["success"],
	properties: { success: { type: "boolean", enum: [true] } },
};
const successExample = { success: true };

function describeOperation(
	spec: Spec,
	path: string,
	method: string,
	summary: string,
	description: string,
	schema: object,
	example: object,
	errors: number[],
	parameters?: object[],
	status = 200,
) {
	const operation = spec.paths[path]?.[method];
	if (!operation)
		throw new Error(`Missing OpenAPI operation: ${method} ${path}`);
	const errorResponses: Record<number, object> = {
		400: failure("Invalid parameters or query.", "Invalid query"),
		401: failure("Authentication required.", "Unauthorized"),
		403: failure("Operation outside the current grant.", "Forbidden"),
		404: failure("Document not found in this scope.", "Document not found"),
		409: { $ref: "#/components/responses/AccountPurgeFenced" },
		413: failure(
			"Comparison exceeds the safe size limit.",
			"Version diff exceeds the safe comparison limit",
		),
		429: {
			...failure("Request rate limit exceeded.", "Too many requests"),
			headers: { "Retry-After": { schema: { type: "integer" } } },
		},
		500: failure("The request failed.", "Request failed"),
	};
	Object.assign(operation, {
		summary,
		description,
		tags: ["Documents"],
		security: scope,
		...(parameters && { parameters }),
		responses: {
			...(operation.responses as Record<string, unknown>),
			200: {
				description: "Successful request.",
				content: json(schema, example),
			},
			...Object.fromEntries(errors.map((code) => [code, errorResponses[code]])),
		},
	});
}

function describeDocumentReadsAndTrash(spec: Spec) {
	const listItem = {
		type: "object",
		required: ["id", "title"],
		properties: {
			id: uuid,
			title: { type: "string" },
			preview: { type: "string" },
		},
	};
	const listProperties = {
		items: { type: "array", items: listItem },
		total: { type: "integer", minimum: 0 },
	};
	const listExample = {
		items: [{ id: documentExample.id, title: documentExample.title }],
		total: 1,
	};
	const filterParameters = [
		...["categoryId", "folderId", "tag"].map((name) => ({
			name,
			in: "query",
			schema: uuid,
		})),
		...["q", "tagIds", "updatedFrom", "updatedTo"].map((name) => ({
			name,
			in: "query",
			schema: { type: "string" },
		})),
		{ name: "rootOnly", in: "query", schema: { type: "boolean" } },
		{
			name: "tagMatch",
			in: "query",
			schema: { type: "string", enum: ["all", "any"] },
		},
		{
			name: "sortOrder",
			in: "query",
			schema: { type: "string", enum: ["asc", "desc"] },
		},
		{
			name: "visibility",
			in: "query",
			schema: { type: "string", enum: ["private", "shared", "public"] },
		},
	];
	describeOperation(
		spec,
		"/api/documents",
		"get",
		"List documents by page",
		"List visible documents with offset pagination. Filters narrow the current key or session scope.",
		{
			type: "object",
			required: ["items", "total", "page", "limit"],
			properties: {
				...listProperties,
				page: { type: "integer" },
				limit: { type: "integer" },
			},
		},
		{ ...listExample, page: 1, limit: 20 },
		[400, 401, 403, 429, 500],
		[
			...filterParameters,
			{
				name: "page",
				in: "query",
				schema: { type: "integer", minimum: 1, default: 1 },
			},
			{
				name: "limit",
				in: "query",
				schema: { type: "integer", minimum: 1, maximum: 1000, default: 20 },
			},
			{
				name: "sortBy",
				in: "query",
				schema: { type: "string", enum: ["updatedAt", "createdAt", "title"] },
			},
		],
	);
	describeOperation(
		spec,
		"/api/documents/cursor",
		"get",
		"List documents by cursor",
		"Follow nextCursor using the same filters and authorization scope. A null cursor marks the last page.",
		{
			type: "object",
			required: ["items", "total", "nextCursor"],
			properties: {
				...listProperties,
				nextCursor: { type: "string", nullable: true },
			},
		},
		{ ...listExample, nextCursor: null },
		[400, 401, 403, 500],
		[
			...filterParameters,
			{ name: "cursor", in: "query", schema: { type: "string" } },
			{
				name: "limit",
				in: "query",
				schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
			},
			{
				name: "sortBy",
				in: "query",
				schema: {
					type: "string",
					enum: [
						"title",
						"category",
						"folder",
						"updated",
						"updatedAt",
						"createdAt",
					],
				},
			},
		],
	);
	describeOperation(
		spec,
		"/api/documents/{id}",
		"get",
		"Read a document",
		"Returns the document visible to the current key or session.",
		document,
		documentExample,
		[400, 401, 403, 404, 429, 500],
	);
	describeOperation(
		spec,
		"/api/documents/{id}",
		"delete",
		"Move a document to Trash",
		"Requires write permission. The document remains recoverable during the configured retention period.",
		success,
		successExample,
		[401, 403, 404, 409, 429, 500],
	);
	describeOperation(
		spec,
		"/api/trash",
		"get",
		"List trashed documents",
		"List soft-deleted documents visible in the current authorization scope and their scheduled purge time.",
		{
			type: "object",
			required: ["documents", "folders"],
			properties: {
				documents: {
					type: "array",
					items: {
						type: "object",
						required: ["id", "title", "deletedAt", "purgeAfter"],
						properties: {
							id: uuid,
							title: { type: "string" },
							deletedAt: { type: "string", format: "date-time" },
							purgeAfter: {
								type: "string",
								format: "date-time",
								nullable: true,
							},
						},
					},
				},
				folders: { type: "array", maxItems: 0, items: {} },
			},
		},
		{ documents: [], folders: [] },
		[401, 403, 500],
	);
	describeOperation(
		spec,
		"/api/trash/documents/{id}/restore",
		"post",
		"Restore a trashed document",
		"Requires write permission and a document that is still in Trash.",
		success,
		successExample,
		[401, 403, 404, 409, 500],
	);
	describeOperation(
		spec,
		"/api/trash/documents/{id}",
		"delete",
		"Permanently delete a trashed document",
		"Irreversible. Requires write permission. Confirm the document and action before sending the request.",
		success,
		successExample,
		[401, 403, 404, 409, 500],
	);
}

function describeVersions(spec: Spec) {
	const path = "/api/documents/{id}/versions";
	const date = { type: "string", format: "date-time" };
	const properties = {
		id: uuid,
		label: { type: "string", nullable: true },
		createdAt: date,
	};
	const version = {
		type: "object",
		required: ["id", "documentId", "content", "createdBy", "createdAt"],
		properties: {
			...properties,
			documentId: uuid,
			content: { type: "string" },
			contentJson: {},
			createdBy: uuid,
			description: { type: "string", nullable: true },
			isSnapshot: { type: "boolean" },
			restoredFrom: { ...uuid, nullable: true },
		},
	};
	const versionId = "22222222-2222-4222-8222-222222222222";
	const createdAt = "2026-11-08T12:00:00.000Z";
	const row = {
		id: versionId,
		documentId: documentExample.id,
		content: "Sample version",
		createdBy: "33333333-3333-4333-8333-333333333333",
		createdAt,
		label: "Baseline",
		isSnapshot: true,
	};
	const idParameter = { name: "id", in: "path", required: true, schema: uuid };

	describeOperation(
		spec,
		path + "/",
		"get",
		"List document versions",
		"Returns versions of an authorized document, newest first. Set onlySnapshots to select named snapshots.",
		{ type: "array", items: version },
		[row],
		[400, 401, 403, 404, 429, 500],
		[
			idParameter,
			{
				name: "onlySnapshots",
				in: "query",
				schema: { type: "boolean", default: false },
			},
			{
				name: "limit",
				in: "query",
				schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
			},
		],
	);
	describeOperation(
		spec,
		path + "/",
		"post",
		"Create a named snapshot",
		"Captures the current document content. Requires write permission.",
		version,
		row,
		[400, 401, 403, 404, 409, 429, 500],
		[idParameter],
		201,
	);
	const create = spec.paths[path + "/"].post;
	// Elysia's placeholder success status is superseded by the actual 201.
	delete (create.responses as Record<string, unknown>)["200"];
	create.requestBody = {
		required: true,
		content: json(
			{
				type: "object",
				required: ["label"],
				properties: {
					label: { type: "string", minLength: 1, maxLength: 200 },
					description: { type: "string", maxLength: 1000 },
				},
			},
			{ label: "Baseline" },
		),
	};

	describeOperation(
		spec,
		path + "/{vid}",
		"get",
		"Read a document version",
		"Returns the version body in the current document scope.",
		version,
		row,
		[401, 403, 404, 500],
	);
	describeOperation(
		spec,
		path + "/{vid}/restore",
		"post",
		"Restore a document version",
		"Applies the saved content to the current document. Requires edit permission.",
		document,
		documentExample,
		[401, 403, 404, 409, 429, 500],
	);

	const revision = {
		type: "object",
		required: ["id", "createdAt"],
		properties,
	};
	const count = { type: "integer", minimum: 0 };
	describeOperation(
		spec,
		path + "/diff",
		"get",
		"Compare two document versions",
		"Returns line changes from the older or source version to the target version.",
		{
			type: "object",
			required: ["v1", "v2", "changes", "hunks"],
			properties: {
				v1: revision,
				v2: revision,
				changes: {
					type: "object",
					required: ["added", "removed", "modified"],
					properties: { added: count, removed: count, modified: count },
				},
				hunks: {
					type: "array",
					items: {
						type: "object",
						required: ["type", "lines"],
						properties: {
							type: { type: "string", enum: ["add", "remove", "unchanged"] },
							lines: { type: "array", items: { type: "string" } },
						},
					},
				},
			},
		},
		{
			v1: { id: versionId, createdAt },
			v2: { id: "44444444-4444-4444-8444-444444444444", createdAt },
			changes: { added: 1, removed: 0, modified: 0 },
			hunks: [{ type: "add", lines: ["New line"] }],
		},
		[400, 401, 403, 404, 413, 500],
		[
			idParameter,
			...["from", "to"].map((name) => ({
				name,
				in: "query",
				required: true,
				schema: uuid,
			})),
		],
	);
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
	describeDocumentReadsAndTrash(spec);
	describeVersions(spec);
	return spec;
}
