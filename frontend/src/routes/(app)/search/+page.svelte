<script lang="ts">
import HiaiDocsSearchHost from "#lib/hosts/HiaiDocsSearchHost.svelte";
import type { PageData } from "./$types";

const { data } = $props<{ data: PageData }>();
</script>

<HiaiDocsSearchHost {data} />
