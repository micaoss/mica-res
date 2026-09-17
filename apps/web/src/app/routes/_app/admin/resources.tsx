import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/resources")({
  staticData: { titleKey: "resources:page.title" },
});
