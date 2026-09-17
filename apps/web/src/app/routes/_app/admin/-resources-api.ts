import { http, HttpError } from "@/shared/lib/http";

export const CACHE_POLICIES = ["immutable", "standard", "short", "no-store"] as const;

export interface Namespace {
  readonly name: string;
  readonly store: string;
  readonly visibility: "public" | "protected";
  readonly title: string;
  readonly description: string;
  readonly listable: boolean;
  readonly immutable: boolean;
  readonly siteMode: boolean;
  readonly cachePolicy: (typeof CACHE_POLICIES)[number];
  readonly examples: string[];
}

export interface ResObject {
  readonly id: string;
  readonly namespace: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly contentType: string;
  readonly cachePolicy: string | null;
  readonly publishedAt: string;
  readonly deletedAt: string | null;
  readonly deleteReason: string | null;
  readonly purgeAfter: string | null;
  readonly url: string | null;
}

export interface AccessKey {
  readonly id: string;
  readonly name: string;
  readonly grants: { namespace: string; prefix: string }[];
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface Purge {
  readonly id: string;
  readonly urls: string[];
  readonly state: "pending" | "done" | "skipped";
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

interface Envelope<T> {
  readonly data: T;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const res = await http<Envelope<T>>(path, {
    method: init?.method ?? "GET",
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init?.headers ? { headers: init.headers } : {}),
  });
  return res.data;
}

/** Whether an error asks for a fresh TOTP step-up before retrying. */
export function needsStepUp(err: unknown): boolean {
  return err instanceof HttpError && err.code === "STEP_UP_REQUIRED";
}

export async function stepUpToken(code: string): Promise<string> {
  return (await api<{ token: string }>("/account/me/totp/verify", { method: "POST", body: { code } })).token;
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

/** `namespace:prefix` per line, prefix optional. */
export function parseGrants(text: string): { namespace: string; prefix: string }[] {
  return text.split("\n").map(l => l.trim()).filter(Boolean).map((line) => {
    const colon = line.indexOf(":");
    return colon < 0 ? { namespace: line, prefix: "" } : { namespace: line.slice(0, colon).trim(), prefix: line.slice(colon + 1).trim() };
  });
}
