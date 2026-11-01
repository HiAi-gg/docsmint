import {
	McpServer,
	type Transport,
	type JSONRPCMessage,
} from "@modelcontextprotocol/server";

type ObjectValue = Record<string, unknown>;
interface InputContract {
	validate(value: unknown): unknown | PromiseLike<unknown>;
	jsonSchema(): unknown;
}
const contracts = new WeakMap<McpServer, Map<string, InputContract>>();
function object(value: unknown): ObjectValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as ObjectValue)
		: undefined;
}
/** Retain exactly the pure Standard Schema registered with the SDK; never replace its dispatch. */
export function captureMcpInputSchema<
	Schema extends {
		"~standard": {
			validate(value: unknown, options: undefined): unknown;
			jsonSchema: { input(options: { target: "draft-2020-12" }): unknown };
		};
	},
>(server: McpServer, name: string, schema: Schema): Schema {
	let registered = contracts.get(server);
	if (!registered) {
		registered = new Map();
		contracts.set(server, registered);
	}
	registered.set(name, {
		validate: (value) => schema["~standard"].validate(value, undefined),
		jsonSchema: () =>
			schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
	});
	return schema;
}
interface Pending {
	count: number;
	ambiguous: boolean;
	candidate?: { tool: string; args: unknown; contract: InputContract };
}
const codes = new Set([
	"invalid_type",
	"too_big",
	"too_small",
	"invalid_format",
	"not_multiple_of",
	"unrecognized_keys",
	"invalid_union",
	"invalid_key",
	"invalid_element",
	"invalid_value",
	"custom",
]);
function diagnostics(
	tool: string,
	input: unknown,
	schemaValue: unknown,
	issues: unknown[],
): ObjectValue {
	const schema = object(schemaValue) ?? {};
	const branches = Array.isArray(schema.oneOf)
		? schema.oneOf.map((item) => object(item) ?? {})
		: [schema];
	const knownFields = new Set<string>();
	function fields(value: unknown): void {
		const item = object(value);
		if (!item) return;
		for (const [name, child] of Object.entries(object(item.properties) ?? {})) {
			knownFields.add(name);
			fields(child);
		}
		if (item.items) fields(item.items);
		for (const key of ["oneOf", "anyOf", "allOf"])
			if (Array.isArray(item[key]))
				for (const child of item[key]) fields(child);
	}
	fields(schema);
	const args = object(input) ?? {};
	const selector = ["mode", "action", "view", "kind"].find((key) =>
		branches.some((branch) => {
			const property = object(object(branch.properties)?.[key]);
			return (
				property &&
				(typeof property.const === "string" || Array.isArray(property.enum))
			);
		}),
	);
	const variants = branches.map((branch) => {
		const property = selector
			? object(object(branch.properties)?.[selector])
			: undefined;
		const values =
			property && typeof property.const === "string"
				? [property.const]
				: Array.isArray(property?.enum)
					? property.enum.filter((value) => typeof value === "string")
					: [];
		return {
			values,
			required: Array.isArray(branch.required)
				? branch.required.filter(
						(value) => typeof value === "string" && knownFields.has(value),
					)
				: [],
		};
	});
	const selected = selector ? args[selector] : undefined;
	const branch =
		typeof selected === "string" &&
		variants.some((variant) => variant.values.includes(selected))
			? selected
			: null;
	return {
		tool,
		branch,
		expectedArgs: variants.map((variant) => ({
			branches: variant.values,
			required: variant.required,
		})),
		issues: issues.slice(0, 32).map((value) => {
			const issue = object(value) ?? {};
			const path = Array.isArray(issue.path)
				? issue.path
						.map((part) => object(part)?.key ?? part)
						.filter((part) =>
							typeof part === "string"
								? knownFields.has(part)
								: typeof part === "number" &&
									Number.isInteger(part) &&
									part >= 0 &&
									part < 10000,
						)
				: [];
			return {
				path,
				code:
					typeof issue.code === "string" && codes.has(issue.code)
						? issue.code
						: "invalid_argument",
			};
		}),
	};
}

/**
 * Observe the SDK's completed validation failure and add redacted protocol data.
 * Every incoming message and every non-matching response passes through unchanged.
 * Proxy forwarding preserves current and future public transport features and this binding.
 */
