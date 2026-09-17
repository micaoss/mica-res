import type { Purge } from "./-resources-api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { errorMessage } from "@/shared/lib/errors";
import { formatDateTime } from "@/shared/lib/format";
import { api } from "./-resources-api";

export function PurgesTab() {
  const { t } = useTranslation("resources");
  const [purges, setPurges] = useState<Purge[]>([]);

  const load = useCallback(async () => {
    try {
      setPurges(await api<Purge[]>("/res/purges"));
    }
    catch (err) {
      toast.error(errorMessage(err, t("loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    try {
      await api(`/res/purges/${id}/retry`, { method: "POST" });
      void load();
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("purges.created")}</TableHead>
          <TableHead>{t("purges.state")}</TableHead>
          <TableHead>URL</TableHead>
          <TableHead>{t("purges.error")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {purges.length === 0 && (
          <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t("purges.empty")}</TableCell></TableRow>
        )}
        {purges.map(p => (
          <TableRow key={p.id}>
            <TableCell className="text-xs whitespace-nowrap">{formatDateTime(p.createdAt)}</TableCell>
            <TableCell>
              <Badge variant={p.state === "done" ? "secondary" : p.state === "pending" ? "outline" : "destructive"}>{t(`purges.states.${p.state}`)}</Badge>
            </TableCell>
            <TableCell className="max-w-96 font-mono text-xs break-all">{p.urls.join(" ")}</TableCell>
            <TableCell className="text-xs">{p.lastError ?? ""}</TableCell>
            <TableCell className="text-right">
              {p.state !== "done" && <Button variant="ghost" size="sm" onClick={() => void retry(p.id)}>{t("purges.retry")}</Button>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface ImportPage {
  readonly total: number;
  readonly next: number | null;
  readonly created: number;
  readonly failed: string[];
  readonly skipped: string[];
}

export function SiteTab() {
  const { t } = useTranslation("resources");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [failures, setFailures] = useState<string[]>([]);

  useEffect(() => {
    api<{ title: string; description: string }>("/res/site")
      .then((site) => {
        setTitle(site.title);
        setDescription(site.description);
      })
      .catch(() => {});
  }, []);

  const saveSite = async () => {
    try {
      await api("/res/site", { method: "PUT", body: { title, description } });
      toast.success(t("saved"));
    }
    catch (err) {
      toast.error(errorMessage(err, t("saveFailed")));
    }
  };

  const publish = async () => {
    try {
      const result = await api<{ catalog: string }>("/res/catalog/publish", { method: "POST" });
      toast.success(t(`site.catalog.${result.catalog}`));
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  const runImport = async () => {
    setImporting(true);
    setFailures([]);
    let offset: number | null = 0;
    let created = 0;
    try {
      while (offset !== null) {
        const page: ImportPage = await api<ImportPage>("/res/imports/v1", { method: "POST", body: { offset, limit: 25 } });
        created += page.created;
        setFailures(f => [...f, ...page.failed]);
        offset = page.next;
        setProgress(t("site.importProgress", { done: offset ?? page.total, total: page.total, created }));
      }
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
    finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t("site.home")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>{t("site.title")}</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{t("site.description")}</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void saveSite()}>{t("save")}</Button>
            <Button variant="outline" onClick={() => void publish()}>{t("site.publish")}</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("site.import")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("site.importHint")}</p>
          <Button variant="outline" disabled={importing} onClick={() => void runImport()}>{t("site.importRun")}</Button>
          {progress && <p className="text-sm">{progress}</p>}
          {failures.length > 0 && <Textarea readOnly value={failures.join("\n")} rows={5} className="font-mono text-xs" />}
        </CardContent>
      </Card>
    </div>
  );
}
