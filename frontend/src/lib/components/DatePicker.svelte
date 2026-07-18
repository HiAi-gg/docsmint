<!-- DatePicker.svelte — Self-contained, theme-token-styled date picker.
     Replaces the native <input type="date"> whose popup calendar ignores
     `accent-color` in Chrome and renders a fixed blue. This calendar uses
     our CSS variables, so the selected day follows the brand accent
     (--primary) in both light and dark themes. Value is an ISO date string
     ("YYYY-MM-DD") or "" when unset. -->
<script lang="ts">
import { Calendar, ChevronLeft, ChevronRight } from "lucide-svelte";
import * as m from "$lib/paraglide/messages.js";

let {
	value = $bindable(""),
	onchange,
	id,
	ariaLabel = m.date_picker_aria(),
	placeholder = m.date_picker_placeholder(),
}: {
	value?: string;
	onchange?: () => void;
	id?: string;
	ariaLabel?: string;
	placeholder?: string;
} = $props();

let open = $state(false);
let root = $state<HTMLDivElement | null>(null);

const WEEKDAYS = [
	m.weekday_mo(),
	m.weekday_tu(),
	m.weekday_we(),
	m.weekday_th(),
	m.weekday_fr(),
	m.weekday_sa(),
	m.weekday_su(),
];
const MONTHS = [
	m.month_january(),
	m.month_february(),
	m.month_march(),
	m.month_april(),
	m.month_may(),
	m.month_june(),
	m.month_july(),
	m.month_august(),
	m.month_september(),
	m.month_october(),
	m.month_november(),
	m.month_december(),
];

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function parse(v: string): { y: number; m: number; d: number } | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
	if (!match) return null;
	return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

const today = new Date();
let viewYear = $state(today.getFullYear());
let viewMonth = $state(today.getMonth());

// Sync the visible month to the selected value when opening.
$effect(() => {
	if (open) {
		const p = parse(value);
		if (p) {
			viewYear = p.y;
			viewMonth = p.m;
		}
	}
});

const selected = $derived(parse(value));

function daysGrid(): Array<number | null> {
	const firstWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sun
	const offset = (firstWeekday + 6) % 7; // shift to Monday-first
	const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
	const cells: Array<number | null> = [];
	for (let i = 0; i < offset; i++) cells.push(null);
	for (let d = 1; d <= daysInMonth; d++) cells.push(d);
	return cells;
}

function isToday(d: number): boolean {
	return (
		d === today.getDate() &&
		viewMonth === today.getMonth() &&
		viewYear === today.getFullYear()
	);
}

function isSelected(d: number): boolean {
	return (
		selected !== null &&
		selected.y === viewYear &&
		selected.m === viewMonth &&
		selected.d === d
	);
}

function pick(d: number) {
	value = `${viewYear}-${pad(viewMonth + 1)}-${pad(d)}`;
	open = false;
	onchange?.();
}

function clear() {
	value = "";
	open = false;
	onchange?.();
}

function prevMonth() {
	if (viewMonth === 0) {
		viewMonth = 11;
		viewYear -= 1;
	} else {
		viewMonth -= 1;
	}
}

function nextMonth() {
	if (viewMonth === 11) {
		viewMonth = 0;
		viewYear += 1;
	} else {
		viewMonth += 1;
	}
}

$effect(() => {
	if (!open) return;
	function onDocPointer(e: PointerEvent) {
		if (root && !root.contains(e.target as Node)) open = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === "Escape") open = false;
	}
	document.addEventListener("pointerdown", onDocPointer);
	document.addEventListener("keydown", onKey);
	return () => {
		document.removeEventListener("pointerdown", onDocPointer);
		document.removeEventListener("keydown", onKey);
	};
});
</script>

<div class="datepicker" bind:this={root}>
	<button
		type="button"
		{id}
		aria-label={ariaLabel}
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = !open)}
		class="dp-trigger"
	>
		<Calendar class="size-3.5 shrink-0 opacity-70" />
		<span class={value ? "" : "dp-placeholder"}>{value || placeholder}</span>
	</button>

	{#if open}
		<div class="dp-popover" role="dialog" aria-label={ariaLabel}>
			<div class="dp-header">
				<button type="button" class="dp-nav" onclick={prevMonth} aria-label={m.date_picker_prev_month()}>
					<ChevronLeft class="size-4" />
				</button>
				<span class="dp-title">{MONTHS[viewMonth]} {viewYear}</span>
				<button type="button" class="dp-nav" onclick={nextMonth} aria-label={m.date_picker_next_month()}>
					<ChevronRight class="size-4" />
				</button>
			</div>
			<div class="dp-weekdays">
				{#each WEEKDAYS as wd (wd)}<span class="dp-weekday">{wd}</span>{/each}
			</div>
			<div class="dp-grid">
				{#each daysGrid() as d, i (i)}
					{#if d === null}
						<span class="dp-empty"></span>
					{:else}
						<button
							type="button"
							class="dp-day"
							class:selected={isSelected(d)}
							class:today={isToday(d)}
							onclick={() => pick(d)}
						>{d}</button>
					{/if}
				{/each}
			</div>
			{#if value}
				<button type="button" class="dp-clear" onclick={clear}>{m.date_picker_clear()}</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.datepicker {
		position: relative;
	}
	.dp-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 2.25rem;
		width: 100%;
		padding: 0 0.625rem;
		border: 1px solid var(--input);
		border-radius: 6px;
		background: transparent;
		color: var(--foreground);
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}
	.dp-trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 1px var(--ring);
	}
	.dp-placeholder {
		color: var(--muted-foreground);
	}
	.dp-popover {
		position: absolute;
		z-index: var(--layer-popover);
		top: calc(100% + 4px);
		left: 0;
		width: 16rem;
		padding: 8px;
		background: var(--popover);
		color: var(--popover-foreground);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
	}
	.dp-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.dp-title {
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.dp-nav {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 6px;
		background: transparent;
		border: none;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.dp-nav:hover {
		background: var(--accent);
		color: var(--accent-foreground);
	}
	.dp-weekdays,
	.dp-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
	}
	.dp-weekday {
		text-align: center;
		font-size: 0.6875rem;
		color: var(--muted-foreground);
		padding: 2px 0;
	}
	.dp-empty {
		aspect-ratio: 1;
	}
	.dp-day {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--foreground);
		font-size: 0.8125rem;
		cursor: pointer;
	}
	.dp-day:hover {
		background: var(--accent);
		color: var(--accent-foreground);
	}
	.dp-day.today {
		box-shadow: inset 0 0 0 1px var(--ring);
	}
	.dp-day.selected,
	.dp-day.selected:hover {
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.dp-clear {
		margin-top: 6px;
		width: 100%;
		padding: 4px 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
	}
	.dp-clear:hover {
		background: var(--accent);
		color: var(--accent-foreground);
	}
</style>
