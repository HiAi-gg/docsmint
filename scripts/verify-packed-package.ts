import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(
	await readFile(join(root, "package.public.json"), "utf8"),
) as {
	name: string;
	version: string;
	files: string[];
	exports: Record<string, unknown>;
};
const runRoot = join(root, "build", `packed-package-${Date.now()}`);
const stage = join(runRoot, "stage");
const tarballs = join(runRoot, "tarballs");
const extracted = join(runRoot, "extract");
const temporaryDirectory = join(runRoot, "tmp");
await mkdir(stage, { recursive: true });
await mkdir(tarballs, { recursive: true });
await mkdir(extracted, { recursive: true });
await mkdir(temporaryDirectory, { recursive: true });

async function copyEntry(entry: string): Promise<void> {
	const source = entry === "dist" ? join(root, "packages/sdk/dist") : join(root, entry);
	const destination = join(stage, entry);
	await mkdir(dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: true });
}

await writeFile(
	join(stage, "package.json"),
	`${JSON.stringify(manifest, null, 2)}\n`,
);
for (const entry of manifest.files) await copyEntry(entry);

async function run(
	command: string[],
	cwd: string,
	expectSuccess = true,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const process = Bun.spawn(command, {
		cwd,
		env: { ...Bun.env, TMPDIR: temporaryDirectory },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (expectSuccess && exitCode !== 0) {
		throw new Error(
			`Command failed (${command.join(" ")}):\n${stdout}\n${stderr}`,
		);
	}
	return { stdout, stderr, exitCode };
}

const packed = await run(
	[
		"bun",
		"pm",
		"pack",
		"--ignore-scripts",
		"--destination",
		tarballs,
		"--quiet",
	],
	stage,
);
const tarballName = packed.stdout.trim().split("\n").at(-1);
if (!tarballName) throw new Error("bun pm pack did not report a tarball filename");
const tarball = isAbsolute(tarballName) ? tarballName : join(tarballs, tarballName);
const listing = (
	await run(["tar", "-tzf", tarball], root)
).stdout
	.split("\n")
	.filter(Boolean);
await run(["tar", "-xzf", tarball, "-C", extracted], root);
const packageRoot = join(extracted, "package");

const frontendSubpaths = [
	"dashboard",
	"search",
	"shared-document",
	"extension",
	"api/categories",
	"api/documents",
	"api/folders",
	"api/tags",
	"api/settings",
	"components/sidebar",
	"components/settings",
	"theme",
	"i18n",
] as const;

const requiredTarEntries = [
	"package/dist/index.js",
	"package/dist/index.d.ts",
	"package/dist/lifecycle.js",
	"package/dist/lifecycle.d.ts",
	"package/dist/workspace.js",
	"package/dist/workspace.d.ts",
	...frontendSubpaths.flatMap((path) => [
		`package/dist/frontend/${path}.js`,
		`package/dist/frontend/${path}.d.ts`,
	]),
];
for (const entry of requiredTarEntries) {
	if (!listing.includes(entry)) throw new Error(`Packed artifact is missing ${entry}`);
}
if (listing.some((entry) => entry.includes("frontend/src/") || entry.includes("node_modules/"))) {
	throw new Error("Packed artifact contains private frontend source or node_modules");
}

async function walk(directory: string): Promise<string[]> {
	const output: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) output.push(...(await walk(path)));
		else output.push(path);
	}
	return output;
}

