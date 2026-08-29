import {
	runThemeSpread as spreadFromClick,
	type ThemeSpreadOrigin,
} from "@hiai-gg/hiai-ui/lib/theme-spread";
import { tick } from "svelte";
import { browser } from "$app/environment";

export type Theme = "light" | "dark" | "system";
export type { ThemeSpreadOrigin };

const STORAGE_KEY = "hiai-docs-theme";

type Listener = () => void;
const listeners = new Set<Listener>();

function readStored(): Theme {
	if (!browser) return "system";
	const value = localStorage.getItem(STORAGE_KEY);
	if (value === "light" || value === "dark" || value === "system") return value;
	return "system";
}

function systemPrefersDark(): boolean {
	if (!browser) return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveIsDark(theme: Theme): boolean {
	if (theme === "dark") return true;
	if (theme === "light") return false;
	return systemPrefersDark();
}

function applyTheme(theme: Theme) {
	if (!browser) return;
	const isDark = resolveIsDark(theme);
	document.documentElement.classList.toggle("dark", isDark);
	const favicon = document.querySelector<HTMLLinkElement>("#app-favicon");
	if (favicon) favicon.href = isDark ? "/favicon_white.ico" : "/favicon.ico";
}

function notify() {
	for (const listener of listeners) listener();
}

// Runes-backed reactive state so `themeStore.value` / `.isDark` update the UI
// (e.g. the Settings theme picker highlight) when the theme changes.
let theme = $state<Theme>("system");
let resolvedIsDark = $state(false);
let initialized = false;

function initTheme() {
	if (!browser || initialized) return;
	initialized = true;
	theme = readStored();
	resolvedIsDark = resolveIsDark(theme);
	applyTheme(theme);

	const mql = window.matchMedia("(prefers-color-scheme: dark)");
	const onSystemChange = () => {
		if (theme !== "system") return;
		resolvedIsDark = mql.matches;
		applyTheme("system");
		notify();
	};
	mql.addEventListener("change", onSystemChange);
}

function setTheme(value: Theme) {
	theme = value;
	if (browser) {
		localStorage.setItem(STORAGE_KEY, value);
	}
	resolvedIsDark = resolveIsDark(value);
	applyTheme(value);
	notify();
}

/**
 * Product wrapper around hiai-ui `runThemeSpread`. Keeps light/dark/system
 * policy here; the circular View Transition lives in the design package.
 */
async function runThemeSpread(
	next: Theme,
	origin?: ThemeSpreadOrigin,
): Promise<void> {
	if (!browser) {
		setTheme(next);
		return;
	}
	if (theme === next) return;
	if (resolveIsDark(theme) === resolveIsDark(next) || !origin) {
		setTheme(next);
		return;
	}
	await spreadFromClick(async () => {
		setTheme(next);
		await tick();
	}, origin);
}

function getTheme(): Theme {
	return theme;
}

function getIsDark(): boolean {
	return resolvedIsDark;
}

function subscribeTheme(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export const themeStore = {
	get value(): Theme {
		return theme;
	},
	get isDark(): boolean {
		return resolvedIsDark;
	},
	init: initTheme,
	set: setTheme,
	spread: runThemeSpread,
};

export {
	getIsDark,
	getTheme,
	initTheme,
	runThemeSpread,
	setTheme,
	subscribeTheme,
};
