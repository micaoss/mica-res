import type { Lang, Messages } from "./lib/i18n";
import type { SiteDocument, SiteNamespace } from "./lib/site";
import { useEffect, useState } from "react";
import { detectLang, messages } from "./lib/i18n";
import { exampleHref, formatBytes, snippets } from "./lib/site";

const LANG_KEY = "mica-res:site:lang";

function useSite(): { doc: SiteDocument | null; failed: boolean } {
  const [doc, setDoc] = useState<SiteDocument | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    fetch("/.well-known/res.json", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok)
          throw new Error(String(res.status));
        return res.json() as Promise<SiteDocument>;
      })
      .then((value) => {
        if (live) {
          setDoc(value);
          document.title = value.site.title;
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      controller.abort();
    };
  }, []);
  return { doc, failed };
}

function CopyButton({ text, t }: { text: string; t: Messages }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(setCopied, 1500, false);
        });
      }}
    >
      {copied ? t.copied : t.copy}
    </button>
  );
}

function Host({ label, hint, url }: { label: string; hint: string; url: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <a className="mt-1 block font-mono text-sm break-all text-slate-900 hover:underline dark:text-slate-100" href={url}>{url.replace(/^https:\/\//, "")}</a>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{hint}</p>
    </div>
  );
}

function Namespace({ ns, doc, t }: { ns: SiteNamespace; doc: SiteDocument; t: Messages }) {
  const isPublic = ns.visibility === "public";
  return (
    <article className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-base font-semibold text-slate-900 dark:text-slate-100">
          {ns.name}
          /
        </h3>
        <span className={`rounded-full px-2 py-0.5 text-xs ${isPublic ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>
          {isPublic ? t.public : t.protected}
        </span>
      </div>
      <div className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-300">{ns.title}</div>
      {ns.description && <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{ns.description}</p>}
      {isPublic && ns.objects !== null && (
        <div className="mt-3 text-xs text-slate-500">
          {ns.objects.toLocaleString()}
          {" "}
          {t.objects}
          {" · "}
          {formatBytes(ns.bytes ?? 0)}
        </div>
      )}
      {ns.examples.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-slate-500">{t.examples}</div>
          <ul className="mt-1 space-y-1">
            {ns.examples.map(example => (
              <li key={example}>
                <a className="font-mono text-xs break-all text-sky-700 hover:underline dark:text-sky-400" href={exampleHref(doc, example)}>{example}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ns.listable && (
        <a className="mt-auto pt-4 text-sm font-medium text-slate-900 hover:underline dark:text-slate-100" href={`/${ns.name}/`}>
          {t.browse}
          {" →"}
        </a>
      )}
    </article>
  );
}

const SNIPPET_LABEL: Record<string, keyof Messages> = {
  url: "accessUrl",
  curl: "accessCurl",
  list: "accessList",
  s3: "accessS3",
  docker: "accessDocker",
};

export function App() {
  const [lang, setLang] = useState<Lang>(() => detectLang(localStorage.getItem(LANG_KEY), navigator.languages));
  const t = messages(lang);
  const { doc, failed } = useSite();

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
        <header className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="size-10 rounded-lg" />
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{doc?.site.title ?? "Mica OS resources"}</h1>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button type="button" className="text-slate-600 hover:underline dark:text-slate-400" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{t.language}</button>
            <a className="text-slate-600 hover:underline dark:text-slate-400" href="/admin/">Admin</a>
          </div>
        </header>

        {!doc && (
          <p className="mt-10 text-slate-600 dark:text-slate-400">{failed ? t.unavailable : t.loading}</p>
        )}

        {doc && (
          <>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-slate-600 dark:text-slate-400">{doc.site.description}</p>

            <section className="mt-10">
              <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{t.hosts}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Host label={t.hostDownload} hint={t.hostDownloadHint} url={doc.site.download} />
                <Host label={t.hostHome} hint={t.hostHomeHint} url={doc.site.home} />
                <Host label={t.hostS3} hint={t.hostS3Hint} url={doc.site.s3} />
              </div>
            </section>

            <section className="mt-10">
              <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{t.namespaces}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {doc.namespaces.map(ns => <Namespace key={ns.name} ns={ns} doc={doc} t={t} />)}
              </div>
            </section>

            <section className="mt-10">
              <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{t.access}</h2>
              <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {snippets(doc).map(s => (
                  <li key={s.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm text-slate-600 dark:text-slate-400">{t[SNIPPET_LABEL[s.id]!]}</div>
                      <code className="mt-1 block font-mono text-sm break-all text-slate-900 dark:text-slate-100">{s.command}</code>
                    </div>
                    <CopyButton text={s.command} t={t} />
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-10 rounded-xl border border-sky-200 bg-sky-50 p-5 dark:border-sky-900 dark:bg-sky-950">
              <h2 className="text-sm font-semibold text-sky-900 dark:text-sky-200">{t.trustTitle}</h2>
              <p className="mt-1 text-sm leading-relaxed text-sky-900/80 dark:text-sky-200/80">{t.trust}</p>
            </section>

            <footer className="mt-10 text-xs text-slate-500">
              {t.snapshot}
              {" "}
              <code className="font-mono">{doc.snapshot.version}</code>
              {" · "}
              {t.published}
              {" "}
              {new Date(doc.snapshot.publishedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en")}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
