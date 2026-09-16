import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { genTerrainFromBin } from '../../vendor/openfront/src/core/game/TerrainMapLoader';

/**
 * Map options are part of a recording's identity: the option name alone determines the terrain, so
 * a record replays and branches on exactly the terrain it was made on. Existing names keep their
 * exact derivation (`world` stays the 400x200 factor-5 downsample). New resolutions are new names,
 * never a change to an old one, and unknown names are rejected before any file is touched.
 */
/** Pinned fixture maps that predate explicit world resolutions. */
export const LEGACY_MAPS = ['plains', 'big_plains', 'world', 'half_land_half_ocean', 'ocean_and_land'] as const;
export type LegacyMap = (typeof LEGACY_MAPS)[number];
/**
 * Explicit resolutions of the pinned world fixture, named by playfield width in tiles.
 * `resample` reuses the exact downsampling below at another factor; `vendor` uses an upstream-shipped
 * binary unchanged (`world-1000` is upstream's own "Compact" size, `world-2000` its "Normal" size).
 */
export const WORLD_RESOLUTIONS = {
  'world-500': { kind: 'resample', factor: 4, mini: 8 },
  'world-1000': { kind: 'vendor', map: 'map4x', mini: 'map16x' },
  'world-2000': { kind: 'vendor', map: 'map', mini: 'map4x' },
} as const satisfies Record<string, { kind: 'resample'; factor: number; mini: number } | { kind: 'vendor'; map: 'map' | 'map4x'; mini: 'map4x' | 'map16x' }>;
export type WorldResolution = keyof typeof WORLD_RESOLUTIONS;
/**
 * Area-of-responsibility maps: a whole upstream map shipped at the pinned engine commit, not a crop of `world`.
 * The playfield is an upstream binary unchanged; the minimap is point-sampled from that playfield. Every file
 * the option reads is pinned by size and sha256 and checked before parsing, so edited bytes are refused instead
 * of silently becoming other terrain under the same name. Different upstream bytes need a new option name.
 */
export const AOR_MAPS = {
  'taiwan-strait-400': {
    folder: 'taiwanstrait', map: 'map16x', miniFactor: 2,
    assets: {
      'manifest.json': { bytes: 2971, sha256: 'bd53ba72d332e2f4cdd82cb15f41e2924ca814faacc2172b400416a0f8286e6f' },
      'map.bin': { bytes: 2560000, sha256: 'b84cad3adf7136fa0e018a3a1a94a67423af262f9a95f0f8b67a1ec25d7b720a' },
      'map16x.bin': { bytes: 160000, sha256: 'e252e7078ff773e298ca40ab1ac64c20202856b26999aff01afd669c2afa908b' },
    },
  },
} as const satisfies Record<string, { folder: string; map: 'map16x'; miniFactor: number; assets: Record<string, { bytes: number; sha256: string }> }>;
export type AorMap = keyof typeof AOR_MAPS;
export type EngineMap = LegacyMap | WorldResolution | AorMap;
export const ENGINE_MAPS: readonly EngineMap[] = [...LEGACY_MAPS, ...(Object.keys(WORLD_RESOLUTIONS) as WorldResolution[]), ...(Object.keys(AOR_MAPS) as AorMap[])];
export function isEngineMap(name: unknown): name is EngineMap { return typeof name === 'string' && (ENGINE_MAPS as readonly string[]).includes(name); }

export interface LoadedMap {
  map: Awaited<ReturnType<typeof genTerrainFromBin>>;
  mini: Awaited<ReturnType<typeof genTerrainFromBin>>;
  /** sha256 of the fixture's full-resolution `map.bin`, whatever resolution is played. */
  sourceHash: string;
  /** How the playfield was derived; recorded in evidence so a resolution is never confused with another. */
  derivation: { source: string; width: number; height: number; landTiles: number; miniWidth: number; miniHeight: number; /** AOR maps only: every verified file read. */ assets?: { file: string; bytes: number; sha256: string }[] };
}

