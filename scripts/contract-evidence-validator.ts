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

export function validateContractEvidence(
	value: unknown,
	phase: ValidationPhase,
): { manifest?: ContractEvidenceManifest; errors: string[] } {
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
		const result = validateContractEvidence(await file.json(), phase);
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
