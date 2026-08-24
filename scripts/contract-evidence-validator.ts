import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

type ValidationPhase = "task2" | "prepublish" | "postpublish";
type EvidenceStatus = "proven" | "pending_publish" | "not_applicable_oss";

interface EvidenceQuestion {
	id: number;
	question: string;
	status: EvidenceStatus | string;
	evidence: string[];
	explanation?: string;
}

interface MigrationTransition {
	status: "pending_task_3" | "complete" | string;
	value: boolean | null;
	evidence?: string[];
	explanation?: string;
}

interface ContractEvidenceManifest {
	schemaVersion: number;
	release: string;
	requiresSaasMigration: MigrationTransition;
	questions: EvidenceQuestion[];
}

const allowedStatuses = new Set<EvidenceStatus>([
	"proven",
	"pending_publish",
	"not_applicable_oss",
]);

const repositoryRoot = resolve(import.meta.dir, "..");
const allowedPostpublishMetadata = new Set([
	"postpublish:npm.version",
	"postpublish:npm.gitHead",
	"postpublish:npm.dist.integrity",
	"postpublish:npm.dist.shasum",
	"postpublish:origin.tag-release-artifact-commit",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
	);
}

function repositoryPath(value: string): string | undefined {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.split("/").includes("..")
	) {
		return undefined;
	}
	const resolved = resolve(repositoryRoot, value);
	if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`)) {
		return undefined;
	}
	return resolved;
}

async function validatePathEvidence(
	payload: string,
	kind: "test" | "static" | "workflow",
): Promise<string | undefined> {
	const separator = payload.indexOf("#");
	const path = separator === -1 ? payload : payload.slice(0, separator);
	const selector = separator === -1 ? undefined : payload.slice(separator + 1);
	if (path.includes(" ") || (separator !== -1 && !selector)) {
		return `${kind} evidence must use path or path#exact-selector`;
	}
	if (kind === "workflow" && !path.startsWith(".github/workflows/")) {
		return "workflow evidence must reference .github/workflows";
	}
	const absolutePath = repositoryPath(path);
	if (!absolutePath || !existsSync(absolutePath)) {
		return `evidence path does not exist: ${path}`;
	}
	if (selector) {
		const source = await Bun.file(absolutePath).text();
		const selectorExists =
			kind === "test"
				? [...source.matchAll(/\b(?:test|it)\(\s*["'`]([^"'`]+)["'`]/g)].some(
						(match) => match[1] === selector,
					)
				: source.includes(selector);
		if (!selectorExists) {
			return `evidence selector does not exist in ${path}: ${selector}`;
		}
	}
	return undefined;
}

async function validateCommandEvidence(command: string): Promise<string | undefined> {
	if (command.startsWith("bun run ")) {
		const target = command.slice("bun run ".length).trim().split(/\s+/)[0];
		if (!target) return "bun run evidence requires a target";
		if (target.includes("/") || target.endsWith(".ts")) {
			const absolutePath = repositoryPath(target);
			if (!absolutePath || !existsSync(absolutePath)) {
				return `command target does not exist: ${target}`;
			}
			return undefined;
		}
		const packageJson = (await Bun.file(resolve(repositoryRoot, "package.json")).json()) as {
			scripts?: Record<string, string>;
		};
		if (!packageJson.scripts?.[target]) {
			return `package script does not exist: ${target}`;
		}
		return undefined;
	}
	const gitDiff = /^git diff --name-status [0-9a-f]{40}\.\.HEAD -- (.+)$/.exec(
		command,
	);
	if (gitDiff?.[1]) {
		for (const path of gitDiff[1].split(/\s+/)) {
			const absolutePath = repositoryPath(path);
			if (!absolutePath || !existsSync(absolutePath)) {
				return `git diff evidence path does not exist: ${path}`;
			}
		}
		return undefined;
	}
	return "command evidence must be a repository bun target or exact git diff";
}

async function invalidEvidenceReason(reference: string): Promise<string | undefined> {
	const separator = reference.indexOf(":");
	if (separator <= 0) return "evidence reference requires a supported kind";
	const kind = reference.slice(0, separator);
	const payload = reference.slice(separator + 1);
	if (kind === "test" || kind === "static" || kind === "workflow") {
		return validatePathEvidence(payload, kind);
	}
	if (kind === "command") return validateCommandEvidence(payload);
	if (kind === "metadata") {
		return allowedPostpublishMetadata.has(payload)
			? undefined
			: `unsupported postpublish metadata: ${payload}`;
	}
	return `unsupported evidence kind: ${kind}`;
}

async function validateEvidenceReferences(
	references: string[],
	label: string,
	errors: string[],
): Promise<void> {
	for (const reference of references) {
		const reason = await invalidEvidenceReason(reference);
		if (reason) {
			errors.push(`${label} has invalid evidence reference ${reference}: ${reason}`);
		}
	}
}

export async function validateContractEvidence(
	value: unknown,
	phase: ValidationPhase,
): Promise<{ manifest?: ContractEvidenceManifest; errors: string[] }> {
	const errors: string[] = [];
	if (!isRecord(value)) return { errors: ["manifest must be a JSON object"] };
	if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (value.release !== "0.7.0") errors.push("release must be exactly 0.7.0");

	const migration = value.requiresSaasMigration;
	if (!isRecord(migration)) {
		errors.push("requiresSaasMigration transition is required");
	} else if (migration.status === "pending_task_3") {
		if (phase !== "task2") {
			errors.push("requiresSaasMigration is still pending Task 3");
		}
		if (migration.value !== null) {
			errors.push("pending Task 3 requiresSaasMigration value must be null");
		}
		if (
			typeof migration.explanation !== "string" ||
			migration.explanation.trim().length === 0
		) {
			errors.push("pending Task 3 requiresSaasMigration needs an explanation");
		}
	} else if (
		migration.status !== "complete" ||
		migration.value !== true ||
		!nonEmptyStrings(migration.evidence)
	) {
		errors.push(
			"requiresSaasMigration must be complete with value true and executable evidence",
		);
	} else {
		await validateEvidenceReferences(
			migration.evidence as string[],
			"requiresSaasMigration",
			errors,
		);
	}

	if (!Array.isArray(value.questions)) {
		errors.push("questions must be an array");
		return { errors };
	}
	if (value.questions.length !== 89) {
		errors.push("questions must contain exactly 89 rows");
	}
	const ordered = value.questions.every(
		(question, index) => isRecord(question) && question.id === index + 1,
	);
	if (!ordered) {
		errors.push("questions must be ordered exactly from 1 through 89");
	}

	for (const [index, rawQuestion] of value.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			errors.push(`question row ${index + 1} must be an object`);
			continue;
		}
		const id = typeof rawQuestion.id === "number" ? rawQuestion.id : index + 1;
		if (
			typeof rawQuestion.question !== "string" ||
			rawQuestion.question.trim().length === 0
		) {
			errors.push(`question ${id} requires its checklist text`);
		}
		const status = rawQuestion.status;
		if (status === "gap" || status === "partial") {
			errors.push(`question ${id} uses forbidden status ${status}`);
		} else if (
			typeof status !== "string" ||
			!allowedStatuses.has(status as EvidenceStatus)
		) {
			errors.push(`question ${id} uses unknown status ${String(status)}`);
		}
		if (status === "pending_publish" && (id < 1 || id > 5)) {
			errors.push("only questions 1-5 may be pending_publish");
		}
		if (phase === "postpublish" && status === "pending_publish") {
			errors.push("postpublish evidence cannot contain pending_publish");
		}
		if (!nonEmptyStrings(rawQuestion.evidence)) {
			errors.push(`question ${id} requires evidence`);
		} else {
			await validateEvidenceReferences(
				rawQuestion.evidence,
				`question ${id}`,
				errors,
			);
		}
		if (
			status === "not_applicable_oss" &&
			(typeof rawQuestion.explanation !== "string" ||
				rawQuestion.explanation.trim().length === 0)
		) {
			errors.push(
				`question ${id} not_applicable_oss requires an explanation`,
			);
		}
	}

	return {
		manifest: value as unknown as ContractEvidenceManifest,
		errors,
	};
}

function parseArguments(argv: string[]): { phase: ValidationPhase; path: string } {
	let phase: ValidationPhase = "prepublish";
	let path = "docs/release/0.7.0-contract-evidence.json";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--phase") {
			const candidate = argv[index + 1];
			if (
				candidate !== "task2" &&
				candidate !== "prepublish" &&
				candidate !== "postpublish"
			) {
				throw new Error("--phase must be task2, prepublish, or postpublish");
			}
			phase = candidate;
			index += 1;
			continue;
		}
		if (argument?.startsWith("--")) {
			throw new Error(`Unknown option ${argument}`);
		}
		if (argument) path = argument;
	}
	return { phase, path };
}

if (import.meta.main) {
	try {
		const { phase, path } = parseArguments(Bun.argv.slice(2));
		const file = Bun.file(path);
		if (!(await file.exists())) throw new Error(`Evidence manifest not found: ${path}`);
		const result = await validateContractEvidence(await file.json(), phase);
		if (result.errors.length > 0) {
			for (const error of result.errors) console.error(error);
			process.exit(1);
		}
		const questions = result.manifest?.questions ?? [];
		const count = (status: EvidenceStatus) =>
			questions.filter((question) => question.status === status).length;
		console.log(
			`Contract evidence valid for ${phase}: ${count("proven")} proven, ${count("pending_publish")} pending_publish, ${count("not_applicable_oss")} not_applicable_oss`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
