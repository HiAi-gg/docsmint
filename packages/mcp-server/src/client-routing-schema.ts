import { z } from "zod";

type JsonObject = Record<string, unknown>;

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function mergePropertyVariants(values: unknown[]): unknown {
	const unique = [
		...new Map(values.map((value) => [canonical(value), value])).values(),
	];
	if (unique.length === 1) return unique[0];
	// Collapsing literal alternatives is safe only when every other annotation
	// and constraint is identical. Otherwise preserve each original alternative.
	const literalObjects = unique.filter(
		(value) => value && typeof value === "object" && "const" in value,
	) as JsonObject[];
	if (literalObjects.length === unique.length) {
		const withoutConst = literalObjects.map(
			({ const: _literal, ...rest }) => rest,
		);
		if (
			withoutConst.every(
				(value) => canonical(value) === canonical(withoutConst[0]),
			)
		) {
			return {
				...withoutConst[0],
				enum: literalObjects.map((value) => value.const),
			};
		}
	}
	return { anyOf: unique };
}

function hoistObjectUnionClosure(schema: JsonObject): JsonObject {
	const variants = schema.oneOf;
	if (
		!Array.isArray(variants) ||
		!variants.every(
			(variant) =>
				typeof variant === "object" &&
				variant !== null &&
				variant.type === "object" &&
				variant.additionalProperties === false &&
				typeof variant.properties === "object" &&
				variant.properties !== null,
		)
	)
		return schema;

	const propertyVariants = new Map<string, unknown[]>();
	for (const variant of variants) {
		for (const [key, property] of Object.entries(variant.properties)) {
			const values = propertyVariants.get(key) ?? [];
			values.push(property);
			propertyVariants.set(key, values);
		}
	}

	return {
		...schema,
		type: "object",
		properties: Object.fromEntries(
			[...propertyVariants].map(([key, values]) => [
				key,
				mergePropertyVariants(values),
			]),
		),
		additionalProperties: false,
		oneOf: variants.map((variant) => {
			const { additionalProperties: _closure, ...branch } = variant;
			const excluded = [...propertyVariants.keys()].filter(
				(key) => !(key in variant.properties),
			);
			// Keep operation-specific fields forbidden, while leaving root-level client
			// routing properties to the root object (e.g. ChatGPT's injected link_id).
			return excluded.length === 0
				? branch
				: {
						...branch,
						allOf: [
							...(Array.isArray(branch.allOf) ? branch.allOf : []),
							{ not: { anyOf: excluded.map((key) => ({ required: [key] })) } },
						],
					};
		}),
	};
}

/**
 * Publish an extensible root object without changing provider-side validation.
 * Closed union branches otherwise reject properties added by MCP client routers.
 */
export function withClientRoutingSchema<Schema extends z.ZodType>(
	schema: Schema,
) {
	const standard = schema["~standard"];
	const selector = z
		.string()
		.uuid()
		.optional()
		.describe(
			"Workspace UUID from list_workspace_structure(kind=workspaces). Required for ambiguous creates and structure changes; omit to search all granted scopes.",
		);
	return {
		"~standard": {
			...standard,
			validate: async (
				value: unknown,
				options: Parameters<typeof standard.validate>[1],
			) => {
				if (!value || typeof value !== "object" || Array.isArray(value))
					return standard.validate(value, options);
				const { workspaceId, ...args } = value as Record<string, unknown>;
				const selected = selector.safeParse(workspaceId);
				if (!selected.success)
					return {
						issues: selected.error.issues.map((issue) => ({
							...issue,
							path: ["workspaceId", ...issue.path],
						})),
					};
				const validated = await standard.validate(args, options);
				if (validated.issues) return validated;
				return {
					value: {
						...(validated.value as Record<string, unknown>),
						...(selected.data ? { workspaceId: selected.data } : {}),
					},
				};
			},
			jsonSchema: {
				...standard.jsonSchema,
				input: (options: Parameters<typeof standard.jsonSchema.input>[0]) =>
					(() => {
						const published = hoistObjectUnionClosure(
							standard.jsonSchema.input(options),
						);
						const routingProperty = z.toJSONSchema(selector);
						return {
							...published,
							properties: {
								...(published.properties as JsonObject),
								workspaceId: routingProperty,
							},
							...(Array.isArray(published.oneOf)
								? {
										oneOf: published.oneOf.map((branch: JsonObject) => ({
											...branch,
											// Some MCP clients normalize each operation independently.
											// Keep routing visible there as well as at the object root.
											properties: {
												...(branch.properties as JsonObject),
												workspaceId: routingProperty,
											},
										})),
									}
								: {}),
						};
					})(),
			},
		},
	};
}
