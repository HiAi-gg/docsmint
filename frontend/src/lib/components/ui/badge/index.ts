import { tv, type VariantProps } from "tailwind-variants";

const badgeVariants = tv({
	base: "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	variants: {
		variant: {
			default: "border-transparent bg-primary text-primary-foreground shadow",
			secondary: "border-transparent bg-secondary text-secondary-foreground",
			destructive:
				"border-transparent bg-destructive text-destructive-foreground shadow",
			outline: "text-foreground",
		},
	},
	defaultVariants: {
		variant: "default",
	},
});

type Variant = VariantProps<typeof badgeVariants>["variant"];

export type BadgeVariant = Variant;
export { default as Badge } from "./badge.svelte";
export { badgeVariants };
