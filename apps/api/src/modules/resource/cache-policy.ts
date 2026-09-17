/**
 * Cache policy is data: a namespace carries one, an object may override it,
 * and the resulting `cache-control` is written onto the object itself so R2
 * and the CDN in front of the download host honour it without any code on
 * the read path.
 */

export const CACHE_POLICIES = ["immutable", "standard", "short", "no-store"] as const;

export type CachePolicy = (typeof CACHE_POLICIES)[number];

const CACHE_CONTROL: Readonly<Record<CachePolicy, string>> = {
  "immutable": "public, max-age=31536000, immutable",
  "standard": "public, max-age=300, s-maxage=86400",
  "short": "public, max-age=60, must-revalidate",
  "no-store": "no-store",
};

export function isCachePolicy(value: string): value is CachePolicy {
  return (CACHE_POLICIES as readonly string[]).includes(value);
}

export function cacheControlFor(policy: CachePolicy): string {
  return CACHE_CONTROL[policy];
}

/** The object's own policy when it has one, the namespace's otherwise. */
export function effectivePolicy(namespacePolicy: CachePolicy, objectPolicy: CachePolicy | null | undefined): CachePolicy {
  return objectPolicy ?? namespacePolicy;
}
