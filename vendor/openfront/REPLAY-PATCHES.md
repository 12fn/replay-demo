# REPLAY changes to the pinned core

Upstream: OpenFrontIO commit0f2ef7c43511cfb413a95e07d364139249d6905d. Original license and asset notices remain alongside the source.

## Transport initialization stagger

`src/core/execution/TransportShipExecution.ts` is modified for REPLAY simulation profile `naval-isolation/1`: pathfinder rebuild stagger allocation belongs to a game instance rather than a process-wide static counter. This keeps other exercises and replay reconstruction from changing the allocation. The patch and adapter are supplied in the corresponding-source archive.

The profile is recorded for new exercises and branch continuations. Old recordings retain their original metadata and fingerprints; they are accepted only where replay matches recorded fingerprints. A missing legacy transport scheduling offset is not invented. See the build journal and naval qualification notes for measured coverage and limitations.
