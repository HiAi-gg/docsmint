import type { Component, ComponentType, SvelteComponent } from "svelte";

export type DocTabIcon = ComponentType<SvelteComponent>;

export interface DocTabPanelProps {
	documentId: string;
	content: string;
	contentJson: object | undefined;
}

export interface DocTabDefinition {
	id: string;
	label: string;
	component: Component<DocTabPanelProps>;
	order?: number;
	icon?: DocTabIcon;
	disabled?: boolean;
}
