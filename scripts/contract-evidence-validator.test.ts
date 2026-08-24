import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateContractEvidence } from "./contract-evidence-validator";

const validator = resolve(import.meta.dir, "contract-evidence-validator.ts");
const temporaryDirectories: string[] = [];

type EvidenceStatus =
	| "proven"
	| "pending_publish"
	| "pending_task_3"
	| "not_applicable_oss"
	| "partial"
	| "gap";

const genericRepositoryEvidence =
	"test:scripts/contract-evidence-validator.test.ts#accepts exact 1-89 evidence only in the explicit Task 2 transition mode";

const futureTask3Evidence = {
	additiveIdempotentReapply:
		"test:scripts/rehearse-saas-0.7-adoption.test.ts#reapplies the additive migration as an idempotent no-op",
	noNewRequiredEnvironment:
		"test:scripts/rehearse-saas-0.7-adoption.test.ts#requires no new environment variables relative to 0.6.8",
	atomicPackageAndSubmoduleAdoption:
		"test:scripts/rehearse-saas-0.7-adoption.test.ts#adopts the package and submodule atomically in a disposable SaaS copy",
	runtime070Smoke:
		"test:scripts/rehearse-saas-0.7-adoption.test.ts#smokes the 0.7 runtime against the upgraded disposable database",
	rollback068RuntimeSmoke:
		"test:scripts/rehearse-saas-0.7-adoption.test.ts#smokes the 0.6.8 runtime against the upgraded disposable database",
	rehearsalCommand: "command:bun run scripts/rehearse-saas-0.7-adoption.ts",
} as const;

const migrationQuestionEvidence = new Map<number, string>([
	[71, futureTask3Evidence.additiveIdempotentReapply],
	[73, futureTask3Evidence.noNewRequiredEnvironment],
	[75, futureTask3Evidence.atomicPackageAndSubmoduleAdoption],
	[76, futureTask3Evidence.rollback068RuntimeSmoke],
]);

function manifest(
	overrides: {
		question?: Partial<{
			id: number;
			status: EvidenceStatus;
			evidence: string[];
			explanation: string;
		}>;
		requiresSaasMigration?: unknown;
	} = {},
) {
	const questions = Array.from({ length: 89 }, (_, index) => {
		const id = index + 1;
		const task3Evidence = migrationQuestionEvidence.get(id);
		return {
			id,
			question: `Checklist question ${id}`,
			status:
				id <= 5 ? "pending_publish" : task3Evidence ? "pending_task_3" : "proven",
			evidence: [task3Evidence ?? genericRepositoryEvidence],
			explanation:
				id <= 5
					? "Release-origin evidence is captured after publication."
					: task3Evidence
						? "Task 3 must execute and record this exact rehearsal behavior."
						: undefined,
		};
	});
	if (overrides.question) {
		const id = overrides.question.id ?? 6;
		questions[id - 1] = {
			...questions[id - 1],
			...overrides.question,
			id,
		};
	}
	return {
		schemaVersion: 1,
		release: "0.7.0",
		requiresSaasMigration:
			overrides.requiresSaasMigration ?? {
				status: "pending_task_3",
				value: null,
				explanation:
					"Task 3 must set the release declaration to true before the prepublish gate can pass.",
			},
		questions,
	};
}

function completedManifest(evidence: unknown) {
	const value = manifest({
		requiresSaasMigration: {
			status: "complete",
			value: true,
			evidence,
		},
	});
	for (const [id, reference] of migrationQuestionEvidence) {
		value.questions[id - 1] = {
			...value.questions[id - 1],
			status: "proven",
			evidence: [reference],
			explanation: undefined,
		};
	}
	return value;
}

