import { expect, test } from "bun:test";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";
import { withClientRoutingSchema } from "./client-routing-schema.js";

test("hoisted properties deduplicate identical constraints and compact equivalent literals", () => {
	const source = z.discriminatedUnion("mode", [
		z.strictObject({
			mode: z.literal("first"),
			id: z.string().uuid(),
			title: z.string().optional(),
		}),
		z.strictObject({
			mode: z.literal("second"),
			id: z.string().uuid(),
			count: z.number(),
		}),
	]);
	const wrapped = withClientRoutingSchema(source);
	const schema = wrapped["~standard"].jsonSchema.input({
		target: "draft-2020-12",
	});
	const properties = schema.properties as Record<string, unknown>;
	expect(properties.id).toMatchObject({ type: "string", format: "uuid" });
	expect(properties.id).not.toHaveProperty("anyOf");
	expect(properties.mode).toEqual({
		type: "string",
		enum: ["first", "second"],
	});
	const validate = new Ajv2020({
		strict: false,
		validateFormats: false,
	}).compile(schema);
	const id = "11111111-1111-4111-8111-111111111111";
	for (const input of [
		{ mode: "first", id },
		{ mode: "first", id, count: 1 },
		{ mode: "second", id, count: 1 },
		{ mode: "second", id },
		{ mode: "other", id },
	]) {
		expect(validate(input)).toBe(source.safeParse(input).success);
	}
});
