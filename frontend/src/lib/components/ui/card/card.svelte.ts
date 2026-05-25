import type { HTMLAttributes } from "svelte/elements";
import type { WithElementRef } from "$lib/utils.js";

export type CardProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
  ref?: HTMLDivElement | null;
};
