<script lang="ts">
  import { History, RotateCcw, Clock } from "lucide-svelte";
  import * as m from "$lib/paraglide/messages.js";

  interface Version {
    id: string;
    createdAt: string;
    preview: string;
  }

  let { documentId }: { documentId: string } = $props();

  const versions: Version[] = [
    { id: "v5", createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(), preview: "Updated introduction paragraph and added new section..." },
    { id: "v4", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), preview: "Fixed typos in configuration section..." },
    { id: "v3", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(), preview: "Added code examples and API reference links..." },
    { id: "v2", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), preview: "Expanded troubleshooting section..." },
    { id: "v1", createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(), preview: "Initial document creation..." },
  ];

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return m.time_minutes_ago({ count: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return m.time_hours_ago({ count: hrs });
    return m.time_days_ago({ count: Math.floor(hrs / 24) });
  }
</script>

<div class="flex flex-col gap-2 p-4">
  <div class="flex items-center gap-2 text-sm font-medium text-foreground">
    <History class="h-4 w-4" />
    <span>{m.version_history_title()}</span>
  </div>

  <div class="flex flex-col gap-1 overflow-y-auto max-h-80">
    {#each versions as version (version.id)}
      <div class="flex items-start gap-3 rounded-md border border-border p-3 text-sm hover:bg-accent transition-colors">
        <Clock class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted-foreground">{relativeTime(version.createdAt)}</span>
            <button
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
              title={m.version_restore()}
            >
              <RotateCcw class="h-3 w-3" />
              {m.version_restore_short()}
            </button>
          </div>
          <p class="mt-1 truncate text-xs text-muted-foreground">{version.preview}</p>
        </div>
      </div>
    {/each}
  </div>
</div>
