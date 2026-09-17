import type { Namespace, ResObject } from "./-resources-api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { errorMessage } from "@/shared/lib/errors";
import { formatDateTime } from "@/shared/lib/format";
import { api, formatBytes, needsStepUp, stepUpToken } from "./-resources-api";

type Deleted = "exclude" | "include" | "only";

interface DeleteRequest {
  readonly path?: string;
  readonly prefix?: string;
  readonly count: number;
}

export function ObjectsTab({ namespaces }: { namespaces: readonly Namespace[] }) {
  const { t } = useTranslation("resources");
  const [namespace, setNamespace] = useState(namespaces[0]?.name ?? "");
  const [prefix, setPrefix] = useState("");
  const [deleted, setDeleted] = useState<Deleted>("exclude");
  const [objects, setObjects] = useState<ResObject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DeleteRequest | null>(null);
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [purgeCode, setPurgeCode] = useState("");

  const load = useCallback(async () => {
    if (!namespace)
      return;
    setError(null);
    try {
      const params = new URLSearchParams({ deleted, limit: "500" });
      if (prefix)
        params.set("prefix", prefix);
      setObjects(await api<ResObject[]>(`/res/namespaces/${namespace}/objects?${params.toString()}`));
    }
    catch (err) {
      setError(errorMessage(err, t("loadFailed")));
    }
  }, [namespace, prefix, deleted, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const withStepUp = async (fn: (headers: Record<string, string>) => Promise<void>) => {
    try {
      await fn(totp ? { "x-totp-token": await stepUpToken(totp) } : {});
    }
    catch (err) {
      if (needsStepUp(err)) {
        setNeedsTotp(true);
        throw new Error(t("objects.totpRequired"));
      }
      throw err;
    }
  };

  const askDelete = async (target: { path?: string; prefix?: string }) => {
    try {
      const dry = await api<{ count: number }>(`/res/namespaces/${namespace}/objects/delete`, { method: "POST", body: { ...target, reason: "dry run", dryRun: true } });
      setPending({ ...target, count: dry.count });
      setReason("");
      setTotp("");
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  const confirmDelete = async () => {
    if (!pending)
      return;
    setBusy(true);
    try {
      await withStepUp(headers => api(`/res/namespaces/${namespace}/objects/delete`, { method: "POST", body: { path: pending.path, prefix: pending.prefix, reason }, headers }).then(() => {}));
      toast.success(t("objects.deleted", { count: pending.count }));
      setPending(null);
      void load();
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
    finally {
      setBusy(false);
    }
  };

  const act = async (action: "restore" | "purge", path: string) => {
    try {
      if (action === "purge") {
        const purge = (headers: Record<string, string>) => api(`/res/namespaces/${namespace}/objects/purge`, { method: "POST", body: { path }, headers });
        try {
          await purge({});
        }
        catch (err) {
          if (!needsStepUp(err))
            throw err;
          setPurgeTarget(path);
          setPurgeCode("");
          return;
        }
      }
      else {
        await api(`/res/namespaces/${namespace}/objects/restore`, { method: "POST", body: { path } });
      }
      toast.success(t(`objects.${action}d`));
      void load();
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  const confirmPurge = async () => {
    if (!purgeTarget)
      return;
    try {
      const headers = { "x-totp-token": await stepUpToken(purgeCode) };
      await api(`/res/namespaces/${namespace}/objects/purge`, { method: "POST", body: { path: purgeTarget }, headers });
      setPurgeTarget(null);
      toast.success(t("objects.purged"));
      void load();
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label>{t("namespace.name")}</Label>
          <Select value={namespace} onValueChange={v => v !== null && setNamespace(v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              {namespaces.map(n => <SelectItem key={n.name} value={n.name}>{n.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("objects.prefix")}</Label>
          <Input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="uefi-x64/" className="w-64 font-mono" />
        </div>
        <Select value={deleted} onValueChange={v => v !== null && setDeleted(v as Deleted)}>
          <SelectTrigger className="w-36"><SelectValue>{(v: string) => t(`objects.show.${v}`)}</SelectValue></SelectTrigger>
          <SelectContent>
            {(["exclude", "include", "only"] as const).map(v => <SelectItem key={v} value={v}>{t(`objects.show.${v}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        {prefix.endsWith("/") && (
          <Button variant="destructive" size="sm" onClick={() => void askDelete({ prefix })}>{t("objects.deletePrefix")}</Button>
        )}
      </div>
      <ErrorBanner message={error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("objects.path")}</TableHead>
            <TableHead>{t("objects.size")}</TableHead>
            <TableHead>{t("objects.published")}</TableHead>
            <TableHead>sha256</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {objects.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t("objects.empty")}</TableCell></TableRow>
          )}
          {objects.map(o => (
            <TableRow key={o.id}>
              <TableCell className="font-mono text-xs">
                {o.url ? <a className="hover:underline" href={o.url} target="_blank" rel="noreferrer">{o.path}</a> : o.path}
                {o.deletedAt && (
                  <Badge variant="destructive" className="ml-2">
                    {t("objects.purgeAt", { at: formatDateTime(o.purgeAfter ?? "") })}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatBytes(o.size)}</TableCell>
              <TableCell className="whitespace-nowrap text-xs">{formatDateTime(o.publishedAt)}</TableCell>
              <TableCell className="max-w-48 truncate font-mono text-xs" title={o.sha256}>{o.sha256}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {o.deletedAt
                  ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => void act("restore", o.path)}>{t("objects.restore")}</Button>
                        <Button variant="ghost" size="sm" onClick={() => void act("purge", o.path)}>{t("objects.purge")}</Button>
                      </>
                    )
                  : <Button variant="ghost" size="sm" onClick={() => void askDelete({ path: o.path })}>{t("objects.delete")}</Button>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={pending !== null} onOpenChange={o => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("objects.confirmTitle", { count: pending?.count ?? 0 })}</DialogTitle>
            <DialogDescription>{t("objects.confirmDescription", { target: `${namespace}/${pending?.path ?? pending?.prefix ?? ""}` })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("objects.reason")}</Label>
              <Input value={reason} onChange={e => setReason(e.target.value)} />
            </div>
            {needsTotp && (
              <div className="space-y-1">
                <Label>{t("objects.totp")}</Label>
                <Input value={totp} onChange={e => setTotp(e.target.value)} inputMode="numeric" maxLength={6} className="w-32 font-mono" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={busy || reason.trim() === "" || pending?.count === 0} onClick={() => void confirmDelete()}>{t("objects.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={purgeTarget !== null} onOpenChange={o => !o && setPurgeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("objects.purge")}</DialogTitle>
            <DialogDescription>{t("objects.totpRequired")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>{t("objects.totp")}</Label>
            <Input value={purgeCode} onChange={e => setPurgeCode(e.target.value)} inputMode="numeric" maxLength={6} className="w-32 font-mono" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeTarget(null)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={purgeCode.length !== 6} onClick={() => void confirmPurge()}>{t("objects.purge")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
