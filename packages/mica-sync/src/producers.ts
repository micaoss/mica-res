// What the service mirrors, and nothing else (user decisions, 2026-09-16).
//
// In: third-party Debian archives and sha256-pinned tarballs, the build-env
// images, mica-build's product images and update archives, and -- amended by
// the user on 2026-09-20 -- the release locks and their `SHA256SUMS`.
// Out, unchanged by that amendment: our package pools, mica-boards board
// components, the 21 upstream docker.io images (they are inside the build-env
// images) and the device update service. A mirrored lock makes the BINDING
// survivable; the `package` rows inside it still point into pools nothing
// mirrors.

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

// The repositories that keep `locks/pins/`, whose pins name every producer
// release a build currently verifies against. Read from the directory rather
// than a hard-coded list of producers, so a new pin is mirrored without an
// edit here.
export const PIN_HOLDERS = ['mica-build', 'mica-boards', 'mica-core', 'mica-podman', 'mica-system-base']

// Phase 3: the vendor trees, mirrored as depth-1 packfiles. Enumerated now for
// the record; nothing is produced until that phase.
export const GIT_SOURCES: LockSource[] = [
  { repository: 'mica-boards', lock: 'locks/upstream.lock' },
  { repository: 'mica-podman', lock: 'locks/upstream.lock' },
]

// The repositories the status collector snapshots. Every one is public, so the
// runs and jobs it reads are public data.
export const REPOSITORIES = [
  'mica',
  'mica-boards',
  'mica-build',
  'mica-build-env',
  'mica-core',
  'mica-podman',
  'mica-res',
  'mica-system-base',
]
