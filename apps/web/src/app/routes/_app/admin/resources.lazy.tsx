/* eslint-disable react-refresh/only-export-components */
import type { Namespace } from "./-resources-api";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { errorMessage } from "@/shared/lib/errors";
import { api } from "./-resources-api";
import { KeysTab } from "./-resources-keys";
import { NamespacesTab } from "./-resources-namespaces";
import { ObjectsTab } from "./-resources-objects";
import { PurgesTab, SiteTab } from "./-resources-ops";

export const Route = createLazyFileRoute("/_app/admin/resources")({
  component: ResourcesPage,
});

function ResourcesPage() {
  const { t } = useTranslation("resources");
  const [namespaces, setNamespaces] = useState<Namespace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setNamespaces(await api<Namespace[]>("/res/namespaces"));
    }
    catch (err) {
      setError(errorMessage(err, t("loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("page.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("page.description")}</p>
      </div>
      <ErrorBanner message={error} />
      {namespaces && (
        <Tabs defaultValue="namespaces">
          <TabsList>
            <TabsTrigger value="namespaces">{t("tabs.namespaces")}</TabsTrigger>
            <TabsTrigger value="objects">{t("tabs.objects")}</TabsTrigger>
            <TabsTrigger value="keys">{t("tabs.keys")}</TabsTrigger>
            <TabsTrigger value="purges">{t("tabs.purges")}</TabsTrigger>
            <TabsTrigger value="site">{t("tabs.site")}</TabsTrigger>
          </TabsList>
          <TabsContent value="namespaces"><NamespacesTab namespaces={namespaces} reload={() => void load()} /></TabsContent>
          <TabsContent value="objects"><ObjectsTab namespaces={namespaces} /></TabsContent>
          <TabsContent value="keys"><KeysTab namespaces={namespaces} /></TabsContent>
          <TabsContent value="purges"><PurgesTab /></TabsContent>
          <TabsContent value="site"><SiteTab /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}
