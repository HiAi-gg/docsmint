import {
	cp,
	mkdir,
	readdir,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
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
	const source =
		entry === "dist" ? join(root, "packages/sdk/dist") : join(root, entry);
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
if (!tarballName)
	throw new Error("bun pm pack did not report a tarball filename");
const tarball = isAbsolute(tarballName)
	? tarballName
	: join(tarballs, tarballName);
const listing = (await run(["tar", "-tzf", tarball], root)).stdout
	.split("\n")
	.filter(Boolean);
await run(["tar", "-xzf", tarball, "-C", extracted], root);
const packageRoot = join(extracted, "package");

const frontendSubpaths = [
	"app-shell",
	"dashboard",
	"search",
	"shared-document",
	"extension",
	"api/categories",
	"api/documents",
	"api/folders",
	"api/tags",
	"api/settings",
	"api/attachments",
	"api/share",
	"collaboration",
	"components/create-snapshot-dialog",
	"components/delete-dialog",
	"components/category-dialog",
	"components/folder-node",
	"document-drop-coordinator",
	"offline/identity",
	"doc-tabs",
	"types",
	"keyboard",
	"folder-refresh",
	"utils",
	"utils/clipboard",
	"utils/dndzone",
	"components/editor/document-editor",
	"components/folder-tree-selector",
	"components/save-as-dialog",
	"components/share-dialog",
	"components/tag-create-dialog",
	"components/version-history",
	"components/editor/document-title",
	"components/editor/markdown-toggle",
	"components/editor/extensions",
	"components/editor/markdown",
	"components/editor/docx-serializer",
	"components/sidebar",
	"components/settings",
	"theme",
	"i18n",
] as const;

// Component facades are compiled twice. The node condition must select the
// SSR compiler output; using the browser artifact during SvelteKit SSR causes
// `document is not defined` before the extension provider can establish
// request-scoped context.
const ssrComponentSubpaths = [
	"app-shell",
	"dashboard",
	"search",
	"shared-document",
	"extension",
	"components/create-snapshot-dialog",
	"components/delete-dialog",
	"components/category-dialog",
	"components/folder-node",
	"components/editor/document-editor",
	"components/folder-tree-selector",
	"components/save-as-dialog",
	"components/share-dialog",
	"components/tag-create-dialog",
	"components/version-history",
	"components/editor/document-title",
	"components/editor/markdown-toggle",
	"components/editor/extensions",
	"components/editor/markdown",
	"components/editor/docx-serializer",
	"components/sidebar",
	"components/settings",
] as const;

const requiredTarEntries = [
	"package/dist/index.js",
	"package/dist/index.d.ts",
	"package/dist/lifecycle.js",
	"package/dist/lifecycle.d.ts",
	"package/dist/lifecycle-persistent.js",
	"package/dist/lifecycle-persistent.d.ts",
	"package/dist/server-only-browser-entry.js",
	"package/dist/workspace.js",
	"package/dist/workspace.d.ts",
	"package/dist/backend-launcher.js",
	"package/dist/backend-launcher.d.ts",
	"package/dist/backend/index.js",
	"package/dist/storage-quota.js",
	"package/dist/storage-quota.d.ts",
	"package/dist/frontend/frontend.css",
	...frontendSubpaths.flatMap((path) => [
		`package/dist/frontend/${path}.js`,
		`package/dist/frontend/${path}.d.ts`,
	]),
	...ssrComponentSubpaths.map(
		(path) => `package/dist/frontend-ssr/${path}.js`,
	),
];
for (const entry of requiredTarEntries) {
	if (!listing.includes(entry))
		throw new Error(`Packed artifact is missing ${entry}`);
}
const packagedFrontendStyles = await readFile(
	join(packageRoot, "dist", "frontend", "frontend.css"),
	"utf8",
);
if (!packagedFrontendStyles.includes("--layer-chrome")) {
	throw new Error(
		"Packed frontend stylesheet is missing DocsMint application layout utilities",
	);
}
for (const [subpath, conditionMap] of Object.entries(manifest.exports)) {
	if (typeof conditionMap !== "object" || conditionMap === null) continue;
	for (const target of Object.values(conditionMap as Record<string, unknown>)) {
		if (typeof target !== "string" || !target.startsWith("./")) continue;
		if (!listing.includes(`package/${target.slice(2)}`)) {
			throw new Error(`Export target is missing for ${subpath}: ${target}`);
		}
	}
}
for (const subpath of ssrComponentSubpaths) {
	const exportPath = `./frontend/${subpath}`;
	const conditions = manifest.exports[exportPath] as
		| Record<string, unknown>
		| undefined;
	if (
		conditions?.node !== `./dist/frontend-ssr/${subpath}.js` ||
		conditions.import !== `./dist/frontend/${subpath}.js`
	) {
		throw new Error(
			`Component facade ${exportPath} must publish matching node and browser artifacts`,
		);
	}
}
if (
	listing.some(
		(entry) =>
			entry.includes("frontend/src/") || entry.includes("node_modules/"),
	)
) {
	throw new Error(
		"Packed artifact contains private frontend source or node_modules",
	);
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

const packedRuntimeSources: Array<{ file: string; source: string }> = [];
for (const file of await walk(join(packageRoot, "dist"))) {
	if (!file.endsWith(".js")) continue;
	const source = await readFile(file, "utf8");
	packedRuntimeSources.push({ file, source });
	const importSpecifiers = [
		...source.matchAll(/(?:from\s*|import\s*\()(["'])(.*?)\1/g),
	].map((match) => match[2] ?? "");
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

const packagedFrontendFiles = packedRuntimeSources.filter(({ file }) =>
	file.startsWith(join(packageRoot, "dist", "frontend")),
);
const packageLocalSvelteRuntimeChunks = packagedFrontendFiles
	.filter(
		({ file, source }) =>
			/\/client-[^/]+\.js$/.test(file) && source.includes("svelte/internal/"),
	)
	.map(({ file }) => file);
if (
	packageLocalSvelteRuntimeChunks.length > 0
) {
	throw new Error(
		"Packed frontend facade bundles a package-local client runtime chunk",
	);
}
if (
	!packagedFrontendFiles.some(({ source }) =>
		source.includes('from "svelte/internal/client"'),
	)
) {
	throw new Error(
		"Packed frontend facades do not retain the consumer Svelte runtime import",
	);
}

await writeFile(
	join(packageRoot, "server-import-smoke.ts"),
	`import { DocsClient } from "${manifest.name}";
import { encodeUserDataExportNdjson } from "${manifest.name}/lifecycle";
import { createPersistentLifecycleRuntime } from "${manifest.name}/lifecycle/persistent";
import { createPersistentLifecycleRuntime as createDurableLifecycleRuntime } from "${manifest.name}/lifecycle/runtime";
import { verifyDocsmintWorkspaceAssertion } from "${manifest.name}/workspace";
import { launchDocsmintBackend, launchDocsMintApi, resolveDocsmintBackendEntrypoint } from "${manifest.name}/backend/launcher";
import { createStorageQuotaService, StorageQuotaExceededError, requireAttachmentStorageQuotaAdmission } from "${manifest.name}/storage-quota";
if (!DocsClient || !encodeUserDataExportNdjson || !createPersistentLifecycleRuntime || !createDurableLifecycleRuntime || !verifyDocsmintWorkspaceAssertion || !launchDocsmintBackend || !launchDocsMintApi || !resolveDocsmintBackendEntrypoint || !createStorageQuotaService || !StorageQuotaExceededError || !requireAttachmentStorageQuotaAdmission) throw new Error("missing server export");
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
	"yjs",
	"y-websocket",
	"svelte-dnd-action",
	"clsx",
	"tailwind-merge",
	"tailwind-variants",
	"lucide-svelte",
	"bits-ui",
	"zod",
	"nanostores",
	"dexie",
	"@hiai-gg/hiai-ui",
	"@better-auth/core",
	"@tiptap/core",
	"@tiptap/extension-code-block",
	"@tiptap/extension-code-block-lowlight",
	"@tiptap/extension-collaboration",
	"@tiptap/extension-collaboration-cursor",
	"@tiptap/extension-highlight",
	"@tiptap/extension-image",
	"@tiptap/extension-link",
	"@tiptap/extension-list",
	"@tiptap/extension-table",
	"@tiptap/extension-text-align",
	"@tiptap/extension-underline",
	"@tiptap/markdown",
	"@tiptap/html",
	"@tiptap/pm",
	"@tiptap/starter-kit",
	"highlight.js",
	"lowlight",
	"svelte-tiptap",
	"y-prosemirror",
]) {
	const link = join(packageRoot, "node_modules", dependency);
	await mkdir(dirname(link), { recursive: true });
	await symlink(join(root, "frontend/node_modules", dependency), link, "dir");
}
// Keep the fixture aligned with the complete frontend dependency surface. A
// facade can legally retain a peer import that is not exercised by the small
// smoke page above; the consumer must still be able to resolve it from its
// own installed framework graph.
const frontendPackage = JSON.parse(
	await readFile(join(root, "frontend/package.json"), "utf8"),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
for (const dependency of new Set([
	...Object.keys(frontendPackage.dependencies ?? {}),
	...Object.keys(frontendPackage.devDependencies ?? {}),
])) {
	const link = join(packageRoot, "node_modules", dependency);
	try {
		await mkdir(dirname(link), { recursive: true });
		await symlink(join(root, "frontend/node_modules", dependency), link, "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}
await writeFile(
	join(packageRoot, "declaration-smoke.ts"),
	`import { DocsClient } from "${manifest.name}";
import type { PurgeUserDataContext, UserDataExportRecord } from "${manifest.name}/lifecycle";
import type { LifecycleRuntimeAdapters } from "${manifest.name}/lifecycle/persistent";
import type { LifecycleRuntimeAdapters as DurableLifecycleRuntimeAdapters, LifecycleScopedDatabaseExecutor as DurableLifecycleDatabaseExecutor } from "${manifest.name}/lifecycle/runtime";
import type { DocsmintWorkspaceContext } from "${manifest.name}/workspace";
import { launchDocsmintBackend, launchDocsMintApi, type DocsmintBackendHandle, type DocsMintRuntimeOptions } from "${manifest.name}/backend/launcher";
import { createStorageQuotaService, StorageQuotaExceededError, type AttachmentStorageQuotaAdmission, type AttachmentStorageQuotaContext, type AttachmentStorageQuotaFinalization, type StorageQuotaAdapter, type StorageQuotaReservation } from "${manifest.name}/storage-quota";
import { DocsmintDashboardHost } from "${manifest.name}/frontend/dashboard";
import { DocsmintSearchHost } from "${manifest.name}/frontend/search";
import { DocsmintSharedDocumentHost } from "${manifest.name}/frontend/shared-document";
import { DocsmintExtensionProvider, type DashboardWidgetProps, type DocTabPanelProps, type FrontendExtensions, type SharedDocumentExtensionContext } from "${manifest.name}/frontend/extension";
import { listCategories, type CategoryDto, type CreateCategoryInput } from "${manifest.name}/frontend/api/categories";
import { listDocuments, type DocumentDto, type UpdateDocumentInput } from "${manifest.name}/frontend/api/documents";
import { listFolders, type FolderDto, type CreateFolderData } from "${manifest.name}/frontend/api/folders";
import { listTags, type TagDto, type CreateTagInput } from "${manifest.name}/frontend/api/tags";
import { getProfile, type EmbeddingConfigDto, type ProfileDto } from "${manifest.name}/frontend/api/settings";
import { uploadAttachment, type Attachment } from "${manifest.name}/frontend/api/attachments";
import { createShareLink, type CreateShareLinkInput, type ShareLink } from "${manifest.name}/frontend/api/share";
import { startCollaboration, type CollaborationSession } from "${manifest.name}/frontend/collaboration";
import { CreateSnapshotDialog } from "${manifest.name}/frontend/components/create-snapshot-dialog";
import { DeleteDialog } from "${manifest.name}/frontend/components/delete-dialog";
import { CategoryDialog } from "${manifest.name}/frontend/components/category-dialog";
import { FolderNode, type FolderNodeItem } from "${manifest.name}/frontend/components/folder-node";
import { createDocumentDropCoordinator, type SidebarDocumentPlacement } from "${manifest.name}/frontend/document-drop-coordinator";
import { resolveOfflineIdentity, type OfflineIdentity } from "${manifest.name}/frontend/offline/identity";
import { createDocTabRegistry, type DocTabDefinition as PublicDocTabDefinition } from "${manifest.name}/frontend/doc-tabs";
import { type Document as FrontendDocument, type Folder as FrontendFolder, type Tag as FrontendTag } from "${manifest.name}/frontend/types";
import { registerShortcut, type Shortcut } from "${manifest.name}/frontend/keyboard";
import { refreshFolders } from "${manifest.name}/frontend/folder-refresh";
import { cn, formatRelativeTime } from "${manifest.name}/frontend/utils";
import { copyToClipboard } from "${manifest.name}/frontend/utils/clipboard";
import { dndzone, type Item } from "${manifest.name}/frontend/utils/dndzone";
import { Sidebar } from "${manifest.name}/frontend/components/sidebar";
import { SettingsDialog } from "${manifest.name}/frontend/components/settings";
import { theme, setTheme, toggleTheme, type ThemeMode } from "${manifest.name}/frontend/theme";
import { messages, getMessage, setLocale, supportedLocales, type Locale } from "${manifest.name}/frontend/i18n";
void [DocsClient, launchDocsmintBackend, launchDocsMintApi, createStorageQuotaService, StorageQuotaExceededError, DocsmintDashboardHost, DocsmintSearchHost, DocsmintSharedDocumentHost, DocsmintExtensionProvider, listCategories, listDocuments, listFolders, listTags, getProfile, uploadAttachment, createShareLink, startCollaboration, CreateSnapshotDialog, DeleteDialog, CategoryDialog, FolderNode, createDocumentDropCoordinator, resolveOfflineIdentity, createDocTabRegistry, registerShortcut, refreshFolders, cn, formatRelativeTime, copyToClipboard, dndzone, Sidebar, SettingsDialog, theme, setTheme, toggleTheme, messages, getMessage, setLocale, supportedLocales];
type PublicTypes = PurgeUserDataContext | UserDataExportRecord | LifecycleRuntimeAdapters | DocsmintWorkspaceContext | DocsmintBackendHandle | DocsMintRuntimeOptions | StorageQuotaAdapter | StorageQuotaReservation | AttachmentStorageQuotaAdmission | AttachmentStorageQuotaContext | AttachmentStorageQuotaFinalization | ThemeMode | Locale | CategoryDto | CreateCategoryInput | DocumentDto | UpdateDocumentInput | FolderDto | CreateFolderData | TagDto | CreateTagInput | ProfileDto | EmbeddingConfigDto | Attachment | CreateShareLinkInput | ShareLink | CollaborationSession | FolderNodeItem | SidebarDocumentPlacement | OfflineIdentity | PublicDocTabDefinition | FrontendDocument | FrontendFolder | FrontendTag | Shortcut | Item | DashboardWidgetProps | DocTabPanelProps | SharedDocumentExtensionContext | FrontendExtensions;
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
await mkdir(join(packageRoot, "src/lib"), { recursive: true });
await writeFile(
	join(packageRoot, "src/app.html"),
	`<!doctype html><html lang="en"><head><meta charset="utf-8" />%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>`,
);
await writeFile(
	join(packageRoot, "src/lib/FixtureWidget.svelte"),
	`<script lang="ts">let { userId }: { userId?: string } = $props();</script><p data-fixture-widget>{userId ?? "anonymous"}</p>`,
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
import * as attachments from "${manifest.name}/frontend/api/attachments";
import * as share from "${manifest.name}/frontend/api/share";
import * as collaboration from "${manifest.name}/frontend/collaboration";
import { CreateSnapshotDialog } from "${manifest.name}/frontend/components/create-snapshot-dialog";
import { DeleteDialog } from "${manifest.name}/frontend/components/delete-dialog";
import { CategoryDialog } from "${manifest.name}/frontend/components/category-dialog";
import { FolderNode } from "${manifest.name}/frontend/components/folder-node";
import { DocsmintDocumentEditorHost } from "${manifest.name}/frontend/components/editor/document-editor";
import * as documentDrop from "${manifest.name}/frontend/document-drop-coordinator";
import * as offlineIdentity from "${manifest.name}/frontend/offline/identity";
import * as docTabs from "${manifest.name}/frontend/doc-tabs";
import * as types from "${manifest.name}/frontend/types";
import * as keyboard from "${manifest.name}/frontend/keyboard";
import * as folderRefresh from "${manifest.name}/frontend/folder-refresh";
import * as utils from "${manifest.name}/frontend/utils";
import * as clipboard from "${manifest.name}/frontend/utils/clipboard";
import * as dnd from "${manifest.name}/frontend/utils/dndzone";
import { Sidebar } from "${manifest.name}/frontend/components/sidebar";
import { SettingsDialog } from "${manifest.name}/frontend/components/settings";
import { theme, setTheme, toggleTheme } from "${manifest.name}/frontend/theme";
import { messages, getMessage, setLocale, supportedLocales } from "${manifest.name}/frontend/i18n";
import FixtureWidget from "$lib/FixtureWidget.svelte";
const exportsExist = Boolean(DocsmintDashboardHost && DocsmintSearchHost && DocsmintSharedDocumentHost && DocsmintExtensionProvider && Sidebar && SettingsDialog && theme && setTheme && toggleTheme && messages && getMessage && setLocale && supportedLocales && categories && documents && folders && tags && settings && attachments && share && collaboration && CreateSnapshotDialog && DeleteDialog && CategoryDialog && FolderNode && documentDrop && offlineIdentity && docTabs && types && keyboard && folderRefresh && utils && clipboard && dnd);
const extensions = { dashboardWidgets: [{ id: "fixture-widget", component: FixtureWidget }] };
const dashboardData = { categories: [], tags: [], activeFolder: null, breadcrumb: [], rootFolders: [], recentDocs: [] };
</script>
<p data-exports={exportsExist}>packed frontend fixture</p>
<DocsmintExtensionProvider {extensions}>
  <DocsmintDashboardHost data={dashboardData} extensionContext={{ pathname: "/fixture" }} />
  <Sidebar />
  <SettingsDialog open={false} />
  <CreateSnapshotDialog open={false} documentId="fixture-document" />
  <DeleteDialog open={false} targetName="fixture" title="Delete" description="fixture" successTitle="Deleted" successDescription="fixture" />
  <DocsmintDocumentEditorHost content="" documentId="fixture-document" />
</DocsmintExtensionProvider>
`,
);
// Building a SvelteKit route proves that the consumer can compile the facade
// through its SSR pipeline. The fixture deliberately remains request-bound:
// several editor components read the current URL and therefore cannot be
// prerendered without inventing a product route context.
await writeFile(
	join(packageRoot, "src/routes/+page.ts"),
	"export const prerender = false;\n",
);
await writeFile(
	join(packageRoot, "src/hooks.server.ts"),
	`export function handleError({ error }: { error: unknown }) {
  console.error("packed-frontend-ssr-error", error instanceof Error ? error.stack ?? error.message : String(error));
}
`,
);
const viteBinary = join(root, "frontend/node_modules/vite/bin/vite.js");
await run(
	["bun", viteBinary, "build", "--configLoader", "runner"],
	packageRoot,
);

const browserConsumer = join(runRoot, "browser-consumer");
const packageLink = join(
	browserConsumer,
	"node_modules",
	"@hiai-gg",
	"docsmint",
);
await mkdir(dirname(packageLink), { recursive: true });
await symlink(packageRoot, packageLink, "dir");
const serverOnlyBrowserChecks = [
	{
		id: "workspace",
		subpath: "workspace",
		symbol: "verifyDocsmintWorkspaceAssertion",
	},
	{
		id: "lifecycle-persistent",
		subpath: "lifecycle/persistent",
		symbol: "createPersistentLifecycleRuntime",
	},
	{
		id: "lifecycle-runtime",
		subpath: "lifecycle/runtime",
		symbol: "createPersistentLifecycleRuntime",
	},
	{
		id: "backend-launcher",
		subpath: "backend/launcher",
		symbol: "launchDocsmintBackend",
	},
	{
		id: "storage-quota",
		subpath: "storage-quota",
		symbol: "createStorageQuotaService",
	},
] as const;
for (const check of serverOnlyBrowserChecks) {
	const entry = `${check.id}-browser-entry.ts`;
	const config = `${check.id}-browser.vite.config.ts`;
	await writeFile(
		join(browserConsumer, entry),
		`import { ${check.symbol} } from "${manifest.name}/${check.subpath}";
console.log(${check.symbol});
`,
	);
	await writeFile(
		join(browserConsumer, config),
		`export default { resolve: { conditions: ["browser"] }, build: { lib: { entry: "${entry}", formats: ["es"] } } };
`,
	);
	const browserBuild = await run(
		[
			"bun",
			viteBinary,
			"build",
			"--config",
			config,
			"--configLoader",
			"runner",
		],
		browserConsumer,
		false,
	);
	if (browserBuild.exitCode === 0) {
		throw new Error(
			`Server-only ${check.subpath} export unexpectedly entered a browser bundle`,
		);
	}
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
				frontendProviderConsumerBuild: "passed",
				serverOnlyBrowserRejection: "passed",
				privateRuntimeImports: "passed",
			},
		},
		null,
		2,
	)}\n`,
);
console.log(`packed package fixture: pass (${tarball}, sha256=${sha256})`);
