import { z } from "zod";

type JsonObject = Record<string, unknown>;

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
				values.length === 1 ? values[0] : { anyOf: values },
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
  const selector = z.string().uuid().optional().describe('Workspace UUID from list_workspace_structure(kind=workspaces). Required for ambiguous creates and structure changes; omit to search all granted scopes.');
	return {
		"~standard": {
			...standard,
      validate: async (value: unknown, options: Parameters<typeof standard.validate>[1]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return standard.validate(value, options);
        const { workspaceId, ...args } = value as Record<string, unknown>;
        const selected = selector.safeParse(workspaceId);
        if (!selected.success) return { issues: selected.error.issues };
        const validated = await standard.validate(args, options);
        if (validated.issues) return validated;
        return { value: { ...(validated.value as Record<string, unknown>), ...(selected.data ? { workspaceId: selected.data } : {}) } };
      },
			jsonSchema: {
				...standard.jsonSchema,
				input: (options: Parameters<typeof standard.jsonSchema.input>[0]) =>
					(() => {
              const published = hoistObjectUnionClosure(standard.jsonSchema.input(options));
              return { ...published, properties: { ...(published.properties as JsonObject), workspaceId: z.toJSONSchema(selector) } };
            })(),
			},
		},
	};
}
