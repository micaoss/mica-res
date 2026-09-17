/** The document the edge serves at /.well-known/res.json. */
export interface SiteDocument {
  readonly site: {
    readonly title: string;
    readonly description: string;
    readonly download: string;
    readonly s3: string;
    readonly home: string;
  };
  readonly namespaces: readonly SiteNamespace[];
  readonly registry: readonly string[];
  readonly snapshot: { readonly version: string; readonly publishedAt: string };
}

export interface SiteNamespace {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly visibility: "public" | "protected";
  readonly listable: boolean;
  readonly objects: number | null;
  readonly bytes: number | null;
  readonly examples: readonly string[];
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function hostOf(url: string): string {
  return new URL(url).host;
}

/** Copyable command lines for the access section, built from the live hosts. */
export function snippets(doc: SiteDocument): { id: string; command: string }[] {
  const firstPublic = doc.namespaces.find(n => n.visibility === "public" && n.objects);
  const example = firstPublic?.examples[0] ?? `${firstPublic?.name ?? "mica"}/`;
  const directory = example.endsWith("/") ? example : example.slice(0, example.lastIndexOf("/") + 1);
  const repository = doc.registry[0];
  const out = [
    { id: "url", command: `${doc.site.download}/<namespace>/<path>` },
    { id: "curl", command: `curl -fLO ${doc.site.download}/${directory}<file>` },
    { id: "list", command: `curl -fsS -H 'accept: application/json' ${doc.site.home}/${directory}` },
    { id: "s3", command: `aws s3 ls --no-sign-request --endpoint-url ${doc.site.s3} s3://${directory}` },
  ];
  if (repository)
    out.push({ id: "docker", command: `docker pull ${hostOf(doc.site.home)}/${repository}:<tag>` });
  return out;
}

/** Links for an example: a directory opens its listing, a file its download. */
export function exampleHref(doc: SiteDocument, example: string): string {
  return example.endsWith("/") ? `/${example}` : `${doc.site.download}/${example}`;
}