for (const file of await walk(join(packageRoot, "dist"))) {
	if (!file.endsWith(".js")) continue;
	const source = await readFile(file, "utf8");
	const importSpecifiers = [...source.matchAll(/(?:from\s*|import\s*\()(["'])(.*?)\1/g)].map(
		(match) => match[2] ?? "",
	);
	for (const specifier of importSpecifiers) {
		if (
			specifier === "$lib" ||
			specifier.startsWith("$lib/") ||
			specifier.includes("frontend/src/") ||
			specifier.includes("packages/sdk/frontend-entries") ||
			specifier.includes("src/lib/paraglide")
		) {
			throw new Error(
				`Private runtime import ${specifier} in ${relative(packageRoot, file)}`,
			);
		}
	}
}

await writeFile(
	join(packageRoot, "server-import-smoke.ts"),
	`import { DocsClient } from "${manifest.name}";
import { encodeUserDataExportNdjson } from "${manifest.name}/lifecycle";
import { verifyDocsmintWorkspaceAssertion } from "${manifest.name}/workspace";
if (!DocsClient || !encodeUserDataExportNdjson || !verifyDocsmintWorkspaceAssertion) throw new Error("missing server export");
console.log("server imports: pass");
`,
);
await run(["bun", "server-import-smoke.ts"], packageRoot);

await writeFile(
	join(packageRoot, "svelte.config.js"),
	`import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default { preprocess: vitePreprocess(), kit: { adapter: adapter() } };
`,
);
for (const dependency of [
	"@sveltejs/kit",
	"@sveltejs/adapter-node",
	"@sveltejs/vite-plugin-svelte",
	"svelte",
	"vite",
]) {
	const link = join(packageRoot, "node_modules", dependency);
	await mkdir(dirname(link), { recursive: true });
	await symlink(join(root, "frontend/node_modules", dependency), link, "dir");
}
await writeFile(
	join(packageRoot, "declaration-smoke.ts"),
	`import { DocsClient } from "${manifest.name}";
import type { PurgeUserDataContext, UserDataExportRecord } from "${manifest.name}/lifecycle";
import type { DocsmintWorkspaceContext } from "${manifest.name}/workspace";
import { DocsmintDashboardHost } from "${manifest.name}/frontend/dashboard";
import { DocsmintSearchHost } from "${manifest.name}/frontend/search";
import { DocsmintSharedDocumentHost } from "${manifest.name}/frontend/shared-document";
import { DocsmintExtensionProvider, type DashboardWidgetProps, type DocTabPanelProps, type FrontendExtensions, type SharedDocumentExtensionContext } from "${manifest.name}/frontend/extension";
import { listCategories, type CategoryDto, type CreateCategoryInput } from "${manifest.name}/frontend/api/categories";
import { listDocuments, type DocumentDto, type UpdateDocumentInput } from "${manifest.name}/frontend/api/documents";
import { listFolders, type FolderDto, type CreateFolderData } from "${manifest.name}/frontend/api/folders";
import { listTags, type TagDto, type CreateTagInput } from "${manifest.name}/frontend/api/tags";
import { getProfile, type EmbeddingConfigDto, type ProfileDto } from "${manifest.name}/frontend/api/settings";
import { Sidebar } from "${manifest.name}/frontend/components/sidebar";
import { SettingsDialog } from "${manifest.name}/frontend/components/settings";
import { theme, setTheme, toggleTheme, type ThemeMode } from "${manifest.name}/frontend/theme";
import { messages, getMessage, setLocale, supportedLocales, type Locale } from "${manifest.name}/frontend/i18n";
void [DocsClient, DocsmintDashboardHost, DocsmintSearchHost, DocsmintSharedDocumentHost, DocsmintExtensionProvider, listCategories, listDocuments, listFolders, listTags, getProfile, Sidebar, SettingsDialog, theme, setTheme, toggleTheme, messages, getMessage, setLocale, supportedLocales];
type PublicTypes = PurgeUserDataContext | UserDataExportRecord | DocsmintWorkspaceContext | ThemeMode | Locale | CategoryDto | CreateCategoryInput | DocumentDto | UpdateDocumentInput | FolderDto | CreateFolderData | TagDto | CreateTagInput | ProfileDto | EmbeddingConfigDto | DashboardWidgetProps | DocTabPanelProps | SharedDocumentExtensionContext | FrontendExtensions;
declare const publicTypes: PublicTypes;
void publicTypes;
`,
);
await run(
	[
		"bun",
		join(root, "frontend/node_modules/typescript/bin/tsc"),
		"--ignoreConfig",
		"--noEmit",
		"--skipLibCheck",
		"--target",
		"ESNext",
		"--module",
		"ESNext",
		"--moduleResolution",
		"Bundler",
		"declaration-smoke.ts",
	],
	packageRoot,
);
await writeFile(
	join(packageRoot, "vite.config.ts"),
	`import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [sveltekit()] });
`,
);
await mkdir(join(packageRoot, "src/routes"), { recursive: true });
await writeFile(
	join(packageRoot, "src/app.html"),
	`<!doctype html><html lang="en"><head><meta charset="utf-8" />%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>`,
);
await writeFile(
	join(packageRoot, "src/routes/+page.svelte"),
	`<script lang="ts">
import { DocsmintDashboardHost } from "${manifest.name}/frontend/dashboard";
import { DocsmintSearchHost } from "${manifest.name}/frontend/search";
import { DocsmintSharedDocumentHost } from "${manifest.name}/frontend/shared-document";
import { DocsmintExtensionProvider } from "${manifest.name}/frontend/extension";
import * as categories from "${manifest.name}/frontend/api/categories";
import * as documents from "${manifest.name}/frontend/api/documents";
import * as folders from "${manifest.name}/frontend/api/folders";
import * as tags from "${manifest.name}/frontend/api/tags";
import * as settings from "${manifest.name}/frontend/api/settings";
import { Sidebar } from "${manifest.name}/frontend/components/sidebar";
import { SettingsDialog } from "${manifest.name}/frontend/components/settings";
import { theme, setTheme, toggleTheme } from "${manifest.name}/frontend/theme";
import { messages, getMessage, setLocale, supportedLocales } from "${manifest.name}/frontend/i18n";
const exportsExist = Boolean(DocsmintDashboardHost && DocsmintSearchHost && DocsmintSharedDocumentHost && DocsmintExtensionProvider && Sidebar && SettingsDialog && theme && setTheme && toggleTheme && messages && getMessage && setLocale && supportedLocales && categories && documents && folders && tags && settings);
</script>
<p data-exports={exportsExist}>packed frontend fixture</p>
`,
);
const viteBinary = join(root, "frontend/node_modules/vite/bin/vite.js");
await run(["bun", viteBinary, "build", "--configLoader", "runner"], packageRoot);

const browserConsumer = join(runRoot, "browser-consumer");
const packageLink = join(browserConsumer, "node_modules", "@hiai-gg", "docsmint");
await mkdir(dirname(packageLink), { recursive: true });
await symlink(packageRoot, packageLink, "dir");
await writeFile(
	join(browserConsumer, "workspace-browser-entry.ts"),
	`import { verifyDocsmintWorkspaceAssertion } from "${manifest.name}/workspace";
console.log(verifyDocsmintWorkspaceAssertion);
`,
);
await writeFile(
	join(browserConsumer, "workspace-browser.vite.config.ts"),
	`export default { resolve: { conditions: ["browser"] }, build: { lib: { entry: "workspace-browser-entry.ts", formats: ["es"] } } };
`,
);
const negative = await run(
	[
		"bun",
		viteBinary,
		"build",
		"--config",
		"workspace-browser.vite.config.ts",
		"--configLoader",
		"runner",
	],
	browserConsumer,
	false,
);
if (negative.exitCode === 0) {
	throw new Error("Server-only workspace export unexpectedly entered a browser bundle");
}

const sha256 = new Bun.CryptoHasher("sha256")
	.update(await Bun.file(tarball).arrayBuffer())
	.digest("hex");
await writeFile(
	join(runRoot, "package-report.json"),
	`${JSON.stringify(
		{
			package: `${manifest.name}@${manifest.version}`,
			tarball,
			sha256,
			entries: listing,
			checks: {
				serverImports: "passed",
				declarations: "passed",
				frontendSsrAndBrowserBuild: "passed",
				serverOnlyBrowserRejection: "passed",
				privateRuntimeImports: "passed",
			},
		},
		null,
		2,
	)}\n`,
);
console.log(`packed package fixture: pass (${tarball}, sha256=${sha256})`);
