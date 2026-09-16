/* Synthetic TAR/PAX builder extracted from public archive security tests. */
import {createHash} from "node:crypto";
export const BLOCK = 512;

export const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface Entry {
  name: string;
  body?: Uint8Array | string;
  type?: string;
  prefix?: string;
  linkname?: string;
  magic?: string;
  pax?: Record<string, string>;
}

export function writeString(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`field overflow: ${value}`);
  bytes.copy(block, offset);
}

export function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

export function setChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
}

export function header(name: string, size: number, type: string, opts: Partial<Entry> = {}): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 1_789_457_615);
  h.write(type, 156, "latin1");
  writeString(h, 157, 100, opts.linkname ?? "");
  h.write(opts.magic ?? "ustar\x0000", 257, "latin1");
  writeString(h, 345, 155, opts.prefix ?? "");
  setChecksum(h);
  return h;
}

export function padded(body: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.ceil(body.length / BLOCK) * BLOCK);
  Buffer.from(body).copy(out);
  return out;
}

export function paxRecords(fields: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(fields).map(([key, value]) => {
      const tail = ` ${key}=${value}\n`;
      let length = Buffer.byteLength(tail) + 1;
      while (String(length).length + Buffer.byteLength(tail) !== length) length += 1;
      return Buffer.from(`${length}${tail}`);
    }),
  );
}

/** bsdtar-shaped entries: per-file PAX header (mtime + xattr), then a ustar regular file. */
export function tarOf(entries: Entry[], trailer = Buffer.alloc(2 * BLOCK)): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const pax = paxRecords(entry.pax ?? { mtime: "1789457615.852392979", "LIBARCHIVE.xattr.com.apple.provenance": "AQIAdmWXF8GvFww" });
    parts.push(header("PaxHeader/x", pax.length, "x"), padded(pax));
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : Buffer.from(entry.body ?? []);
    parts.push(header(entry.name, body.length, entry.type ?? "0", entry), padded(body));
  }
  parts.push(trailer);
  return Buffer.concat(parts);
}

export function expectedFor(archive: Uint8Array, path: string, body: string | Uint8Array) {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return { archiveSha256: sha(archive), path, sha256: sha(bytes), bytes: bytes.length };
}

