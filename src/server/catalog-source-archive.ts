/**
 * Bounded, in-memory reader for the immutable catalog ontology trial-records archive
 * (handoff/REPLAY-catalog-ontology-4/trial-records.tar.gz).
 *
 * Pure: no filesystem, no shell, no extraction. The caller supplies the archive bytes and the
 * pinned hashes; this module verifies the compressed SHA-256 before inflating, validates every
 * header in the archive, and only then returns the one requested member as strict UTF-8 text.
 *
 * Supported format is deliberately narrow — what bsdtar writes for this archive:
 * POSIX ustar ("ustar\0" + "00") regular files, optional ustar `prefix`, and per-file PAX `x`
 * headers carrying only `path`, time fields and xattrs. Everything else is rejected.
 * All failures throw the same generic error so callers cannot leak archive internals.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const MiB = 1024 * 1024;

export const SOURCE_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 8 * MiB,
  decompressedBytes: 64 * MiB,
  members: 10_000,
  selectedTextBytes: 256 * 1024,
});

export interface ExpectedSource {
  archiveSha256: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface VerifiedSource {
  text: string;
  bytes: number;
  sha256: string;
}

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ALLOWED_PAX_KEYS = new Set(["path", "mtime", "atime", "ctime"]);
const ALLOWED_PAX_PREFIXES = ["LIBARCHIVE.xattr.", "SCHILY.xattr."];

class SourceArchiveError extends Error {
  constructor() {
    super("Source archive verification failed");
    this.name = "SourceArchiveError";
  }
}

function fail(): never {
  throw new SourceArchiveError();
}

function check(condition: boolean): asserts condition {
  if (!condition) fail();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail();
  }
}

function isSafePath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > MAX_PATH_BYTES) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** NUL-terminated (or field-filling) string field, strict UTF-8. */
function stringField(header: Uint8Array, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decodeUtf8(end === -1 ? field : field.subarray(0, end));
}

/** Octal numeric field terminated by NUL/space. Base-256 (GNU binary) values are rejected. */
function octalField(header: Uint8Array, offset: number, length: number): number {
  const raw = Buffer.from(header.subarray(offset, offset + length)).toString("latin1");
  const digits = raw.replace(/[\0 ]+$/, "");
  check(/^[0-7]{1,11}$/.test(digits));
  return Number.parseInt(digits, 8);
}

function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

function verifyHeaderChecksum(header: Uint8Array): void {
  const stored = octalField(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  check(stored === sum);
}

/** Parses `<len> <key>=<value>\n` records; returns the `path` override, if any. */
function parsePax(data: Uint8Array): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    check(space > offset && space - offset <= 5);
    const lengthText = Buffer.from(data.subarray(offset, space)).toString("latin1");
    check(/^[1-9][0-9]*$/.test(lengthText));
    const recordEnd = offset + Number(lengthText);
    check(recordEnd <= data.length && recordEnd > space + 1 && data[recordEnd - 1] === 0x0a);
    const record = data.subarray(space + 1, recordEnd - 1);
    const equals = record.indexOf(0x3d);
    check(equals > 0);
    const key = decodeUtf8(record.subarray(0, equals));
    const allowed = ALLOWED_PAX_KEYS.has(key) || ALLOWED_PAX_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length);
    check(allowed);
    if (key === "path") {
      check(path === undefined);
      path = decodeUtf8(record.subarray(equals + 1));
    }
    offset = recordEnd;
  }
  return path;
}

function verifyExpected(expected: ExpectedSource): void {
  check(typeof expected === "object" && expected !== null);
  check(typeof expected.archiveSha256 === "string" && SHA256_HEX.test(expected.archiveSha256));
  check(typeof expected.sha256 === "string" && SHA256_HEX.test(expected.sha256));
  check(typeof expected.path === "string" && isSafePath(expected.path));
  check(Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && expected.bytes <= SOURCE_ARCHIVE_LIMITS.selectedTextBytes);
}

function inflate(archive: Uint8Array): Uint8Array {
  try {
    return gunzipSync(archive, { maxOutputLength: SOURCE_ARCHIVE_LIMITS.decompressedBytes });
  } catch {
    return fail();
  }
}

export function extractVerifiedSource(archive: Uint8Array, expected: ExpectedSource): VerifiedSource {
  verifyExpected(expected);
  check(archive instanceof Uint8Array);
  check(archive.length > 0 && archive.length <= SOURCE_ARCHIVE_LIMITS.compressedBytes);
  check(sha256Hex(archive) === expected.archiveSha256);

  const tar = inflate(archive);
  check(tar.length % BLOCK === 0);

  const seen = new Set<string>();
  let selected: Uint8Array | undefined;
  let members = 0;
  let pendingPaxPath: string | undefined;
  let pendingPax = false;
  let offset = 0;
  let ended = false;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      // End of archive: two zero blocks, and nothing but zeros after them. A PAX header must not dangle.
      check(!pendingPax && offset + 2 * BLOCK <= tar.length && isZeroBlock(tar.subarray(offset)));
      ended = true;
      break;
    }

    verifyHeaderChecksum(header);
    check(Buffer.from(header.subarray(257, 265)).toString("latin1") === "ustar\x0000");
    const size = octalField(header, 124, 12);
    const type = header[156];
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    check(next <= tar.length);
    const data = tar.subarray(dataStart, dataEnd);
    check(isZeroBlock(tar.subarray(dataEnd, next)));

    if (type === 0x78 /* 'x' */) {
      check(!pendingPax && size <= MAX_PAX_BYTES);
      pendingPaxPath = parsePax(data);
      pendingPax = true;
    } else if (type === 0x30 /* '0' */) {
      members += 1;
      check(members <= SOURCE_ARCHIVE_LIMITS.members);
      const name = stringField(header, 0, 100);
      const prefix = stringField(header, 345, 155);
      const path = pendingPaxPath ?? (prefix ? `${prefix}/${name}` : name);
      check(isSafePath(path) && !seen.has(path));
      seen.add(path);
      if (path === expected.path) selected = data;
      pendingPaxPath = undefined;
      pendingPax = false;
    } else {
      // Links, directories, devices, FIFOs, GNU long names, global PAX and vendor extensions.
      fail();
    }
    offset = next;
  }

  check(ended && selected !== undefined);
  check(selected.length === expected.bytes && selected.length <= SOURCE_ARCHIVE_LIMITS.selectedTextBytes);
  const sha256 = sha256Hex(selected);
  check(sha256 === expected.sha256);
  check(!selected.includes(0));
  return { text: decodeUtf8(selected), bytes: selected.length, sha256 };
}
