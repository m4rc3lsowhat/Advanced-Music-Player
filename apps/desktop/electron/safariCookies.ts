// Reads cookies from Safari's `Cookies.binarycookies` file on macOS.
//
// Safari is not Chromium: cookies are stored in Apple's binary "binarycookies" format and are NOT
// encrypted (no Keychain needed). The catch is location — the file lives in Safari's sandbox
// container, which macOS TCC protects. The reading app (AMP, or the dev Electron) must be
// granted **Full Disk Access** in System Settings → Privacy & Security, or the read fails with
// EPERM/EACCES, surfaced here as FullDiskAccessError.
//
// Format (big-endian header, little-endian page/cookie fields):
//   magic "cook" | uint32 pageCount | uint32 pageSize[pageCount] | pages... | trailer
//   page:   0x00000100 | uint32LE cookieCount | uint32LE cookieOffset[count] | footer | records
//   record: uint32LE size | _ | uint32LE flags | _ | uint32LE {domain,name,path,value}Off | ...
//           offsets are relative to the record start; each points at a NUL-terminated string.

import { readFile } from "node:fs/promises";

export interface SafariCookie {
  name: string;
  value: string;
  hostKey: string;
}

/** Thrown when the Safari cookie file can't be read because the app lacks Full Disk Access. */
export class FullDiskAccessError extends Error {}

const MAGIC = "cook";

function readCString(buf: Buffer, at: number): string {
  if (at < 0 || at >= buf.length) {
    return "";
  }
  let end = at;
  while (end < buf.length && buf[end] !== 0) {
    end += 1;
  }
  return buf.toString("utf8", at, end);
}

function parseCookieRecord(buf: Buffer, recordStart: number, out: SafariCookie[], host: string): void {
  // Need at least the fixed 56-byte header before the strings.
  if (recordStart + 56 > buf.length) {
    return;
  }
  const domainOff = buf.readUInt32LE(recordStart + 16);
  const nameOff = buf.readUInt32LE(recordStart + 20);
  const valueOff = buf.readUInt32LE(recordStart + 28);

  const hostKey = readCString(buf, recordStart + domainOff);
  const normalizedHost = hostKey.replace(/^\./, "").toLowerCase();
  const expectedHost = host.replace(/^\./, "").toLowerCase();
  if (!normalizedHost || (normalizedHost !== expectedHost && !normalizedHost.endsWith(`.${expectedHost}`))) {
    return;
  }
  const name = readCString(buf, recordStart + nameOff);
  const value = readCString(buf, recordStart + valueOff);
  out.push({ name, value, hostKey });
}

function parsePage(buf: Buffer, pageStart: number, pageSize: number, out: SafariCookie[], host: string): void {
  const pageEnd = Math.min(pageStart + pageSize, buf.length);
  let p = pageStart + 4; // skip 0x00000100 page header
  if (p + 4 > pageEnd) {
    return;
  }
  const cookieCount = buf.readUInt32LE(p);
  p += 4;
  for (let i = 0; i < cookieCount; i += 1) {
    if (p + 4 > pageEnd) {
      return;
    }
    const cookieOffset = buf.readUInt32LE(p);
    p += 4;
    parseCookieRecord(buf, pageStart + cookieOffset, out, host);
  }
}

/** Parses a binarycookies buffer, returning only cookies for a host or its subdomains. */
export function parseBinaryCookies(buf: Buffer, host: string): SafariCookie[] {
  const cookies: SafariCookie[] = [];
  if (buf.length < 8 || buf.toString("latin1", 0, 4) !== MAGIC) {
    return cookies;
  }
  const pageCount = buf.readUInt32BE(4);
  let offset = 8;
  const pageSizes: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    if (offset + 4 > buf.length) {
      return cookies;
    }
    pageSizes.push(buf.readUInt32BE(offset));
    offset += 4;
  }
  let pageStart = offset;
  for (let i = 0; i < pageCount; i += 1) {
    parsePage(buf, pageStart, pageSizes[i], cookies, host);
    pageStart += pageSizes[i];
  }
  return cookies;
}

/**
 * Reads Safari cookies whose host contains `hostContains` (e.g. "soundcloud.com").
 * Throws FullDiskAccessError when the OS denies access to Safari's protected container.
 */
export async function readSafariCookies(cookieFilePath: string, hostContains: string): Promise<SafariCookie[]> {
  let buf: Buffer;
  try {
    buf = await readFile(cookieFilePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new FullDiskAccessError(
        "AMP needs Full Disk Access to read Safari's cookies. Grant it in System Settings → " +
          "Privacy & Security → Full Disk Access, then try again."
      );
    }
    throw error;
  }
  return parseBinaryCookies(buf, hostContains);
}