/** Point-sample a native one-byte-per-cell map every `factor` px, keeping land/magnitude and recomputing the shoreline bit. */
function resample(source: Uint8Array, sourceWidth: number, sourceHeight: number, factor: number) {
  const width = Math.floor(sourceWidth / factor), height = Math.floor(sourceHeight / factor);
  const data = new Uint8Array(width * height); let land = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const b = source[(y * factor) * sourceWidth + x * factor]; data[y * width + x] = b & ~64; if (b & 128) land++;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, own = Boolean(data[i] & 128);
    if ([[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < width && ny < height && Boolean(data[ny * width + nx] & 128) !== own)) data[i] |= 64;
  }
  return { metadata: { width, height, num_land_tiles: land }, data };
}

async function loadAorMap(root: string, name: AorMap): Promise<LoadedMap> {
  const spec = AOR_MAPS[name], folder = path.join(root, 'vendor/openfront/tests/testdata/maps', spec.folder);
  const files: Record<string, Buffer> = {};
  for (const [file, pin] of Object.entries(spec.assets)) {
    const bytes = fs.readFileSync(path.join(folder, file)), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== pin.bytes || sha256 !== pin.sha256) throw new Error(`Map ${name} refused: ${spec.folder}/${file} is ${bytes.length} bytes sha256 ${sha256}, pinned ${pin.bytes} bytes sha256 ${pin.sha256}`);
    files[file] = bytes;
  }
  const meta = JSON.parse(files['manifest.json'].toString('utf8'))[spec.map] as { width: number; height: number; num_land_tiles: number };
  const bin = files[`${spec.map}.bin`], small = resample(bin, meta.width, meta.height, spec.miniFactor);
  return {
    map: await genTerrainFromBin(meta, bin), mini: await genTerrainFromBin(small.metadata, small.data), sourceHash: spec.assets['map.bin'].sha256,
    derivation: {
      source: `${spec.folder} ${spec.map}.bin (${meta.width}x${meta.height}) unchanged; minimap point-sampled every ${spec.miniFactor} px from it, shoreline recomputed; sourceHash is ${spec.folder}/map.bin`,
      width: meta.width, height: meta.height, landTiles: meta.num_land_tiles, miniWidth: small.metadata.width, miniHeight: small.metadata.height,
      assets: Object.entries(spec.assets).map(([file, pin]) => ({ file: `${spec.folder}/${file}`, ...pin })),
    },
  };
}

/** Downsample the pinned, licensed world fixture; never invent geographic outlines. */
export async function loadMap(root: string, name: string): Promise<LoadedMap> {
  if (!isEngineMap(name)) throw new Error(`Unknown map option: ${String(name)}`);
  if (name in AOR_MAPS) return loadAorMap(root, name as AorMap);
  const folder = path.join(root, 'vendor/openfront/tests/testdata/maps', name.startsWith('world') ? 'world' : name);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const original = fs.readFileSync(path.join(folder, 'map.bin'));
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const vendor = async (mapKey: 'map' | 'map4x', miniKey: 'map4x' | 'map16x', source: string): Promise<LoadedMap> => {
    const bin = mapKey === 'map' ? original : fs.readFileSync(path.join(folder, `${mapKey}.bin`));
    const meta = manifest[mapKey], miniMeta = manifest[miniKey];
    return { map: await genTerrainFromBin(meta, bin), mini: await genTerrainFromBin(miniMeta, fs.readFileSync(path.join(folder, `${miniKey}.bin`))), sourceHash, derivation: { source, width: meta.width, height: meta.height, landTiles: meta.num_land_tiles, miniWidth: miniMeta.width, miniHeight: miniMeta.height } };
  };
  if (name !== 'world' && !(name in WORLD_RESOLUTIONS)) return vendor('map', 'map4x', `vendor fixture ${name}`);
  const spec = name === 'world' ? { kind: 'resample', factor: 5, mini: 10 } as const : WORLD_RESOLUTIONS[name as WorldResolution];
  if (spec.kind === 'vendor') return vendor(spec.map, spec.mini, `vendor world ${spec.map}.bin unchanged`);
  const full = resample(original, manifest.map.width, manifest.map.height, spec.factor), small = resample(original, manifest.map.width, manifest.map.height, spec.mini);
  return { map: await genTerrainFromBin(full.metadata, full.data), mini: await genTerrainFromBin(small.metadata, small.data), sourceHash, derivation: { source: `world map.bin point-sampled every ${spec.factor} px, shoreline recomputed`, width: full.metadata.width, height: full.metadata.height, landTiles: full.metadata.num_land_tiles, miniWidth: small.metadata.width, miniHeight: small.metadata.height } };
}