async function runValidator(
	value: unknown,
	phase: "task2" | "prepublish" | "postpublish" = "task2",
) {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-contract-evidence-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "manifest.json");
	await Bun.write(path, JSON.stringify(value));
	const process = Bun.spawn(
		["bun", "run", validator, "--phase", phase, path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("0.7.0 contract evidence validator", () => {
	test("accepts exact 1-89 evidence only in the explicit Task 2 transition mode", async () => {
		const task2 = await runValidator(manifest(), "task2");
		expect(task2).toMatchObject({ exitCode: 0 });
		expect(task2.stdout).toContain(
			"Contract evidence valid for task2: 80 proven, 5 pending_publish, 4 pending_task_3, 0 not_applicable_oss",
		);

		const prepublish = await runValidator(manifest(), "prepublish");
		expect(prepublish.exitCode).toBe(1);
		expect(prepublish.stderr).toContain(
			"requiresSaasMigration is still pending Task 3",
		);
	});

	test("rejects missing, duplicate, and out-of-order checklist IDs", async () => {
		const missing = manifest();
		missing.questions.pop();
		expect((await runValidator(missing)).stderr).toContain(
			"questions must contain exactly 89 rows",
		);

		const duplicate = manifest();
		duplicate.questions[6] = { ...duplicate.questions[5] };
		expect((await runValidator(duplicate)).stderr).toContain(
			"questions must be ordered exactly from 1 through 89",
		);
	});

	test("rejects gap, partial, and pending_publish outside questions 1-5", async () => {
		for (const status of ["gap", "partial", "pending_publish"] as const) {
			const result = await runValidator(
				manifest({ question: { id: 6, status } }),
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				status === "pending_publish"
					? "only questions 1-5 may be pending_publish"
					: `question 6 uses forbidden status ${status}`,
			);
		}
	});

	test("requires evidence and an explanation for OSS-inapplicable rows", async () => {
		const incomplete = await runValidator(
			manifest({
				question: {
					id: 40,
					status: "not_applicable_oss",
					evidence: [],
					explanation: "",
				},
			}),
		);
		expect(incomplete.exitCode).toBe(1);
		expect(incomplete.stderr).toContain(
			"question 40 not_applicable_oss requires an explanation",
		);
		expect(incomplete.stderr).toContain("question 40 requires evidence");
	});

	test("rejects self-referential completed migration evidence", async () => {
		const complete = completedManifest([genericRepositoryEvidence]);
		for (const id of migrationQuestionEvidence.keys()) {
			complete.questions[id - 1] = {
				...complete.questions[id - 1],
				evidence: [genericRepositoryEvidence],
			};
		}
		const result = await validateContractEvidence(complete, "prepublish", {
			resolveEvidenceReference: async () => undefined,
		});
		expect(result.errors).toContain(
			"requiresSaasMigration evidence must use the exact Task 3 category contract",
		);
		for (const id of migrationQuestionEvidence.keys()) {
			expect(result.errors.join("\n")).toContain(
				`question ${id} proven migration evidence must equal`,
			);
		}
	});

	test("requires all exact independent Task 3 behaviors before prepublish", async () => {
		const resolvedReferences: string[] = [];
		const complete = completedManifest(futureTask3Evidence);
		const accepted = await validateContractEvidence(complete, "prepublish", {
			resolveEvidenceReference: async (reference) => {
				resolvedReferences.push(reference);
				return undefined;
			},
		});
		expect(accepted.errors).toEqual([]);
		for (const reference of Object.values(futureTask3Evidence)) {
			expect(resolvedReferences).toContain(reference);
		}
		const unresolvedRepositoryArtifacts = await runValidator(
			complete,
			"prepublish",
		);
		expect(unresolvedRepositoryArtifacts.exitCode).toBe(1);
		expect(unresolvedRepositoryArtifacts.stderr).toContain(
			"evidence path does not exist: scripts/rehearse-saas-0.7-adoption.test.ts",
		);

		for (const category of Object.keys(futureTask3Evidence)) {
			const invalidEvidence = {
				...futureTask3Evidence,
				[category]: genericRepositoryEvidence,
			};
			const rejected = await validateContractEvidence(
				completedManifest(invalidEvidence),
				"prepublish",
				{ resolveEvidenceReference: async () => undefined },
			);
			expect(rejected.errors.join("\n"), category).toContain(
				`requiresSaasMigration evidence ${category} must equal`,
			);
		}

		const missing = { ...futureTask3Evidence } as Record<string, string>;
		delete missing.runtime070Smoke;
		const missingResult = await validateContractEvidence(
			completedManifest(missing),
			"prepublish",
			{ resolveEvidenceReference: async () => undefined },
		);
		expect(missingResult.errors.join("\n")).toContain(
			"requiresSaasMigration evidence runtime070Smoke must equal",
		);

		const extraResult = await validateContractEvidence(
			completedManifest({ ...futureTask3Evidence, generic: genericRepositoryEvidence }),
			"prepublish",
			{ resolveEvidenceReference: async () => undefined },
		);
		expect(extraResult.errors).toContain(
			"requiresSaasMigration evidence has unknown category generic",
		);
	});

	test("requires a completed true SaaS migration declaration before prepublish", async () => {
		const falseDeclaration = manifest({
			requiresSaasMigration: {
				status: "complete",
				value: false,
				evidence: futureTask3Evidence,
			},
		});
		const rejected = await runValidator(falseDeclaration, "prepublish");
		expect(rejected.exitCode).toBe(1);
		expect(rejected.stderr).toContain(
			"requiresSaasMigration must be complete with value true",
		);
	});

	test("rejects placeholder, nonexistent, and unresolvable evidence references", async () => {
		for (const evidence of [
			"task3:migration-rehearsal",
			"test:scripts/does-not-exist.test.ts#missing behavior",
			"test:scripts/contract-evidence-validator.test.ts#missing behavior",
			"workflow:.github/workflows/release.yml#publish",
			"metadata:npm gitHead is created only by publication",
		]) {
			const result = await runValidator(
				manifest({ question: { id: 6, evidence: [evidence] } }),
			);
			expect(result.exitCode, evidence).toBe(1);
			expect(result.stderr, evidence).toContain("invalid evidence reference");
		}

		const migration = await validateContractEvidence(
			completedManifest(["task3:migration-rehearsal"]),
			"prepublish",
			{ resolveEvidenceReference: async () => undefined },
		);
		expect(migration.errors).toContain(
			"requiresSaasMigration evidence must use the exact Task 3 category contract",
		);
	});

	test("postpublish rejects all remaining pending_publish rows", async () => {
		const complete = completedManifest(futureTask3Evidence);
		const result = await validateContractEvidence(complete, "postpublish", {
			resolveEvidenceReference: async () => undefined,
		});
		expect(result.errors.join("\n")).toContain(
			"postpublish evidence cannot contain pending_publish",
		);
	});
});
