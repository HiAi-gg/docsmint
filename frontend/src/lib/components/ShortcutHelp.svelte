<!-- ShortcutHelp.svelte — `?` overlay listing all currently registered
     keyboard shortcuts. Reads directly from the keyboard store's
     `getShortcutsByScope` API so the list updates when other components
     register shortcuts (e.g. the editor mounting on a doc page adds
     Cmd+Shift+7 here automatically). Closes on Escape or backdrop
     click. Lazy loaded by the root layout. -->
<script lang="ts">
import { Keyboard, X } from "lucide-svelte";
import * as m from "#lib/paraglide/messages.js";
import {
	getIsShortcutHelpOpen,
	getShortcutsByScope,
	type Shortcut,
	type ShortcutScope,
	setShortcutHelpOpen,
} from "#lib/stores/keyboard.svelte.js";

const SCOPE_LABELS: Record<ShortcutScope, () => string> = {
	global: m.shortcut_help_section_global,
	editor: m.shortcut_help_section_editor,
	dialog: m.shortcut_help_section_dialog,
	list: m.shortcut_help_section_list,
};

const SCOPES_ORDER: ShortcutScope[] = ["global", "editor", "dialog", "list"];

const isOpen = $derived(getIsShortcutHelpOpen());

function close() {
	setShortcutHelpOpen(false);
}

function onKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		e.preventDefault();
		close();
	}
}

function scopeLabel(scope: ShortcutScope): string {
	return SCOPE_LABELS[scope]();
}

function isVisible(s: Shortcut): boolean {
	return s.enabled !== false;
}
</script>

{#if isOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    onclick={close}
    onkeydown={onKeydown}
    role="presentation"
  >
    <div
      class="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={m.shortcut_help_title()}
    >
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <Keyboard class="size-4 text-muted-foreground" />
          <h2 class="text-sm font-semibold">{m.shortcut_help_title()}</h2>
        </div>
        <button
          type="button"
          onclick={close}
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={m.shortcut_help_close()}
        >
          <X class="size-4" />
        </button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto px-4 py-3">
        {#each SCOPES_ORDER as scope (scope)}
          {@const shortcuts = getShortcutsByScope(scope).filter(isVisible)}
          {#if shortcuts.length > 0}
            <section class="mb-4 last:mb-0">
              <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {scopeLabel(scope)}
              </h3>
              <ul class="space-y-1.5">
                {#each shortcuts as s (s.id)}
                  <li class="text-sm text-muted-foreground">{s.description}</li>
                {/each}
              </ul>
            </section>
          {/if}
        {/each}
        {#if SCOPES_ORDER.every((scope) => getShortcutsByScope(scope).filter(isVisible).length === 0)}
          <p class="py-4 text-center text-sm text-muted-foreground">
            {m.shortcut_help_no_shortcuts()}
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}
