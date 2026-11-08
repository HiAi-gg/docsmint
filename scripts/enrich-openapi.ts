import { publicIntegrationCollections } from "../backend/src/api/routes/integration-collections";

type Spec = {
	paths: Record<string, Record<string, Record<string, unknown>>>;
	components?: { securitySchemes?: Record<string, unknown> };
};
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
		410: failure("The share link has expired.", "Share link has expired"),
		413: failure(
			"Request exceeds the configured size limit.",
			"Request too large",
		),
		429: {
			...failure("Request rate limit exceeded.", "Too many requests"),
			headers: { "Retry-After": { schema: { type: "integer" } } },
		},
		415: failure("Unsupported content type.", "Unsupported content type"),
		422: failure(
			"The content could not be processed safely.",
			"Unprocessable content",
		),
		500: failure("The request failed.", "Request failed"),
		503: failure(
			"Attachment storage admission is temporarily unavailable.",
			"Attachment storage unavailable",
		),
	};
	Object.assign(operation, {
		summary,
		description,
		tags: ["Documents"],
		security: scope,
		...(parameters && { parameters }),
		responses: {
			...(operation.responses as Record<string, unknown>),
			[status]: {
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
		`${path}/`,
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
		`${path}/`,
		"post",
		"Create a named snapshot",
		"Captures the current document content. Requires write permission.",
		version,
		row,
		[400, 401, 403, 404, 409, 429, 500],
		[idParameter],
		201,
	);
	const create = spec.paths[`${path}/`].post;
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
		`${path}/{vid}`,
		"get",
		"Read a document version",
		"Returns the version body in the current document scope.",
		version,
		row,
		[401, 403, 404, 500],
	);
	describeOperation(
		spec,
		`${path}/{vid}/restore`,
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
		`${path}/diff`,
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

function describeOrganization(spec: Spec) {
	const date = { type: "string", format: "date-time" };
	const nullableUuid = { ...uuid, nullable: true };
	const rank = { type: "integer", minimum: 0 };
	const categorySettings = {
		apiMode: { type: "string", enum: ["unavailable", "global", "category"] },
		apiPermissionRead: { type: "boolean" },
		apiPermissionEdit: { type: "boolean" },
		apiPermissionWrite: { type: "boolean" },
	};
	const resources = [
		{
			path: "/api/tags",
			itemPath: "/api/tags/{id}",
			name: "tag",
			createFields: {
				name: { type: "string", minLength: 1, maxLength: 100 },
				color: { type: "string", maxLength: 20 },
			},
			updateFields: {},
			properties: {
				color: { type: "string", nullable: true },
				createdAt: date,
				documentCount: rank,
			},
			exampleFields: { color: null },
			createErrors: [400, 401, 403, 409, 429, 500],
			updateErrors: [400, 401, 403, 404, 429, 500],
			deleteErrors: [401, 403, 429, 500],
		},
		{
			path: "/api/categories",
			itemPath: "/api/categories/{id}",
			name: "category",
			createFields: {
				name: { type: "string", minLength: 1, maxLength: 255 },
				...categorySettings,
			},
			updateFields: { order: rank },
			properties: {
				order: rank,
				...categorySettings,
				createdAt: date,
				updatedAt: date,
				documentCount: rank,
				folderCount: rank,
			},
			exampleFields: { order: 0 },
			createErrors: [400, 401, 403, 409, 429, 500],
			updateErrors: [400, 401, 403, 404, 409, 429, 500],
			deleteErrors: [401, 403, 404, 429, 500],
		},
		{
			path: "/api/folders/",
			itemPath: "/api/folders/{id}",
			name: "folder",
			createFields: {
				name: { type: "string", minLength: 1, maxLength: 255 },
				parentId: nullableUuid,
				categoryId: nullableUuid,
			},
			updateFields: { order: rank },
			properties: {
				ownerId: uuid,
				parentId: nullableUuid,
				categoryId: nullableUuid,
				order: rank,
				createdAt: date,
				updatedAt: date,
				documentCount: rank,
				subfolderCount: rank,
			},
			exampleFields: { parentId: null, categoryId: null },
			createErrors: [400, 401, 403, 404, 429, 500],
			updateErrors: [400, 401, 403, 404, 429, 500],
			deleteErrors: [401, 403, 404, 429, 500],
		},
	];

	for (const resource of resources) {
		const {
			path,
			itemPath,
			name,
			createFields,
			updateFields,
			properties,
			exampleFields,
		} = resource;
		const row = {
			type: "object",
			required: ["id", "name"],
			properties: { id: uuid, name: { type: "string" }, ...properties },
		};
		const example = {
			id: documentExample.id,
			name: "Example",
			...exampleFields,
		};
		const isFolder = name === "folder";
		const namePlural = name === "category" ? "categories" : `${name}s`;
		const listParameters = isFolder
			? [{ name: "parentId", in: "query", schema: uuid }]
			: undefined;
		describeOperation(
			spec,
			path,
			"get",
			`List ${namePlural}`,
			"Returns items visible to the current API key or browser session.",
			{ type: "array", items: row },
			[example],
			[401, 403, 500],
			listParameters,
		);
		describeOperation(
			spec,
			path,
			"post",
			`Create a ${name}`,
			"Requires write access to the destination.",
			row,
			example,
			resource.createErrors,
			undefined,
			201,
		);
		describeOperation(
			spec,
			itemPath,
			"patch",
			`Update a ${name}`,
			"Requires edit access to the resource. Send the fields to change.",
			row,
			example,
			resource.updateErrors,
		);
		describeOperation(
			spec,
			itemPath,
			"delete",
			`Delete a ${name}`,
			"Requires write access to the resource.",
			success,
			successExample,
			resource.deleteErrors,
		);

		const create = spec.paths[path].post;
		delete (create.responses as Record<string, unknown>)["200"];
		create.requestBody = {
			required: true,
			content: json(
				{ type: "object", required: ["name"], properties: createFields },
				{ name: "Example" },
			),
		};
		spec.paths[itemPath].patch.requestBody = {
			required: true,
			content: json(
				{
					type: "object",
					minProperties: 1,
					properties: { ...createFields, ...updateFields },
				},
				{ name: "Renamed" },
			),
		};
		if (name !== "folder") {
			for (const operation of [create, spec.paths[itemPath].patch]) {
				const responses = operation.responses as Record<string, unknown>;
				if ("409" in responses)
					responses["409"] = failure(
						"Name conflict or account mutation fence.",
						`${name} name already exists`,
					);
			}
		}
		for (const operation of [
			spec.paths[path].get,
			create,
			...Object.values(spec.paths[itemPath]),
		]) {
			operation.tags = [namePlural[0].toUpperCase() + namePlural.slice(1)];
		}

		if (isFolder) {
			const children = { type: "array", items: row };
			describeOperation(
				spec,
				itemPath,
				"get",
				"Read a folder",
				"Includes visible child folders and documents.",
				{
					...row,
					properties: {
						...row.properties,
						children,
						documents: {
							type: "array",
							items: {
								type: "object",
								required: ["id", "title"],
								properties: { id: uuid, title: { type: "string" } },
							},
						},
					},
				},
				{ ...example, children: [], documents: [] },
				[401, 403, 404, 500],
			);
			spec.paths[itemPath].get.tags = ["Folders"];
		}
	}

	describeOperation(
		spec,
		"/api/documents/{id}/tags",
		"post",
		"Add a tag to a document",
		"Requires edit permission for the document and visibility of the tag.",
		success,
		successExample,
		[400, 401, 403, 404, 429, 500],
		undefined,
		201,
	);
	const tagLink = spec.paths["/api/documents/{id}/tags"].post;
	delete (tagLink.responses as Record<string, unknown>)["200"];
	tagLink.requestBody = {
		required: true,
		content: json(
			{ type: "object", required: ["tagId"], properties: { tagId: uuid } },
			{ tagId: "22222222-2222-4222-8222-222222222222" },
		),
	};
	describeOperation(
		spec,
		"/api/documents/{id}/tags/{tagId}",
		"delete",
		"Remove a tag from a document",
		"Requires edit permission for the document.",
		success,
		successExample,
		[401, 403, 404, 429, 500],
	);
}

function describeSearch(spec: Spec) {
	const string = { type: "string" };
	const score = { type: "number" };
	const count = { type: "integer", minimum: 0 };
	const page = { type: "integer", minimum: 1, default: 1 };
	const limit = { type: "integer", minimum: 1, maximum: 100, default: 20 };
	const namedHit = { id: uuid, title: string, score };
	const example = {
		id: documentExample.id,
		title: documentExample.title,
		score: 0.8,
	};
	const query = (name: string, schema: object, required = false) => ({
		name,
		in: "query",
		schema,
		required,
	});
	const listOf = (items: object) => ({ type: "array", items });
	const object = (
		properties: Record<string, object>,
		required = Object.keys(properties),
	) => ({ type: "object", properties, required });

	const hit = object(
		{
			...namedHit,
			snippet: string,
			preview: string,
			folder_id: { ...uuid, nullable: true },
			folder_name: { ...string, nullable: true },
			created_at: { ...string, format: "date-time" },
			updated_at: { ...string, format: "date-time" },
			categoryId: { ...uuid, nullable: true },
			effectiveCategoryId: { ...uuid, nullable: true },
			chunks: listOf(
				object({
					chunkIndex: count,
					chunkText: string,
					charStart: count,
					charEnd: count,
					score,
				}),
			),
		},
		[
			"id",
			"title",
			"snippet",
			"score",
			"folder_id",
			"folder_name",
			"created_at",
			"updated_at",
		],
	);
	const diagnostics = object({
		graphAttempted: { type: "boolean" },
		graphFailed: { type: "boolean" },
		graphContribution: { type: "boolean" },
	});
	describeOperation(
		spec,
		"/api/search/",
		"get",
		"Search visible documents",
		"Searches within the current scope. The ranking window is capped at 1,000 results.",
		object({ items: listOf(hit), total: count, page, limit, diagnostics }, [
			"items",
			"total",
			"page",
			"limit",
		]),
		{ items: [], total: 0, page: 1, limit: 20 },
		[400, 401, 403, 429, 500],
		[
			...["q", "folder", "tags", "dateFrom", "dateTo"].map((name) =>
				query(name, string),
			),
			query("category", uuid),
			query("page", page),
			query("limit", limit),
			query("sort", {
				...string,
				enum: ["relevance", "date_desc", "date_asc", "name_asc", "name_desc"],
				default: "relevance",
			}),
			query("includeChunks", { type: "boolean", default: false }),
			query("includeDiagnostics", { type: "boolean", default: false }),
			query("graph", { type: "boolean", deprecated: true }),
			query("graphHops", {
				type: "integer",
				minimum: 1,
				maximum: 3,
				deprecated: true,
			}),
			query("graphBoost", {
				type: "number",
				minimum: 0,
				maximum: 2,
				deprecated: true,
			}),
		],
	);
	describeOperation(
		spec,
		"/api/search/suggest",
		"get",
		"Suggest visible document titles",
		"Returns up to five scoped title matches.",
		listOf(object(namedHit)),
		[example],
		[400, 401, 403, 429, 500],
		[query("q", string)],
	);

	const entities = listOf(object({ name: string, type: string }));
	const neighbor = {
		docId: uuid,
		relationType: string,
		hopDistance: { type: "integer", minimum: 1 },
	};
	describeOperation(
		spec,
		"/api/graph/entities",
		"get",
		"Read document graph entities",
		"Returns graph entities for an authorized document.",
		object({ entities }),
		{ entities: [] },
		[400, 401, 403, 404],
		[query("docId", uuid, true)],
	);
	describeOperation(
		spec,
		"/api/graph/related/{docId}",
		"get",
		"Read related documents",
		"Returns visible documents within two graph hops of an authorized seed.",
		object({ related: listOf(object(neighbor)) }),
		{ related: [] },
		[400, 401, 403, 404],
		[
			{ name: "docId", in: "path", required: true, schema: uuid },
			query("limit", limit),
		],
	);
	describeOperation(
		spec,
		"/api/graph/search",
		"post",
		"Search the document graph",
		"Returns graph entities and related documents for visible seed documents. Requires read access.",
		object(
			{
				query: string,
				entities,
				relatedDocs: listOf(
					object({ ...neighbor, title: string, snippet: string }),
				),
			},
			["entities", "relatedDocs"],
		),
		{ entities: [], relatedDocs: [] },
		[400, 401, 403, 404],
	);
	spec.paths["/api/graph/search"].post.requestBody = {
		required: true,
		content: json(
			object(
				{
					query: { ...string, maxLength: 2000 },
					docIds: { ...listOf(uuid), minItems: 1, maxItems: 50 },
					maxResults: { type: "integer", minimum: 1, maximum: 100 },
				},
				["docIds"],
			),
			{ docIds: [documentExample.id] },
		),
	};
	for (const path of [
		"/api/search/",
		"/api/search/suggest",
		"/api/graph/entities",
		"/api/graph/related/{docId}",
		"/api/graph/search",
	]) {
		for (const operation of Object.values(spec.paths[path])) {
			operation.tags = [path.startsWith("/api/search/") ? "Search" : "Graph"];
		}
	}
}

function describeFileTransfers(spec: Spec) {
	const string = { type: "string" };
	const binary = { ...string, format: "binary" };
	const count = { type: "integer", minimum: 0 };
	const obj = (
		properties: Record<string, object>,
		required = Object.keys(properties),
	) => ({ type: "object", properties, required });
	const query = (name: string, schema: object, required = false) => ({
		name,
		in: "query",
		schema,
		required,
	});
	const replaceContent = (
		path: string,
		method: string,
		status: string,
		content: object,
	) => {
		const responses = spec.paths[path][method].responses as Record<
			string,
			Record<string, unknown>
		>;
		if ("$ref" in responses[status]) {
			responses[status] = {
				description: "Import conflicts with an active account mutation fence.",
				content,
			};
		} else {
			responses[status].content = content;
		}
		if (status === "201") delete responses["200"];
	};
	const requests = (path: string, content: object) => {
		spec.paths[path].post.requestBody = { required: true, content };
	};

	const uploads = "/api/documents/{id}/attachments";
	const size = { type: "integer", minimum: 1 };
	const file = {
		filename: { ...string, minLength: 1, maxLength: 255 },
		contentType: string,
		size,
	};
	const uploadExample = {
		filename: "sample.png",
		contentType: "image/png",
		size: 128,
	};
	const attachment = obj({
		id: uuid,
		filename: string,
		mimeType: string,
		size,
		url: string,
	});
	const attachmentExample = {
		id: documentExample.id,
		filename: "sample.png",
		mimeType: "image/png",
		size: 128,
		url: "/api/attachments/11111111-1111-4111-8111-111111111111/raw",
	};
	const uploadErrors = [400, 401, 403, 404, 409, 413, 415, 429, 500, 503];
	describeOperation(
		spec,
		`${uploads}/presign`,
		"post",
		"Request a signed attachment upload",
		"Returns a storage URL and confirmation token for an admitted image. Use the reservation value verbatim when present.",
		obj(
			{
				url: { ...string, format: "uri" },
				key: string,
				uploadToken: string,
				quotaReservationId: string,
				maxSize: size,
				expiresIn: size,
			},
			["url", "key", "uploadToken", "maxSize", "expiresIn"],
		),
		{
			url: "https://storage.example.invalid/upload",
			key: "example/storage-key",
			uploadToken: "example-upload-token",
			maxSize: 10485760,
			expiresIn: 300,
		},
		uploadErrors,
	);
	requests(`${uploads}/presign`, json(obj(file), uploadExample));

	describeOperation(
		spec,
		`${uploads}/confirm`,
		"post",
		"Confirm a signed attachment upload",
		"Verifies the uploaded image and records it on the document. Repeating a completed confirmation can return the same attachment.",
		attachment,
		attachmentExample,
		uploadErrors,
		undefined,
		201,
	);
	replaceContent(
		`${uploads}/confirm`,
		"post",
		"201",
		json(attachment, attachmentExample),
	);
	requests(
		`${uploads}/confirm`,
		json(
			obj(
				{
					...file,
					key: string,
					uploadToken: string,
					quotaReservationId: string,
				},
				[...Object.keys(file), "key", "uploadToken"],
			),
			{
				...uploadExample,
				key: "example/storage-key",
				uploadToken: "example-upload-token",
			},
		),
	);

	describeOperation(
		spec,
		uploads,
		"post",
		"Upload an image attachment",
		"Accepts a multipart file and attaches it to an editable document.",
		attachment,
		attachmentExample,
		uploadErrors,
		undefined,
		201,
	);
	replaceContent(uploads, "post", "201", json(attachment, attachmentExample));
	requests(uploads, {
		"multipart/form-data": { schema: obj({ file: binary }) },
	});
	describeOperation(
		spec,
		uploads,
		"get",
		"List document attachments",
		"Returns attachment metadata and same-origin read URLs for a visible document.",
		obj({ items: { type: "array", items: attachment } }),
		{ items: [attachmentExample] },
		[401, 403, 404],
	);
	describeOperation(
		spec,
		"/api/attachments/{id}",
		"delete",
		"Delete an attachment",
		"Requires access to remove the attachment. Storage cleanup can finish asynchronously.",
		success,
		successExample,
		[401, 403, 404, 409, 429],
	);

	const confirmResponses = spec.paths[`${uploads}/confirm`].post
		.responses as Record<string, unknown>;
	confirmResponses["409"] = failure(
		"The upload is unavailable or storage confirmation must be retried.",
		"Upload not found in storage — please retry upload",
	);

	const image = { "image/*": { schema: binary } };
	const shareHeaders = [
		{ name: "X-Share-Password", in: "header", schema: string },
	];
	for (const [path, title, description, parameters, errors] of [
		[
			"/api/attachments/{id}/raw",
			"Read image attachment bytes",
			"Requires access to the document or a valid share that grants access to it.",
			[
				{ name: "id", in: "path", required: true, schema: uuid },
				...shareHeaders,
			],
			[401, 403, 404, 500],
		],
		[
			"/api/attachments/remote-image",
			"Read a referenced remote image",
			"The authorized document must already reference the supplied image URL. Unsafe URLs are refused.",
			[
				query("documentId", uuid, true),
				query("url", { ...string, format: "uri", maxLength: 4096 }, true),
				...shareHeaders,
			],
			[400, 401, 403, 404, 422, 429],
		],
	] as const) {
		describeOperation(
			spec,
			path,
			"get",
			title,
			description,
			binary,
			{},
			[...errors],
			[...parameters],
		);
		replaceContent(path, "get", "200", image);
		// The two file reads also accept a scoped share token.
		spec.paths[path].get.security = [...scope, { ShareToken: [] }];
	}

	const exportPath = "/api/documents/{id}/export";
	const exported = obj({
		id: uuid,
		title: string,
		updatedAt: { ...string, format: "date-time" },
		markdown: string,
		filename: string,
	});
	const exportExample = {
		id: documentExample.id,
		title: documentExample.title,
		updatedAt: "2026-11-08T12:00:00Z",
		markdown: "# Example",
		filename: "Example.md",
	};
	describeOperation(
		spec,
		exportPath,
		"get",
		"Export document Markdown",
		"Omit format for a Markdown download or pass json for metadata alongside the Markdown.",
		exported,
		exportExample,
		[400, 401, 403, 404, 500],
		[
			{ name: "id", in: "path", required: true, schema: uuid },
			query("format", { ...string, enum: ["json"] }),
		],
	);
	replaceContent(exportPath, "get", "200", {
		"text/markdown": { schema: string, example: "# Example" },
		...json(exported, exportExample),
	});

	const importPath = "/api/documents/import";
	const imported = obj(
		{
			items: {
				type: "array",
				items: {
					oneOf: [
						obj({
							filename: string,
							status: { ...string, enum: ["ok"] },
							document,
						}),
						obj(
							{
								filename: string,
								status: { ...string, enum: ["error"] },
								error: string,
								code: string,
							},
							["filename", "status", "error"],
						),
					],
				},
			},
			imported: count,
			failed: count,
			code: string,
		},
		["items", "imported", "failed"],
	);
	const importExample = {
		items: [
			{ filename: "Example.md", status: "ok", document: documentExample },
		],
		imported: 1,
		failed: 0,
	};
	describeOperation(
		spec,
		importPath,
		"post",
		"Import documents",
		"Accepts JSON text or up to ten multipart files. The response reports each file independently when at least one succeeds.",
		imported,
		importExample,
		[400, 401, 403, 409, 413, 415, 422, 429, 500],
		undefined,
		201,
	);
	replaceContent(importPath, "post", "201", json(imported, importExample));
	const errorResult = obj({ error: string, code: string }, ["error"]);
	for (const status of ["400", "409", "413", "415", "422", "500"]) {
		replaceContent(importPath, "post", status, {
			"application/json": { schema: { oneOf: [errorResult, imported] } },
		});
	}
	requests(importPath, {
		...json(
			obj(
				{
					title: { ...string, minLength: 1, maxLength: 500 },
					content: { ...string, minLength: 1, maxLength: 5000000 },
					folderId: uuid,
				},
				["content"],
			),
			{ title: "Example", content: "Example Markdown" },
		),
		"multipart/form-data": {
			schema: obj(
				{
					file: { type: "array", items: binary, minItems: 1, maxItems: 10 },
					folderId: uuid,
				},
				["file"],
			),
		},
	});
}

function describeCredentialManagement(spec: Spec) {
	const string = { type: "string" };
	const date = { ...string, format: "date-time" };
	const obj = (properties: Record<string, object>) => ({
		type: "object",
		properties,
		required: Object.keys(properties),
	});
	const created = obj({ id: uuid, key: string, prefix: string });
	const createdExample = {
		id: documentExample.id,
		key: "example-placeholder",
		prefix: "example",
	};
	const listRow = obj({
		id: uuid,
		name: string,
		prefix: string,
		scopes: { type: "array", items: string },
		lastUsedAt: { ...date, nullable: true },
		expiresAt: { ...date, nullable: true },
		createdAt: date,
		recoverable: { type: "boolean" },
	});
	for (const [path, summary, description, errors] of [
		[
			"/api/keys/global",
			"Create a global API key",
			"Requires a browser session. Treat the returned key as a secret.",
			[400, 401, 429],
		],
		[
			"/api/categories/{id}/keys",
			"Create a category API key",
			"Requires a browser session and an existing category with enabled API permissions.",
			[400, 401, 404, 409, 429],
		],
	] as const) {
		describeOperation(
			spec,
			path,
			"post",
			summary,
			description,
			created,
			createdExample,
			[...errors],
			undefined,
			201,
		);
		const operation = spec.paths[path].post;
		const responses = operation.responses as Record<string, unknown>;
		delete responses["200"];
		if ("409" in responses)
			responses["409"] = failure(
				"Category API access or permissions are not configured.",
				"Save Category API access before issuing a scoped key",
			);
		operation.requestBody = {
			required: false,
			content: json(
				{
					type: "object",
					properties: { name: { ...string, minLength: 1, maxLength: 255 } },
				},
				{ name: "Example integration" },
			),
		};
	}
	describeOperation(
		spec,
		"/api/keys",
		"get",
		"List API key metadata",
		"Requires a browser session. Lists the current user's keys without secret values.",
		obj({ keys: { type: "array", items: listRow } }),
		{ keys: [] },
		[401, 429, 500],
	);
	describeOperation(
		spec,
		"/api/keys/{id}/secret",
		"get",
		"Reveal a recoverable category key",
		"Requires a browser session belonging to the key owner. The response is not cacheable.",
		obj({ key: string }),
		{ key: "example-placeholder" },
		[401, 404, 429, 500],
	);
	describeOperation(
		spec,
		"/api/keys/{id}",
		"delete",
		"Revoke an API key",
		"Requires a browser session belonging to the key owner. The credential stops granting access.",
		success,
		successExample,
		[400, 401, 404, 409, 429, 500],
	);
	for (const [method, path] of [
		["post", "/api/keys/global"],
		["post", "/api/categories/{id}/keys"],
		["get", "/api/keys"],
		["get", "/api/keys/{id}/secret"],
		["delete", "/api/keys/{id}"],
	]) {
		spec.paths[path][method].security = [{ SessionAuth: [] }];
		delete spec.paths[path][method]["x-docsmint-v1-route-alias"];
		spec.paths[path][method].tags = ["API Keys"];
	}
}

function describeDocumentEditsAndProgress(spec: Spec) {
	const string = { type: "string" };
	const date = { ...string, format: "date-time" };
	const docPath = "/api/documents/{id}";
	const pipelinePath = `${docPath}/pipeline`;
	const summaryPath = `${docPath}/knowledge-summary`;
	const duplicatePath = `${docPath}/duplicate`;
	describeOperation(
		spec,
		docPath,
		"patch",
		"Update a document",
		"Requires edit permission. Supply expectedUpdatedAt to detect a write conflict.",
		document,
		documentExample,
		[400, 401, 403, 404, 409, 429, 500],
	);
	const update = spec.paths[docPath].patch;
	update.requestBody = {
		required: true,
		content: json(
			{
				type: "object",
				properties: {
					title: { ...string, minLength: 1, maxLength: 500 },
					content: string,
					contentJson: {},
					metadata: {},
					folderId: { ...uuid, nullable: true },
					categoryId: { ...uuid, nullable: true },
					visibility: { ...string, enum: ["private", "shared", "public"] },
					expectedUpdatedAt: date,
				},
			},
			{ title: "Edited", expectedUpdatedAt: "2026-11-08T12:00:00Z" },
		),
	};
	const conflict = {
		type: "object",
		required: ["error", "code", "currentUpdatedAt"],
		properties: {
			error: string,
			code: { ...string, enum: ["DOCUMENT_CONFLICT"] },
			currentUpdatedAt: date,
		},
	};
	(update.responses as Record<string, unknown>)["409"] = {
		description: "Stale document revision or an active account mutation fence.",
		content: json(
			{
				oneOf: [
					conflict,
					{ $ref: "#/components/schemas/AccountPurgeFencedError" },
				],
			},
			{
				error: "Document changed on the server",
				code: "DOCUMENT_CONFLICT",
				currentUpdatedAt: "2026-11-08T12:01:00Z",
			},
		),
	};
	describeOperation(
		spec,
		duplicatePath,
		"post",
		"Duplicate a document",
		"Requires write permission. Creates a new copy of the visible source document.",
		document,
		{ ...documentExample, title: "API quickstart (Copy)" },
		[401, 403, 404, 409, 429, 500],
		undefined,
		201,
	);
	delete (spec.paths[duplicatePath].post.responses as Record<string, unknown>)[
		"200"
	];

	describeOperation(
		spec,
		pipelinePath,
		"get",
		"Read pipeline progress",
		"Returns the latest indexing run for a visible document.",
		{ $ref: "#/components/schemas/DocsDocumentPipeline" },
		{
			documentId: documentExample.id,
			generationId: "22222222-2222-4222-8222-222222222222",
			status: "pending",
			revision: "example",
			stages: {
				prepare: "pending",
				embed: "pending",
				graph: "pending",
				summarize: "pending",
				finalize: "pending",
			},
			batches: { total: 0, completed: 0, failed: 0 },
			warnings: [],
			updatedAt: "2026-11-08T12:00:00Z",
		},
		[401, 403, 404, 500],
	);
	const summary = {
		documentId: uuid,
		generationId: uuid,
		revision: string,
		language: string,
		description: string,
		keywords: { type: "array", items: string },
		createdAt: date,
		updatedAt: date,
	};
	describeOperation(
		spec,
		summaryPath,
		"get",
		"Read a document knowledge summary",
		"Returns the summary for the active generation of a visible document.",
		{
			type: "object",
			required: Object.keys(summary),
			properties: summary,
		},
		{
			documentId: documentExample.id,
			generationId: "22222222-2222-4222-8222-222222222222",
			revision: "example",
			language: "en",
			description: "A sample document.",
			keywords: ["example"],
			createdAt: "2026-11-08T12:00:00Z",
			updatedAt: "2026-11-08T12:00:00Z",
		},
		[400, 401, 403, 404, 429],
	);
}

function describeSharing(spec: Spec) {
	const string = { type: "string" };
	const date = { ...string, format: "date-time" };
	const nullableUuid = { ...uuid, nullable: true };
	const obj = (
		properties: Record<string, object>,
		required = Object.keys(properties),
	) => ({
		type: "object",
		properties,
		...(required.length ? { required } : {}),
	});
	const list = (items: object) => ({ type: "array", items });
	const pathParam = (name: string, schema: object) => ({
		name,
		in: "path",
		schema,
		required: true,
	});
	const requestBody = (
		path: string,
		method: string,
		schema: object,
		example: object,
	) => {
		spec.paths[path][method].requestBody = {
			required: true,
			content: json(schema, example),
		};
	};
	const role = { ...string, enum: ["viewer", "commenter", "editor"] };
	const expiresIn = { ...string, enum: ["1h", "1d", "7d", "30d", "never"] };
	const targets = { documentId: uuid, folderId: uuid, categoryId: uuid };
	const link = {
		id: uuid,
		token: string,
		documentId: nullableUuid,
		folderId: nullableUuid,
		categoryId: nullableUuid,
		role,
		expiresAt: { ...date, nullable: true },
		hasPassword: { type: "boolean" },
		createdAt: date,
	};
	const example = {
		id: "22222222-2222-4222-8222-222222222222",
		token: "sample-share",
		documentId: documentExample.id,
		folderId: null,
		categoryId: null,
		role: "viewer",
		expiresAt: null,
		hasPassword: false,
		createdAt: "2026-11-08T12:00:00Z",
	};
	const base = "/api/share/";
	const member = `${base}{id}`;
	describeOperation(
		spec,
		base,
		"post",
		"Create a share link",
		"Requires permission to share the selected document, folder or category. Supply exactly one target.",
		obj(link),
		example,
		[400, 401, 403, 404, 500],
	);
	requestBody(
		base,
		"post",
		{
			type: "object",
			properties: {
				...targets,
				password: { ...string, minLength: 1 },
				role: { ...role, default: "viewer" },
				expiresIn: { ...expiresIn, default: "never" },
			},
			oneOf: Object.keys(targets).map((target) => ({ required: [target] })),
		},
		{ documentId: documentExample.id, role: "viewer" },
	);
	describeOperation(
		spec,
		base,
		"get",
		"List share links",
		"Returns share links managed by the current authenticated user.",
		obj({
			links: list(
				obj({
					...link,
					title: string,
					type: { ...string, enum: ["document", "folder", "category"] },
				}),
			),
		}),
		{ links: [{ ...example, title: "API quickstart", type: "document" }] },
		[401, 403],
	);
	describeOperation(
		spec,
		member,
		"patch",
		"Update a share link",
		"Changes the role or expiry of a share link managed by the authenticated user.",
		obj(link),
		example,
		[400, 401, 403, 404, 500],
	);
	requestBody(member, "patch", obj({ role, expiresIn }, []), {
		expiresIn: "7d",
	});
	describeOperation(
		spec,
		member,
		"delete",
		"Revoke a share link",
		"Revokes access granted by this link.",
		success,
		successExample,
		[401, 403, 404],
	);

	const guestPath = `${member}/guests`;
	const guest = obj({
		id: uuid,
		email: { ...string, format: "email" },
		grantedAt: date,
	});
	describeOperation(
		spec,
		guestPath,
		"post",
		"Grant guest access to a share",
		"Adds the specified email to a share managed by the authenticated user.",
		obj(
			{
				success: { type: "boolean", enum: [true] },
				guest,
				message: string,
			},
			["success"],
		),
		{ success: true, message: "Guest already has access" },
		[400, 401, 403, 404],
	);
	requestBody(
		guestPath,
		"post",
		obj({ email: { ...string, format: "email" } }),
		{ email: "guest@example.invalid" },
	);
	describeOperation(
		spec,
		`${guestPath}/{email}`,
		"delete",
		"Revoke guest access to a share",
		"Removes the specified email from the guest list.",
		success,
		successExample,
		[401, 403, 404],
		[pathParam("id", uuid), pathParam("email", { ...string, format: "email" })],
	);

	const shareDoc = obj({
		id: uuid,
		title: string,
		content: { ...string, nullable: true },
		contentJson: {},
		metadata: {},
		createdAt: date,
		updatedAt: date,
	});
	const names = { id: uuid, name: string };
	const dates = { createdAt: date, updatedAt: date };
	const children = {
		folders: list(obj({ ...names, ...dates })),
		documents: list(obj({ id: uuid, title: string, ...dates })),
	};
	const shareFolder = obj({ ...names, ...dates, ...children });
	const shareDocExample = {
		...documentExample,
		contentJson: null,
		metadata: null,
		createdAt: example.createdAt,
		updatedAt: example.createdAt,
	};
	const tokenPath = `${base}{token}`;
	const tokenParam = pathParam("token", string);
	const password = { name: "X-Share-Password", in: "header", schema: string };
	describeOperation(
		spec,
		tokenPath,
		"get",
		"Open a shared resource",
		"A valid link token grants scoped access. Category shares are returned as folder-shaped content.",
		{
			oneOf: [
				obj({ type: { ...string, enum: ["document"] }, data: shareDoc }),
				obj({ type: { ...string, enum: ["folder"] }, data: shareFolder }),
			],
		},
		{ type: "document", data: shareDocExample },
		[401, 404, 410, 429, 500],
		[tokenParam, password],
	);
	describeOperation(
		spec,
		`${tokenPath}/folders/{folderId}`,
		"get",
		"Read a subfolder in a shared resource",
		"The folder must be within the scope of the active share.",
		obj({
			...names,
			parentId: nullableUuid,
			...children,
		}),
		{
			id: documentExample.id,
			name: "Example",
			parentId: null,
			folders: [],
			documents: [],
		},
		[401, 403, 404, 410, 429],
		[tokenParam, pathParam("folderId", uuid), password],
	);
	describeOperation(
		spec,
		`${tokenPath}/documents/{docId}`,
		"get",
		"Read a document in a shared resource",
		"The document must be within the scope of the active share.",
		shareDoc,
		shareDocExample,
		[401, 403, 404, 410, 429],
		[tokenParam, pathParam("docId", uuid), password],
	);
	for (const path of Object.keys(spec.paths).filter((path) =>
		path.startsWith(base),
	)) {
		for (const operation of Object.values(spec.paths[path]))
			operation.tags = ["Sharing"];
		if (path.startsWith(tokenPath)) spec.paths[path].get.security = [];
	}
	for (const [action, visibility] of [
		["publish", "public"],
		["unpublish", "private"],
	]) {
		describeOperation(
			spec,
			`/api/documents/{id}/${action}`,
			"post",
			action === "publish" ? "Publish a document" : "Unpublish a document",
			"Requires permission to change document visibility.",
			{
				...document,
				properties: {
					...document.properties,
					visibility: { ...string, enum: [visibility] },
				},
			},
			{ ...documentExample, visibility },
			[401, 403, 404, 409, 429, 500],
		);
	}
}

function describeHostEndpoints(spec: Spec) {
	const string = { type: "string" };
	const object = (
		properties: Record<string, object>,
		required = Object.keys(properties),
	) => ({
		type: "object",
		properties,
		...(required.length ? { required } : {}),
	});
	const state = { ...string, enum: ["ok", "error"] };
	const healthExample = {
		status: "ok",
		service: "docsmint",
		timestamp: "2026-11-08T12:00:00Z",
		database: "ok",
		redis: "ok",
		storage: "ok",
		queue: "ok",
	};
	const health = object(
		{
			status: { ...string, enum: ["ok", "unhealthy"] },
			service: { ...string, enum: ["docsmint"] },
			timestamp: { ...string, format: "date-time" },
			database: state,
			redis: state,
			storage: state,
			queue: state,
			reasons: { type: "array", items: string },
		},
		Object.keys(healthExample),
	);
	describeOperation(
		spec,
		"/api/health",
		"get",
		"Read self-hosted readiness",
		"Reports database, Redis, storage and worker readiness. A failing dependency can produce HTTP 503.",
		health,
		healthExample,
		[429],
	);
	(spec.paths["/api/health"].get.responses as Record<string, unknown>)["503"] =
		{
			description: "One or more required services are unavailable.",
			content: json(health, {
				...healthExample,
				status: "unhealthy",
				redis: "error",
			}),
		};
	describeOperation(
		spec,
		"/api/csrf-token",
		"get",
		"Issue a browser CSRF token",
		"Sets the matching browser cookie. Send the returned token in x-csrf-token on protected cookie-authenticated writes.",
		object({ token: string }),
		{ token: "example-csrf-token" },
		[],
	);
	const csrfResponse = (
		spec.paths["/api/csrf-token"].get.responses as Record<
			string,
			Record<string, unknown>
		>
	)["200"];
	csrfResponse.headers = {
		"Set-Cookie": { schema: string, description: "Same-origin CSRF cookie." },
	};
	const plugin = object(
		{
			name: string,
			version: string,
			description: string,
			configSchema: { type: "object" },
		},
		["name", "version", "description"],
	);
	const example = {
		name: "highlight",
		version: "1.0.0",
		description: "Text highlight/marker extension",
	};
	describeOperation(
		spec,
		"/api/plugins/",
		"get",
		"List editor plugins",
		"Returns the built-in editor plugin manifests.",
		object({ plugins: { type: "array", items: plugin } }),
		{ plugins: [example] },
		[],
	);
	describeOperation(
		spec,
		"/api/plugins/{name}",
		"get",
		"Read an editor plugin manifest",
		"Looks up a built-in plugin by name.",
		plugin,
		example,
		[404],
		[{ name: "name", in: "path", required: true, schema: string }],
	);
	for (const path of [
		"/api/health",
		"/api/csrf-token",
		"/api/plugins/",
		"/api/plugins/{name}",
	]) {
		spec.paths[path].get.security = [];
		spec.paths[path].get.tags = [
			path.startsWith("/api/plugins") ? "Plugins" : "Host",
		];
	}

	const status = object({ status: { type: "boolean", enum: [true] } });
	for (const [path, title, description, schema, requestExample] of [
		[
			"/api/auth/update-user",
			"Update the current user profile",
			"Updates permitted fields on the browser session's user. Use the email change operation to change email.",
			object({ name: string, image: { ...string, nullable: true } }, []),
			{ name: "Example user" },
		],
		[
			"/api/auth/change-email",
			"Request a user email change",
			"Requires a recent browser session. The configured verification policy determines when the change takes effect.",
			object(
				{ newEmail: { ...string, format: "email" }, callbackURL: string },
				["newEmail"],
			),
			{ newEmail: "new@example.invalid" },
		],
	] as const) {
		describeOperation(
			spec,
			path,
			"post",
			title,
			description,
			status,
			{ status: true },
			[400, 401, 403, 409],
		);
		const op = spec.paths[path].post;
		op.security = [{ SessionAuth: [] }];
		op.tags = ["Auth"];
		op.requestBody = { required: true, content: json(schema, requestExample) };
	}

	const webhook = "/api/webhooks/storage";
	describeOperation(
		spec,
		webhook,
		"post",
		"Receive a signed storage notification",
		"Verifies the signature on the raw JSON body. Storage removal notifications are accepted for compatibility. The HTTP 200 body can report an invalid signature.",
		{
			oneOf: [
				object({ received: { type: "boolean", enum: [true] } }),
				object({ error: string }),
			],
		},
		{ received: true },
		[413],
	);
	const op = spec.paths[webhook].post;
	op.tags = ["Storage"];
	op.security = [{ StorageWebhookSignature: [] }];
	op.requestBody = {
		required: true,
		content: json(
			object(
				{
					Records: {
						type: "array",
						items: object({
							eventName: string,
							s3: object({ object: object({ key: string }) }),
						}),
					},
				},
				[],
			),
			{
				Records: [
					{
						eventName: "s3:ObjectRemoved:Delete",
						s3: { object: { key: "example/object" } },
					},
				],
			},
		),
	};
}

function describeOperatorEndpoints(spec: Spec) {
	const string = { type: "string" };
	const number = { type: "number" };
	const count = { type: "integer", minimum: 0 };
	const yes = { type: "boolean", enum: [true] };
	const obj = (
		properties: Record<string, object>,
		required = Object.keys(properties),
	) => ({ type: "object", properties, required });
	const query = (name: string, schema: object) => ({
		name,
		in: "query",
		schema,
	});
	const path = (name: string, schema: object) => ({
		name,
		in: "path",
		schema,
		required: true,
	});
	const operator = (
		suffix: string,
		method: string,
		title: string,
		description: string,
		schema: object,
		example: object,
		errors: number[] = [],
		parameters?: object[],
	) => {
		const route = `/api/admin/${suffix}`;
		describeOperation(
			spec,
			route,
			method,
			title,
			description,
			schema,
			example,
			[401, 429, ...errors],
			parameters,
		);
		spec.paths[route][method].security = [
			{ OperatorApiKey: [] },
			{ OperatorBearer: [] },
		];
		spec.paths[route][method].tags = ["Admin"];
	};
	const sampleId = documentExample.id;
	const dryRun = query("dryRun", { type: "boolean", default: false });
	operator(
		"reindex/{docId}",
		"post",
		"Queue document reindexing",
		"Queues a new indexing generation for an existing document.",
		obj({ success: yes, documentId: uuid, enqueued: count, message: string }),
		{
			success: true,
			documentId: sampleId,
			enqueued: 1,
			message: "Document reindex queued with a new generation",
		},
		[404, 500, 503],
		[path("docId", uuid)],
	);

	const stateCounts = {
		pending: 0,
		processing: 0,
		ready: 0,
		failed: 0,
		stale: 0,
	};
	const statKeys = [
		"docsWithEmbeddings",
		"totalChunks",
		"nullChunks",
		"zeroChunks",
		"nearZeroChunks",
		"emptyChunks",
		"activeInvalidRows",
		"inactiveGenerations",
		"profileMismatches",
		"pendingAgeSeconds",
	];
	const stats = Object.fromEntries(statKeys.map((key) => [key, count]));
	operator(
		"embedding-stats",
		"get",
		"Read embedding inventory",
		"Reports embedding and document indexing totals.",
		obj({
			stats: obj({
				...stats,
				statusCounts: obj(
					Object.fromEntries(
						Object.keys(stateCounts).map((key) => [key, count]),
					),
				),
			}),
		}),
		{
			stats: {
				...Object.fromEntries(statKeys.map((key) => [key, 0])),
				statusCounts: stateCounts,
			},
		},
		[500],
	);

	const provider = obj({
		baseUrl: { ...string, nullable: true },
		model: { ...string, nullable: true },
	});
	operator(
		"health/embeddings",
		"get",
		"Probe the configured embedding provider",
		"Reports provider availability, including unconfigured and degraded states.",
		obj(
			{
				status: { ...string, enum: ["ok", "degraded", "not-configured"] },
				provider,
				details: string,
				latencyMs: count,
				dimensions: count,
			},
			["status", "provider"],
		),
		{
			status: "ok",
			provider: { baseUrl: "https://example.invalid", model: "example" },
			latencyMs: 42,
			dimensions: 1536,
		},
	);

	operator(
		"graph/stats",
		"get",
		"Read graph inventory",
		"Reports graph counts when available and the reason when unavailable.",
		{
			oneOf: [
				obj({ available: yes, nodes: count, edges: count }),
				obj({ available: { type: "boolean", enum: [false] }, reason: string }),
			],
		},
		{ available: true, nodes: 0, edges: 0 },
	);

	operator(
		"reindex/model",
		"post",
		"Reindex stale embedding models",
		"Queues documents stored against another embedding model. Set dryRun to get a count without queuing.",
		{
			oneOf: [
				obj({ dryRun: yes, currentModel: string, affectedDocs: count }),
				obj({
					success: yes,
					currentModel: string,
					affectedDocs: count,
					enqueued: count,
				}),
			],
		},
		{ dryRun: true, currentModel: "example", affectedDocs: 3 },
		[500],
		[dryRun],
	);
	for (const resource of ["folder", "tag"]) {
		const id = `${resource}Id`;
		operator(
			`reindex/${resource}/{${id}}`,
			"post",
			`Reindex documents by ${resource}`,
			"Scope the operation with ownerId unless cross-tenant administration is enabled. Set dryRun to count affected documents without queuing.",
			{
				oneOf: [
					obj({ dryRun: yes, [id]: uuid, ownerId: uuid, affectedDocs: count }, [
						"dryRun",
						id,
						"affectedDocs",
					]),
					obj({ success: yes, [id]: uuid, ownerId: uuid, affected: count }, [
						"success",
						id,
						"affected",
					]),
				],
			},
			{ dryRun: true, [id]: sampleId, affectedDocs: 3 },
			[400, 500],
			[path(id, uuid), query("ownerId", uuid), dryRun],
		);
	}

	const nullable = { ...string, nullable: true };
	const auditEntry = obj({
		id: uuid,
		actorId: uuid,
		workspaceId: nullable,
		action: string,
		resourceType: string,
		resourceId: { ...uuid, nullable: true },
		details: {},
		ipAddress: nullable,
		userAgent: nullable,
		createdAt: { ...string, format: "date-time" },
	});
	const audit = obj({
		items: { type: "array", items: auditEntry },
		total: count,
		page: count,
		limit: count,
	});
	const pageParameters = [
		query("page", { type: "integer", minimum: 1, default: 1 }),
		query("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 }),
	];
	const auditExample = { items: [], total: 0, page: 1, limit: 50 };
	operator(
		"audit",
		"get",
		"List operator audit events",
		"Returns a page of audit events filtered by the optional resource and actor selectors.",
		audit,
		auditExample,
		[500],
		[
			...pageParameters,
			query("resourceType", string),
			query("resourceId", uuid),
			query("actorId", uuid),
			query("action", string),
		],
	);
	operator(
		"audit/{resourceType}/{resourceId}",
		"get",
		"Read the audit trail of a resource",
		"Returns a page of events scoped to the specified resource.",
		audit,
		auditExample,
		[500],
		[path("resourceType", string), path("resourceId", uuid), ...pageParameters],
	);

	const counters = { type: "object", additionalProperties: number };
	operator(
		"metrics",
		"get",
		"Read process-local metrics",
		"Returns process-local counters and histograms, pipeline metrics, embedding state counts and uptime in seconds.",
		obj({
			metrics: {
				type: "object",
				additionalProperties: {
					oneOf: [number, { type: "array", items: number }],
				},
			},
			pipelineMetrics: counters,
			embeddingStateInventory: counters,
			uptime: number,
		}),
		{
			metrics: {},
			pipelineMetrics: {},
			embeddingStateInventory: {},
			uptime: 120,
		},
		[500],
	);
}

const HTTP_METHODS = new Set([
	"get",
	"post",
	"patch",
	"put",
	"delete",
	"options",
	"head",
	"trace",
]);

export function enrichOpenApi(spec: Spec) {
	for (const [path, methods] of Object.entries(spec.paths)) {
		const collection = path.split("/")[2];
		for (const [method, operation] of Object.entries(methods)) {
			if (!HTTP_METHODS.has(method)) continue;
			if (collection && publicIntegrationCollections.has(collection)) {
				operation["x-docsmint-v1-route-alias"] = path.replace(
					/^\/api\//,
					"/api/v1/",
				);
			}
			const responses = operation.responses as
				| Record<string, Record<string, unknown>>
				| undefined;
			for (const [status, response] of Object.entries(responses ?? {})) {
				if ("description" in response || "$ref" in response) continue;
				response.description =
					status === "200" ? "Successful request." : `HTTP ${status} response.`;
			}
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
	describeOrganization(spec);
	describeSearch(spec);
	spec.components ??= {};
	spec.components.securitySchemes ??= {};
	spec.components.securitySchemes.ShareToken = {
		type: "apiKey",
		in: "header",
		name: "X-Share-Token",
	};
	describeFileTransfers(spec);
	describeCredentialManagement(spec);
	describeDocumentEditsAndProgress(spec);
	describeSharing(spec);
	spec.components.securitySchemes.StorageWebhookSignature = {
		type: "apiKey",
		in: "header",
		name: "X-Storage-Signature",
	};
	spec.components.securitySchemes.OperatorBearer = {
		type: "http",
		scheme: "bearer",
		description: "Self-hosted operator key.",
	};
	describeHostEndpoints(spec);
	describeOperatorEndpoints(spec);
	return spec;
}
