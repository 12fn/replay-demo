import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { SOURCE_ARCHIVE_LIMITS, extractVerifiedSource } from "../../src/server/catalog-source-archive.ts";

const REJECTED = "Source archive verification failed";
import {BLOCK, sha, writeString, writeOctal, setChecksum, header, padded, paxRecords, tarOf, expectedFor, type Entry} from "../fixtures/synthetic-tar";

const TARGET = "evidence/dual-model-trial/run/final/summary.json";
const TEXT = '{"outcome":"held","note":"naïve — ✓"}\n';
const baseEntries = (): Entry[] => [
  { name: "run/manifest.json", prefix: "evidence/dual-model-trial", body: "{}\n" },
  { name: "run/final/summary.json", prefix: "evidence/dual-model-trial", body: TEXT },
  { name: "evidence/dual-model-trial/run/final/replay.json", body: "[]\n" },
];

function extractFrom(tar: Uint8Array, path = TARGET, body: string | Uint8Array = TEXT) {
  const gz = gzipSync(tar);
  return () => extractVerifiedSource(gz, expectedFor(gz, path, body));
}

describe("extractVerifiedSource", () => {
  it("returns a verified member joined from the ustar prefix", () => {
    const result = extractFrom(tarOf(baseEntries()))();
    expect(result).toEqual({ text: TEXT, bytes: Buffer.byteLength(TEXT), sha256: sha(TEXT) });
  });

  it("honours a PAX path override", () => {
    const entries = baseEntries();
    entries[1] = { name: "PaxHeader-truncated", body: TEXT, pax: { path: TARGET, mtime: "1" } };
    expect(extractFrom(tarOf(entries))().text).toBe(TEXT);
  });

  it("checks the compressed SHA-256 before inflating", () => {
    const gz = gzipSync(tarOf(baseEntries()));
    const expected = expectedFor(gz, TARGET, TEXT);
    expect(() => extractVerifiedSource(gz, { ...expected, archiveSha256: "0".repeat(64) })).toThrow(REJECTED);
    // Not gzip at all, but correctly hashed: fails only at inflate.
    const junk = Buffer.from("definitely not gzip");
    expect(() => extractVerifiedSource(junk, { ...expected, archiveSha256: sha(junk) })).toThrow(REJECTED);
  });

  it("rejects corrupted and truncated archives", () => {
    const tar = tarOf(baseEntries());
    const gz = gzipSync(tar);
    const truncatedGzip = gz.subarray(0, gz.length - 12);
    expect(() => extractVerifiedSource(truncatedGzip, expectedFor(truncatedGzip, TARGET, TEXT))).toThrow(REJECTED);

    const badChecksum = Buffer.from(tar);
    badChecksum[BLOCK * 2 + 5] ^= 0x01; // flip a name byte in the first file header
    expect(extractFrom(badChecksum)).toThrow(REJECTED);

    const noTrailer = tarOf(baseEntries(), Buffer.alloc(0));
    expect(extractFrom(noTrailer)).toThrow(REJECTED);

    const cutMidMember = tar.subarray(0, tar.length - 2 * BLOCK - BLOCK);
    expect(extractFrom(cutMidMember)).toThrow(REJECTED);

    const trailingGarbage = Buffer.concat([tar, Buffer.from("x".padEnd(BLOCK, "x"))]);
    expect(extractFrom(trailingGarbage)).toThrow(REJECTED);

    const gnuMagic = baseEntries();
    gnuMagic[0].magic = "ustar  \0";
    expect(extractFrom(tarOf(gnuMagic))).toThrow(REJECTED);

    const malformedPax = Buffer.from(tar);
    malformedPax[BLOCK] = "9".charCodeAt(0); // record length no longer matches
    expect(extractFrom(malformedPax)).toThrow(REJECTED);
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["dot-dot", "evidence/../../escape.json"],
    ["dot segment", "evidence/./summary.json"],
    ["backslash", "evidence\\summary.json"],
    ["empty segment", "evidence//summary.json"],
    ["directory-style", "evidence/"],
  ])("rejects %s member paths anywhere in the archive", (_label, path) => {
    const entries = [...baseEntries(), { name: "x", body: "{}", pax: { path } }];
    expect(extractFrom(tarOf(entries))).toThrow(REJECTED);
  });

  it("rejects duplicate paths, including a duplicate of the selected member after it", () => {
    const dupOther = [...baseEntries(), { name: "run/manifest.json", prefix: "evidence/dual-model-trial", body: "{}\n" }];
    expect(extractFrom(tarOf(dupOther))).toThrow(REJECTED);

    const dupSelected = [...baseEntries(), { name: "run/final/summary.json", prefix: "evidence/dual-model-trial", body: TEXT }];
    expect(extractFrom(tarOf(dupSelected))).toThrow(REJECTED);

    const dupViaPax = [...baseEntries(), { name: "other", body: TEXT, pax: { path: TARGET } }];
    expect(extractFrom(tarOf(dupViaPax))).toThrow(REJECTED);
  });

  it.each([
    ["hard link", "1"],
    ["symlink", "2"],
    ["character device", "3"],
    ["block device", "4"],
    ["directory", "5"],
    ["fifo", "6"],
    ["contiguous file", "7"],
    ["GNU long name", "L"],
    ["global PAX", "g"],
    ["legacy NUL type", "\0"],
  ])("rejects %s entries even after the selected member", (_label, type) => {
    const entries = [...baseEntries(), { name: "evidence/link.json", type, linkname: type === "1" || type === "2" ? TARGET : "" }];
    expect(extractFrom(tarOf(entries))).toThrow(REJECTED);
  });

  it("rejects unsupported PAX keys", () => {
    for (const pax of [{ size: "3" } as Record<string, string>,{ linkpath: TARGET }, { "GNU.sparse.map": "0,0" }, { "LIBARCHIVE.xattr.": "x" }]) {
      const entries = baseEntries();
      entries[2] = { ...entries[2], pax };
      expect(extractFrom(tarOf(entries))).toThrow(REJECTED);
    }
  });

  it("rejects missing members and byte, length or hash mismatches", () => {
    const gz = gzipSync(tarOf(baseEntries()));
    const expected = expectedFor(gz, TARGET, TEXT);
    expect(() => extractVerifiedSource(gz, { ...expected, path: "evidence/missing.json" })).toThrow(REJECTED);
    expect(() => extractVerifiedSource(gz, { ...expected, bytes: expected.bytes - 1 })).toThrow(REJECTED);
    expect(() => extractVerifiedSource(gz, { ...expected, bytes: expected.bytes + 1 })).toThrow(REJECTED);
    expect(() => extractVerifiedSource(gz, { ...expected, sha256: sha("something else") })).toThrow(REJECTED);
    expect(() => extractVerifiedSource(gz, { ...expected, sha256: expected.sha256.toUpperCase() })).toThrow(REJECTED);

    const tampered = TEXT.replace("held", "lost");
    expect(extractFrom(tarOf(baseEntries().map((e, i) => (i === 1 ? { ...e, body: tampered } : e))))).toThrow(REJECTED);
  });

  it("rejects non-text members: NUL bytes and invalid UTF-8", () => {
    for (const body of [Buffer.from('{"a":"\0"}'), Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), Buffer.from([0xed, 0xa0, 0x80])]) {
      const entries = baseEntries().map((e, i) => (i === 1 ? { ...e, body } : e));
      expect(extractFrom(tarOf(entries), TARGET, body)).toThrow(REJECTED);
    }
  });

  it("enforces the compressed, decompressed, member and selected-text caps", () => {
    // Otherwise valid: incompressible filler keeps the gzip over 8 MiB while inflating well under 64 MiB.
    const filler = { name: "evidence/filler.bin", body: randomBytes(SOURCE_ARCHIVE_LIMITS.compressedBytes + BLOCK) };
    const oversizeCompressed = gzipSync(tarOf([...baseEntries(), filler]));
    expect(oversizeCompressed.length).toBeGreaterThan(SOURCE_ARCHIVE_LIMITS.compressedBytes);
    expect(() => extractVerifiedSource(oversizeCompressed, expectedFor(oversizeCompressed, TARGET, TEXT))).toThrow(REJECTED);

    // A tiny gzip bomb: a valid tar followed by zero padding that inflates past the cap.
    const bomb = gzipSync(Buffer.concat([tarOf(baseEntries()), Buffer.alloc(SOURCE_ARCHIVE_LIMITS.decompressedBytes)]));
    expect(bomb.length).toBeLessThan(SOURCE_ARCHIVE_LIMITS.compressedBytes);
    expect(() => extractVerifiedSource(bomb, expectedFor(bomb, TARGET, TEXT))).toThrow(REJECTED);

    const many: Entry[] = Array.from({ length: SOURCE_ARCHIVE_LIMITS.members }, (_, i) => ({ name: `evidence/m/${i}.json`, pax: {} }));
    const atCap = [...many.slice(1), { name: TARGET, body: TEXT, pax: {} }];
    expect(extractFrom(tarOf(atCap))().text).toBe(TEXT);
    expect(extractFrom(tarOf([...atCap, { name: "evidence/one-more.json", pax: {} }]))).toThrow(REJECTED);

    const big = "a".repeat(SOURCE_ARCHIVE_LIMITS.selectedTextBytes + 1);
    expect(extractFrom(tarOf([{ name: TARGET, body: big }]), TARGET, big)).toThrow(REJECTED);
    const atLimit = big.slice(1);
    expect(extractFrom(tarOf([{ name: TARGET, body: atLimit }]), TARGET, atLimit)().bytes).toBe(SOURCE_ARCHIVE_LIMITS.selectedTextBytes);
  });

  it("rejects malformed expectations before touching the archive", () => {
    const gz = gzipSync(tarOf(baseEntries()));
    const expected = expectedFor(gz, TARGET, TEXT);
    for (const bad of [
      { ...expected, path: "../summary.json" },
      { ...expected, archiveSha256: "sha256:" + expected.archiveSha256 },
      { ...expected, bytes: -1 },
      { ...expected, bytes: 1.5 },
    ]) {
      expect(() => extractVerifiedSource(gz, bad)).toThrow(REJECTED);
    }
  });
});

