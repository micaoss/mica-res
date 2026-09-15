import { and, eq, isNull } from "drizzle-orm";
import { items } from "@/modules/item/schema";
import { defineResource } from "@/modules/policy";

/**
 * Issue permissions, expressed on the shared `item` namespace so every path
 * that touches an issue — its own routes, the generic `/files/*` download
 * path, comment attachments — answers from the same tuples.
 *
 * Relation ladder (see policy/namespace-config.ts):
 *   owner ⊂ editor ⊂ viewer, owner ⊂ assignee ⊂ viewer.
 * The creator holds `owner`; the current handler holds `assignee`.
 *
 * `issue:update` (whole record) is `editor`; `issue:transition` (status
 * only) is `assignee`. PATCH is deliberately *not* bound to a single
 * action here — the handler picks the action from the payload shape.
 */
export const issueAccess = defineResource({
  name: "issue",
  namespace: "item",
  description: "Tracked work items with an assignee and a status workflow.",
  actions: {
    "issue:read": "viewer",
    "issue:download": "viewer",
    "issue:update": "editor",
    "issue:transition": "assignee",
    "issue:delete": "owner",
    "issue:manage_attachments": "assignee",
  } as const,
  routes: [
    { method: "GET", path: "/issues/:id", action: "issue:read" },
    { method: "DELETE", path: "/issues/:id", action: "issue:delete" },
    { method: "POST", path: "/issues/:id/attachments", action: "issue:manage_attachments" },
    { method: "GET", path: "/issues/:id/attachments", action: "issue:read" },
    { method: "GET", path: "/issues/:id/attachments/:aid", action: "issue:download" },
    { method: "DELETE", path: "/issues/:id/attachments/:aid", action: "issue:manage_attachments" },
  ] as const,
  hooks: {
    bypass: ctx => ctx.actor.role === "admin",
    resolveObjectId: async (c, params) => {
      const shortId = params.id;
      if (!shortId)
        return null;
      const row = await c.get("db")
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.shortId, shortId), eq(items.type, "issue"), isNull(items.deletedAt)))
        .get();
      return row?.id ?? null;
    },
  },
});
