import type { z } from "zod";

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
	return {
		"~standard": {
			...standard,
			jsonSchema: {
				...standard.jsonSchema,
				input: (options: Parameters<typeof standard.jsonSchema.input>[0]) =>
					hoistObjectUnionClosure(standard.jsonSchema.input(options)),
			},
		},
	};
}
