<script lang="ts">
import HiaiDocsDashboardHost from "#lib/hosts/HiaiDocsDashboardHost.svelte";
import type { PageData } from "./$types";

const { data } = $props<{ data: PageData }>();
</script>

<HiaiDocsDashboardHost {data} />
