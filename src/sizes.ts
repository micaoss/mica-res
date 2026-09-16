// Sizes are read from the origin, never guessed. Some hosts answer no
// content-length to a HEAD (developer.arm.com), so a ranged GET is the second
// try; an object whose size no host will state keeps no size at all.

import type { ResourceObject } from './objects.ts'

async function sizeOf(url: string): Promise<number | undefined> {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  const stated = head.headers.get('content-length')
  if (head.ok && stated !== null && stated !== '0')
    return Number(stated)

  const ranged = await fetch(url, { headers: { range: 'bytes=0-0' }, redirect: 'follow' })
  const range = ranged.headers.get('content-range')
  await ranged.body?.cancel()
  const total = range?.split('/')[1]
  return total === undefined || total === '*' ? undefined : Number(total)
}

export async function resolveSizes(objects: ResourceObject[], concurrency = 8): Promise<void> {
  const pending = objects.filter(object => object.size === undefined && object.origin !== undefined)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    for (;;) {
      const object = pending[next++]
      if (object === undefined)
        return
      try {
        const size = await sizeOf(object.origin!)
        if (size !== undefined)
          object.size = size
      }
      catch {
        // A size the origin will not state stays absent; the sync verifies
        // bytes by sha256, not by length.
      }
    }
  })
  await Promise.all(workers)
}
