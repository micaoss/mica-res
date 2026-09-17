import { defineResource, registerNamespace } from "@/modules/policy";

/**
 * Who may do what inside a namespace. Admins bypass; anyone else needs a
 * tuple: `res_namespace:<name>#publisher@user:<id>` (or a group), or
 * `#manager`, which implies publisher. A CI user is typically a publisher
 * of the namespaces it feeds and nothing else.
 */
registerNamespace({
  name: "res_namespace",
  relations: {
    manager: { union: [{ this: {} }] },
    publisher: { union: [{ this: {} }, { computed_userset: { relation: "manager" } }] },
  },
});

export const namespaceAccess = defineResource({
  name: "res-namespace",
  namespace: "res_namespace",
  description: "A top-level resource directory: publishing into it and managing its settings.",
  actions: {
    "res-namespace:publish": "publisher",
    "res-namespace:manage": "manager",
  } as const,
  routes: [
    { method: "GET", path: "/res/namespaces/:name", action: "res-namespace:publish", idParam: "name" },
    { method: "PATCH", path: "/res/namespaces/:name", action: "res-namespace:manage", idParam: "name" },
    { method: "GET", path: "/res/namespaces/:name/objects", action: "res-namespace:publish", idParam: "name" },
    { method: "PUT", path: "/res/namespaces/:name/objects", action: "res-namespace:publish", idParam: "name" },
    { method: "POST", path: "/res/namespaces/:name/batch", action: "res-namespace:publish", idParam: "name" },
    { method: "POST", path: "/res/namespaces/:name/uploads", action: "res-namespace:publish", idParam: "name" },
    { method: "POST", path: "/res/namespaces/:name/uploads/pull", action: "res-namespace:publish", idParam: "name" },
    { method: "GET", path: "/res/namespaces/:name/aliases", action: "res-namespace:publish", idParam: "name" },
    { method: "PUT", path: "/res/namespaces/:name/aliases", action: "res-namespace:publish", idParam: "name" },
    { method: "POST", path: "/res/namespaces/:name/aliases/delete", action: "res-namespace:manage", idParam: "name" },
    { method: "PUT", path: "/res/namespaces/:name/oci-tags", action: "res-namespace:publish", idParam: "name" },
  ],
});
