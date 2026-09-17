import type { AccessKey, Namespace } from "./-resources-api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { errorMessage } from "@/shared/lib/errors";
import { formatDateTime } from "@/shared/lib/format";
import { api, parseGrants } from "./-resources-api";

interface Created {
  readonly key: AccessKey;
  readonly secret: string;
  readonly bearer: string;
}

export function KeysTab({ namespaces }: { namespaces: readonly Namespace[] }) {
  const { t } = useTranslation("resources");
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [grants, setGrants] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [signing, setSigning] = useState<AccessKey | null>(null);
  const [signPath, setSignPath] = useState("");
  const [signedUrl, setSignedUrl] = useState("");
  const [revoking, setRevoking] = useState<AccessKey | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await api<AccessKey[]>("/res/access-keys"));
    }
    catch (err) {
      setError(errorMessage(err, t("loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const protectedNames = namespaces.filter(n => n.visibility === "protected").map(n => n.name);

  const create = async () => {
    setError(null);
    try {
      const result = await api<Created>("/res/access-keys", {
        method: "POST",
        body: { name, grants: parseGrants(grants), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) },
      });
      setCreating(false);
      setCreated(result);
      void load();
    }
    catch (err) {
      setError(errorMessage(err, t("saveFailed")));
    }
  };

  const revoke = async (key: AccessKey) => {
    try {
      await api(`/res/access-keys/${key.id}/revoke`, { method: "POST" });
      setRevoking(null);
      void load();
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  const sign = async () => {
    if (!signing)
      return;
    const slash = signPath.indexOf("/");
    try {
      const result = await api<{ url: string }>(`/res/access-keys/${signing.id}/sign`, {
        method: "POST",
        body: { namespace: signPath.slice(0, slash), path: signPath.slice(slash + 1), ttlSeconds: 3600 },
      });
      setSignedUrl(result.url);
    }
    catch (err) {
      toast.error(errorMessage(err, t("actionFailed")));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{protectedNames.length === 0 ? t("keys.noProtected") : t("keys.hint", { names: protectedNames.join(", ") })}</p>
        <Button size="sm" onClick={() => setCreating(true)}>{t("keys.create")}</Button>
      </div>
      <ErrorBanner message={error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("keys.name")}</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>{t("keys.grants")}</TableHead>
            <TableHead>{t("keys.expires")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map(k => (
            <TableRow key={k.id}>
              <TableCell>
                {k.name}
                {k.revokedAt && <Badge variant="destructive" className="ml-2">{t("keys.revoked")}</Badge>}
              </TableCell>
              <TableCell className="font-mono text-xs">{k.id}</TableCell>
              <TableCell className="font-mono text-xs">{k.grants.map(g => `${g.namespace}/${g.prefix}`).join(", ")}</TableCell>
              <TableCell className="text-xs">{k.expiresAt ? formatDateTime(k.expiresAt) : "—"}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {!k.revokedAt && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSigning(k);
                        setSignPath("");
                        setSignedUrl("");
                      }}
                    >
                      {t("keys.sign")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(k)}>{t("keys.revoke")}</Button>
                  </>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDeleteDialog
        open={revoking !== null}
        onOpenChange={o => !o && setRevoking(null)}
        title={t("keys.revoke")}
        description={t("keys.confirmRevoke", { name: revoking?.name ?? "" })}
        confirmLabel={t("keys.revoke")}
        onConfirm={() => revoking && void revoke(revoking)}
      />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("keys.create")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("keys.name")}</Label>
              <Input value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>{t("keys.grants")}</Label>
              <Textarea value={grants} onChange={e => setGrants(e.target.value)} rows={3} className="font-mono text-xs" placeholder={`${protectedNames[0] ?? "vault"}:team/`} />
              <p className="text-xs text-muted-foreground">{t("keys.grantsHint")}</p>
            </div>
            <div className="space-y-1">
              <Label>{t("keys.expires")}</Label>
              <Input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>{t("cancel")}</Button>
            <Button onClick={() => void create()} disabled={!name || !grants}>{t("keys.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={created !== null} onOpenChange={o => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("keys.createdTitle")}</DialogTitle>
            <DialogDescription>{t("keys.createdDescription")}</DialogDescription>
          </DialogHeader>
          {created && (
            <div className="space-y-2 font-mono text-xs break-all">
              <div>
                <span className="text-muted-foreground">Access key ID: </span>
                {created.key.id}
              </div>
              <div>
                <span className="text-muted-foreground">Secret: </span>
                {created.secret}
              </div>
              <div>
                <span className="text-muted-foreground">Bearer: </span>
                {created.bearer}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signing !== null} onOpenChange={o => !o && setSigning(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t("keys.sign")}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("keys.signPath")}</Label>
              <Input value={signPath} onChange={e => setSignPath(e.target.value)} placeholder="vault/team/file.bin" className="font-mono" />
            </div>
            {signedUrl && <Textarea readOnly value={signedUrl} rows={4} className="font-mono text-xs" />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSigning(null)}>{t("done")}</Button>
            <Button onClick={() => void sign()} disabled={!signPath.includes("/")}>{t("keys.sign")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
