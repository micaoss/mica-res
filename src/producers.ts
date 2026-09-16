// What the service mirrors, and nothing else (user decisions, 2026-09-16).
//
// In: third-party Debian archives and sha256-pinned tarballs, the build-env
// images, and mica-build's product images and update archives.
// Out: our package pools, mica-boards board components, release locks and
// SHA256SUMS, the 21 upstream docker.io images (they are inside the build-env
// images) and the device update service.

export interface LockSource {
  repository: string
  lock: string
  // Rows whose name matches are not mirrored.
  exclude?: RegExp
}

export const LOCK_SOURCES: LockSource[] = [
  { repository: 'mica-system-base', lock: 'locks/upstream.lock' },
  { repository: 'mica-build', lock: 'locks/upstream.lock' },
  // The later-stage Debian closure, pinned by the consumer that installs it.
  { repository: 'mica-build', lock: 'locks/mica-system-base.lock' },
  // The `ubuntu-*` rows are the apt snapshot the bsp image replaces; Ubuntu is
  // not mirrored (user, 2026-09-16).
  { repository: 'mica-boards', lock: 'locks/upstream.lock', exclude: /^ubuntu-/ },
  { repository: 'mica-build-env', lock: 'locks/upstream.lock' },
]

// The build-env release every consumer pins; read from a consumer's lock rather
// than from mica-build-env's newest release, so the mirror holds what a build
// actually asks for.
export const IMAGE_SOURCE = { repository: 'mica-build', lock: 'locks/mica-build-env.lock', images: 'mica-build-env' }

export const PRODUCT_SOURCE = { repository: 'mica-build' }

// Phase 3: the vendor trees, mirrored as depth-1 packfiles. Enumerated now for
// the record; nothing is produced until that phase.
export const GIT_SOURCES: LockSource[] = [
  { repository: 'mica-boards', lock: 'locks/upstream.lock' },
  { repository: 'mica-podman', lock: 'locks/upstream.lock' },
]
