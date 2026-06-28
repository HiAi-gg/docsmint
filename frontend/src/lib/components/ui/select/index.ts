import { Select as SelectPrimitive } from "bits-ui";
import Root from "./select.svelte";
import Content from "./select-content.svelte";
import Item from "./select-item.svelte";
import Separator from "./select-separator.svelte";
import Trigger from "./select-trigger.svelte";
import Value from "./select-value.svelte";

const Group = SelectPrimitive.Group;
const GroupHeading = SelectPrimitive.GroupHeading;

export {
	Content,
	Content as SelectContent,
	Group,
	Group as SelectGroup,
	GroupHeading,
	GroupHeading as SelectGroupHeading,
	Item,
	Item as SelectItem,
	Root,
	Root as SelectRoot,
	Separator,
	Separator as SelectSeparator,
	Trigger,
	Trigger as SelectTrigger,
	Value,
	Value as SelectValue,
};