export function decorateMcpArgumentTransport(
	transport: Transport,
	server: McpServer,
): Transport {
	const pending = new Map<string | number, Pending>();
	let closed = false;
	let overflowed = false;
	function remember(message: JSONRPCMessage): void {
		if (closed || overflowed) return;
		if (
			!("method" in message) ||
			!("id" in message) ||
			(typeof message.id !== "string" && typeof message.id !== "number")
		)
			return;
		const previous = pending.get(message.id);
		if (previous) {
			previous.count++;
			previous.ambiguous = true;
			previous.candidate = undefined;
			return;
		}
		if (pending.size >= 1024) {
			// Once IDs cannot all be tracked, later reuse cannot be proven safe.
			// Disable enrichment for this connection; the SDK continues unchanged.
			overflowed = true;
			pending.clear();
			return;
		}
		const params = "params" in message ? object(message.params) : undefined;
		const name = params?.name;
		const contract =
			message.method === "tools/call" && typeof name === "string"
				? contracts.get(server)?.get(name)
				: undefined;
		pending.set(message.id, {
			count: 1,
			ambiguous: false,
			...(contract && typeof name === "string"
				? { candidate: { tool: name, args: params?.arguments ?? {}, contract } }
				: {}),
		});
	}
	async function send(
		message: JSONRPCMessage,
		options?: Parameters<Transport["send"]>[1],
	): Promise<void> {
		const id =
			"id" in message &&
			(typeof message.id === "string" || typeof message.id === "number") &&
			!("method" in message)
				? message.id
				: undefined;
		const entry = id === undefined ? undefined : pending.get(id);
		let outgoing = message;
		try {
			const candidate = entry && !entry.ambiguous ? entry.candidate : undefined;
			const result = "result" in message ? object(message.result) : undefined;
			const block =
				result && Array.isArray(result.content) && result.content.length === 1
					? object(result.content[0])
					: undefined;
			if (
				id !== undefined &&
				candidate &&
				result?.isError === true &&
				Object.keys(result).length === 2 &&
				block?.type === "text" &&
				Object.keys(block).length === 2 &&
				typeof block.text === "string" &&
				block.text.startsWith(
					`Input validation error: Invalid arguments for tool ${candidate.tool}:`,
				)
			) {
				try {
					const validation = object(
						await candidate.contract.validate(candidate.args),
					);
					if (
						Array.isArray(validation?.issues) &&
						validation.issues.length &&
						!entry?.ambiguous &&
						pending.get(id) === entry
					) {
						const data = diagnostics(
							candidate.tool,
							candidate.args,
							candidate.contract.jsonSchema(),
							validation.issues,
						);
						outgoing = {
							jsonrpc: "2.0",
							id,
							error: { code: -32602, message: "Invalid tool arguments", data },
						} as JSONRPCMessage;
					}
				} catch {
					/* Any SDK/schema drift fails closed to the original response. */
				}
			}
			await transport.send(outgoing, options);
		} finally {
			if (
				id !== undefined &&
				entry &&
				pending.get(id) === entry &&
				--entry.count === 0
			)
				pending.delete(id);
		}
	}
	return new Proxy(transport, {
		get(target, property) {
			if (property === "send") return send;
			if (property === "close")
				return async () => {
					closed = true;
					pending.clear();
					await target.close();
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			if (property === "onmessage")
				return Reflect.set(
					target,
					property,
					(message: JSONRPCMessage, extra?: unknown) => {
						try {
							remember(message);
						} catch {
							overflowed = true;
							pending.clear();
						}
						if (typeof value === "function") value(message, extra);
					},
					target,
				);
			if (property === "onclose")
				return Reflect.set(
					target,
					property,
					() => {
						closed = true;
						pending.clear();
						if (typeof value === "function") value();
					},
					target,
				);
			return Reflect.set(target, property, value, target);
		},
	});
}

/** Public SDK extension: retain the original McpServer and Protocol dispatch unmodified. */
export class DocsMintMcpServer extends McpServer {
	override connect(transport: Transport): Promise<void> {
		return super.connect(decorateMcpArgumentTransport(transport, this));
	}
}
