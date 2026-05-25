import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

import Root from "./dropdown-menu.svelte";
import Trigger from "./dropdown-menu-trigger.svelte";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Separator from "./dropdown-menu-separator.svelte";

const Sub = DropdownMenuPrimitive.Sub;
const Group = DropdownMenuPrimitive.Group;

export {
  Root,
  Trigger,
  Content,
  Item,
  Separator,
  Sub,
  Group,
  //
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Separator as DropdownMenuSeparator,
  Sub as DropdownMenuSub,
  Group as DropdownMenuGroup,
};
