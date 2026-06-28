import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import Root from "./dropdown-menu.svelte";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Separator from "./dropdown-menu-separator.svelte";
import Trigger from "./dropdown-menu-trigger.svelte";

const Sub = DropdownMenuPrimitive.Sub;
const Group = DropdownMenuPrimitive.Group;

export {
	Content,
	Content as DropdownMenuContent,
	Group,
	Group as DropdownMenuGroup,
	Item,
	Item as DropdownMenuItem,
	Root,
	//
	Root as DropdownMenu,
	Separator,
	Separator as DropdownMenuSeparator,
	Sub,
	Sub as DropdownMenuSub,
	Trigger,
	Trigger as DropdownMenuTrigger,
};
