import type { Namespace } from "./-resources-api";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/components/ui/select";
import { Switch } from "@/shared/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { errorMessage } from "@/shared/lib/errors";
import { api, CACHE_POLICIES } from "./-resources-api";

interface Draft {
  name: string;
  store: string;
  title: string;
  description: string;
  listable: boolean;
  immutable: boolean;
  siteMode: boolean;
  cachePolicy: Namespace["cachePolicy"];
  examples: string;
}

function draftFrom(ns: Namespace | null): Draft {
  return {
    name: ns?.name ?? "",
    store: ns?.store ?? "public",
    title: ns?.title ?? "",
    description: ns?.description ?? "",
    listable: ns?.listable ?? true,
    immutable: ns?.immutable ?? false,
    siteMode: ns?.siteMode ?? false,
    cachePolicy: ns?.cachePolicy ?? "standard",
    examples: (ns?.examples ?? []).join("\n"),
  };
}

export function NamespacesTab({ namespaces, reload }: { namespaces: readonly Namespace[]; reload: () => void }) {
  const { t } = useTranslation("resources");
  const [editing, setEditing] = useState<Namespace | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const open = (ns: Namespace | "new") => {
    setEditing(ns);
    setDraft(draftFrom(ns === "new" ? null : ns));
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const fields = {
      title: draft.title,
      description: draft.description,
      listable: draft.listable,
      immutable: draft.immutable,
      siteMode: draft.siteMode,
      cachePolicy: draft.cachePolicy,
      examples: draft.examples.split("\n").map(l => l.trim()).filter(Boolean),
    };
    try {
      if (editing === "new")
        await api("/res/namespaces", { method: "POST", body: { name: draft.name, store: draft.store, ...fields } });
      else if (editing)
        await api(`/res/namespaces/${editing.name}`, { method: "PATCH", body: fields });
      toast.success(t("saved"));
      setEditing(null);
      reload();
    }
    catch (err) {
      setError(errorMessage(err, t("saveFailed")));
    }
    finally {
      setSaving(false);
    }
  };

  const flag = (key: "listable" | "immutable" | "siteMode") => (
    <div className="flex items-center justify-between gap-4">
      <Label>{t(`namespace.${key}`)}</Label>
      <Switch checked={draft[key]} onCheckedChange={checked => setDraft({ ...draft, [key]: checked })} />
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => open("new")}>{t("namespace.create")}</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("namespace.name")}</TableHead>
            <TableHead>{t("namespace.title")}</TableHead>
            <TableHead>{t("namespace.visibility")}</TableHead>
            <TableHead>{t("namespace.cachePolicy")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {namespaces.map(ns => (
            <TableRow key={ns.name}>
              <TableCell className="font-mono">{ns.name}</TableCell>
              <TableCell>{ns.title}</TableCell>
              <TableCell>
                <Badge variant={ns.visibility === "public" ? "secondary" : "outline"}>{t(`visibility.${ns.visibility}`)}</Badge>
                {ns.immutable && <Badge variant="outline" className="ml-1">{t("namespace.immutable")}</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{ns.cachePolicy}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => open(ns)}>{t("edit")}</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={editing !== null} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? t("namespace.create") : t("namespace.edit", { name: editing ? (editing as Namespace).name : "" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <ErrorBanner message={error} />
            {editing === "new" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t("namespace.name")}</Label>
                  <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="docs" />
                </div>
                <div className="space-y-1">
                  <Label>{t("namespace.store")}</Label>
                  <Select value={draft.store} onValueChange={v => v !== null && setDraft({ ...draft, store: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">public</SelectItem>
                      <SelectItem value="protect">protect</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label>{t("namespace.title")}</Label>
              <Input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>{t("namespace.description")}</Label>
              <Textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={2} />
            </div>
            <div className="space-y-1">
              <Label>{t("namespace.cachePolicy")}</Label>
              <Select value={draft.cachePolicy} onValueChange={v => v !== null && setDraft({ ...draft, cachePolicy: v as Draft["cachePolicy"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CACHE_POLICIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {flag("listable")}
            {flag("immutable")}
            {flag("siteMode")}
            <div className="space-y-1">
              <Label>{t("namespace.examples")}</Label>
              <Textarea value={draft.examples} onChange={e => setDraft({ ...draft, examples: e.target.value })} rows={3} className="font-mono text-xs" placeholder="mica/uefi-x64/" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>{t("cancel")}</Button>
            <Button onClick={() => void save()} disabled={saving}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
