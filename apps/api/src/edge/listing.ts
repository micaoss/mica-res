import type { CatalogNamespace, Listing } from "@/modules/resource/catalog";
import { encodeKeyPath } from "@/modules/resource/paths";

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function size(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** A plain directory page; the home page is the SPA, this stays tiny and cacheable. */
export function renderListing(ns: CatalogNamespace, prefix: string, listing: Listing, downloadBase: string): string {
  const here = `/${ns.name}/${prefix}`;
  const crumbs = [`<a href="/">res</a>`, `<a href="/${encodeKeyPath(ns.name)}/">${escape(ns.name)}</a>`];
  let acc = "";
  for (const part of prefix.split("/").filter(Boolean)) {
    acc += `${part}/`;
    crumbs.push(`<a href="/${encodeKeyPath(`${ns.name}/${acc}`)}">${escape(part)}</a>`);
  }
  const rows = [
    ...listing.directories.map((d) => {
      const name = d.slice(prefix.length);
      return `<tr><td><a href="/${encodeKeyPath(`${ns.name}/${d}`)}">${escape(name)}</a></td><td></td><td></td><td></td></tr>`;
    }),
    ...listing.objects.map((o) => {
      const name = o.path.slice(prefix.length);
      const href = ns.visibility === "public" ? `${downloadBase.replace(/\/+$/, "")}/${encodeKeyPath(`${ns.name}/${o.path}`)}` : `/${encodeKeyPath(`${ns.name}/${o.path}`)}`;
      return `<tr><td><a href="${escape(href)}">${escape(name)}</a></td><td class="n">${size(o.size)}</td><td>${escape(o.publishedAt.slice(0, 19).replace("T", " "))}</td><td class="h"><code>${escape(o.sha256)}</code></td></tr>`;
    }),
  ];
  const more = listing.next ? `<p><a href="?after=${encodeURIComponent(listing.next)}">Next page</a></p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(here)} - ${escape(ns.title)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1c1c1e}
h1{font-size:1.1rem;font-weight:600}nav a{color:inherit}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #e5e5ea;vertical-align:top}
td.n{white-space:nowrap;text-align:right}td.h code{font-size:.75rem;color:#6e6e73;word-break:break-all}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th,td{border-color:#333}td.h code{color:#999}}
</style>
</head>
<body>
<h1><nav>${crumbs.join(" / ")}/</nav></h1>
<p>${escape(ns.description)}</p>
<table><thead><tr><th>Name</th><th>Size</th><th>Published</th><th>sha256</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>
${more}
</body>
</html>
`;
}
