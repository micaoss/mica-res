import type { NavItem } from "@/shared/components/sidebar/types";
import { Boxes } from "lucide-react";

export const resourcesNav: NavItem = {
  area: "admin",
  key: "resources",
  path: "/admin/resources",
  icon: Boxes,
  order: 5,
};
