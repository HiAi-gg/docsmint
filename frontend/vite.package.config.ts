import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const entries = {
	dashboard: "../packages/sdk/frontend-entries/dashboard.ts",
	search: "../packages/sdk/frontend-entries/search.ts",
	"shared-document": "../packages/sdk/frontend-entries/shared-document.ts",
	extension: "../packages/sdk/frontend-entries/extension.ts",
	"api/categories": "../packages/sdk/frontend-entries/api/categories.ts",
	"api/documents": "../packages/sdk/frontend-entries/api/documents.ts",
	"api/folders": "../packages/sdk/frontend-entries/api/folders.ts",
	"api/tags": "../packages/sdk/frontend-entries/api/tags.ts",
	"api/settings": "../packages/sdk/frontend-entries/api/settings.ts",
	"api/attachments": "../packages/sdk/frontend-entries/api/attachments.ts",
	collaboration: "../packages/sdk/frontend-entries/collaboration.ts",
	"components/create-snapshot-dialog":
		"../packages/sdk/frontend-entries/components/create-snapshot-dialog.ts",
	"components/delete-dialog":
		"../packages/sdk/frontend-entries/components/delete-dialog.ts",
	"components/category-dialog":
		"../packages/sdk/frontend-entries/components/category-dialog.ts",
	"components/folder-node":
		"../packages/sdk/frontend-entries/components/folder-node.ts",
	"document-drop-coordinator":
		"../packages/sdk/frontend-entries/document-drop-coordinator.ts",
	"offline/identity": "../packages/sdk/frontend-entries/offline/identity.ts",
	"doc-tabs": "../packages/sdk/frontend-entries/doc-tabs.ts",
	types: "../packages/sdk/frontend-entries/types.ts",
	keyboard: "../packages/sdk/frontend-entries/keyboard.ts",
	"folder-refresh": "../packages/sdk/frontend-entries/folder-refresh.ts",
	utils: "../packages/sdk/frontend-entries/utils/index.ts",
	"utils/clipboard": "../packages/sdk/frontend-entries/utils/clipboard.ts",
	"utils/dndzone": "../packages/sdk/frontend-entries/utils/dndzone.ts",
	"api/share": "../packages/sdk/frontend-entries/api/share.ts",
	"components/editor/document-editor":
		"../packages/sdk/frontend-entries/components/editor/document-editor.ts",
	"components/folder-tree-selector":
		"../packages/sdk/frontend-entries/components/folder-tree-selector.ts",
	"components/save-as-dialog":
		"../packages/sdk/frontend-entries/components/save-as-dialog.ts",
	"components/share-dialog":
		"../packages/sdk/frontend-entries/components/share-dialog.ts",
	"components/tag-create-dialog":
		"../packages/sdk/frontend-entries/components/tag-create-dialog.ts",
	"components/version-history":
		"../packages/sdk/frontend-entries/components/version-history.ts",
	"components/editor/document-title":
		"../packages/sdk/frontend-entries/components/editor/document-title.ts",
	"components/editor/markdown-toggle":
		"../packages/sdk/frontend-entries/components/editor/markdown-toggle.ts",
	"components/editor/extensions":
		"../packages/sdk/frontend-entries/components/editor/extensions.ts",
	"components/editor/markdown":
		"../packages/sdk/frontend-entries/components/editor/markdown.ts",
	"components/editor/docx-serializer":
		"../packages/sdk/frontend-entries/components/editor/docx-serializer.ts",
	"components/sidebar": "../packages/sdk/frontend-entries/components/sidebar.ts",
	"components/settings": "../packages/sdk/frontend-entries/components/settings.ts",
	theme: "../packages/sdk/frontend-entries/theme.ts",
	i18n: "../packages/sdk/frontend-entries/i18n.ts",
};

/** Packaging-only build: it never changes the standalone SvelteKit app. */
export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			$lib: `${root}/frontend/src/lib`,
		},
	},
	build: {
		outDir: "../packages/sdk/dist/frontend",
		emptyOutDir: true,
		lib: { entry: entries, formats: ["es"] },
		rollupOptions: {
			external: [
				"svelte",
				"svelte/internal",
				"$app/navigation",
				"$app/state",
				"$app/environment",
			],
		},
	},
});
