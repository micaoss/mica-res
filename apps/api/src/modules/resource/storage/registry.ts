import type { ResStore } from "./types";
import { StoreUnavailableError } from "./types";

/**
 * Buckets by binding name. The Workers entry registers one store per R2
 * binding at boot; tests register memory stores. A `res_stores` row names
 * the binding it lives behind.
 */
const stores = new Map<string, ResStore>();

export function registerStore(binding: string, store: ResStore): void {
  stores.set(binding, store);
}

export function getStore(binding: string): ResStore {
  const store = stores.get(binding);
  if (!store)
    throw new StoreUnavailableError(`No bucket is bound as ${binding} on this runtime`);
  return store;
}

/** The store holding a bucket, for a copy whose source is another bucket. */
export function storeByBucket(bucket: string): ResStore | undefined {
  return [...stores.values()].find(store => store.bucket === bucket);
}

export function hasStore(binding: string): boolean {
  return stores.has(binding);
}

export function __resetStoresForTests(): void {
  stores.clear();
}
