import { describe, expect, test } from "bun:test";

const layout = await Bun.file(
	`${import.meta.dir}/../../routes/(app)/+layout.svelte`,
).text();
const sidebar = await Bun.file(
	`${import.meta.dir}/sidebar/Sidebar.svelte`,
).text();
const toggle = await Bun.file(
	`${import.meta.dir}/MobileSidebarToggle.svelte`,
).text();
const host = await Bun.file(
	`${import.meta.dir}/../hosts/DocsmintAppShellHost.svelte`,
).text();

describe("responsive app shell", () => {
	test("uses one Sidebar lifecycle without a force-mounted dialog portal", () => {
		expect(layout.match(/<Sidebar\b/g)?.length).toBe(1);
		expect(layout).not.toContain("Dialog.Portal");
		expect(layout).not.toContain("forceMount");
		expect(layout).toContain("isMobile && mobileSidebar.open");
	});

	test("provides an invisible touch-safe edge swipe zone", () => {
		expect(host).toContain("data-mobile-sidebar-edge");
		expect(host).toContain("w-9");
		expect(host).toContain("touch-action: pan-y");
		expect(host).toContain("createEdgeSwipeTracker");
		expect(host).toContain("openMobileSidebar()");
	});

	test("keeps the mobile drawer accessible and restores focus", () => {
		expect(sidebar).toContain(
			'role={mobile && mobileOpen ? "dialog" : undefined}',
		);
		expect(sidebar).toContain("inert={mobile && !mobileOpen}");
		expect(sidebar).toContain('tabindex="-1"');
		expect(layout).toContain('event.key === "Escape"');
		expect(layout).toContain('event.key !== "Tab"');
		expect(layout).toContain("previouslyFocused.focus()");
		expect(layout).toContain('document.body.style.overflow = "hidden"');
		expect(layout).toContain("inert={isMobile && mobileSidebar.open}");
		expect(toggle).toContain("aria-expanded={mobileSidebar.open}");
		expect(toggle).toContain("aria-controls={controls}");
	});
});
