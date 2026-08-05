import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { isValidGeoCategory, isValidKeyword } from "@submerge/shared";
import { normalizeObservedFqdn } from "./observer.js";

export type GeositeRule = {
  kind: "exact" | "suffix" | "keyword";
  value: string;
};

export interface ActiveGeositeSnapshot {
  categories: ReadonlyMap<string, readonly GeositeRule[] | null>;
  isCurrent: () => boolean;
}

export const MAX_GEOSITE_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_GEOSITE_CATEGORY_ENTRIES = 250_000;
export const MAX_ACTIVE_GEOSITE_RULES = 250_000;
export const MAX_ACTIVE_GEOSITE_SELECTORS = 64;
const MAX_GEOSITE_VALUE_BYTES = 4_096;
const utf8 = new TextDecoder("utf-8", { fatal: true });

// geosite.dat is a protobuf GeoSiteList. Keep this bounded decoder aligned with
// V2Ray's routercommon/common.proto, which is also the format consumed by Mihomo.

interface Cursor {
  offset: number;
  readonly end: number;
}

interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  nlink: number;
}

function boundedActiveSelectors(selectors: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    const normalized = selector.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_ACTIVE_GEOSITE_SELECTORS) break;
  }
  return result;
}

function readVarint(buffer: Uint8Array, cursor: Cursor): number {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 10 && cursor.offset < cursor.end; index += 1) {
    const byte = buffer[cursor.offset];
    if (byte === undefined) throw new Error("truncated protobuf varint");
    cursor.offset += 1;
    if (index === 9 && byte > 1) throw new Error("overflowing protobuf varint");
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0 && Number.isSafeInteger(value)) return value;
    multiplier *= 128;
  }
  throw new Error("invalid protobuf varint");
}

function readBytes(buffer: Uint8Array, cursor: Cursor): Uint8Array {
  const length = readVarint(buffer, cursor);
  const end = cursor.offset + length;
  if (!Number.isSafeInteger(end) || end > cursor.end) {
    throw new Error("invalid protobuf byte field");
  }
  const value = buffer.subarray(cursor.offset, end);
  cursor.offset = end;
  return value;
}

function skipVarint(buffer: Uint8Array, cursor: Cursor): void {
  for (let index = 0; index < 10 && cursor.offset < cursor.end; index += 1) {
    const byte = buffer[cursor.offset];
    if (byte === undefined) break;
    cursor.offset += 1;
    if (index === 9 && byte > 1) throw new Error("overflowing protobuf varint field");
    if ((byte & 0x80) === 0) return;
  }
  throw new Error("invalid protobuf varint field");
}

function requireWireType(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("invalid protobuf wire type for known field");
}

function skipField(buffer: Uint8Array, cursor: Cursor, wireType: number): void {
  if (wireType === 0) {
    skipVarint(buffer, cursor);
    return;
  }
  if (wireType === 1) cursor.offset += 8;
  else if (wireType === 2) void readBytes(buffer, cursor);
  else if (wireType === 5) cursor.offset += 4;
  else throw new Error("unsupported protobuf wire type");
  if (cursor.offset > cursor.end) throw new Error("truncated protobuf field");
}

function readKey(buffer: Uint8Array, cursor: Cursor): { field: number; wireType: number } {
  const key = readVarint(buffer, cursor);
  const field = Math.floor(key / 8);
  const wireType = key % 8;
  if (field < 1 || field > 0x1fffffff) throw new Error("invalid protobuf field number");
  return { field, wireType };
}

function normalizeSiteCode(value: string): string {
  if (value !== value.trim()) return "";
  const normalized = value.toLowerCase();
  return isValidGeoCategory(normalized) ? normalized : "";
}

function normalizeGeositeDomain(value: string): string | null {
  if (value !== value.trim() || value.endsWith(".") || !/^[\x21-\x7e]+$/.test(value)) {
    return null;
  }
  const lowercase = value.toLowerCase();
  const normalized = normalizeObservedFqdn(value);
  if (normalized) return normalized === lowercase ? normalized : null;

  const probePrefix = "submerge-probe.";
  const withProbe = normalizeObservedFqdn(`${probePrefix}${value}`);
  const singleLabel = withProbe?.startsWith(probePrefix)
    ? withProbe.slice(probePrefix.length)
    : null;
  return singleLabel === lowercase ? singleLabel : null;
}

function materializeDomainRule(type: number, value: string): GeositeRule | null {
  if (type === 0) {
    if (value !== value.trim() || !/^[\x21-\x7e]+$/.test(value)) return null;
    const normalized = value.toLowerCase();
    return isValidKeyword(normalized) ? { kind: "keyword", value: normalized } : null;
  }
  if (type !== 2 && type !== 3) return null;
  const normalized = normalizeGeositeDomain(value);
  if (!normalized) return null;
  return { kind: type === 2 ? "suffix" : "exact", value: normalized };
}

function decodeString(value: Uint8Array): string {
  if (value.length === 0 || value.length > MAX_GEOSITE_VALUE_BYTES) {
    throw new Error("invalid geosite string length");
  }
  const decoded = utf8.decode(value);
  if (decoded.includes("\0")) throw new Error("invalid geosite string");
  return decoded;
}

function validateAttribute(attribute: Uint8Array): void {
  const cursor: Cursor = { offset: 0, end: attribute.length };
  while (cursor.offset < cursor.end) {
    const { field, wireType } = readKey(attribute, cursor);
    if (field === 1) {
      requireWireType(wireType, 2);
      void decodeString(readBytes(attribute, cursor));
    } else if (field === 2 || field === 3) {
      requireWireType(wireType, 0);
      skipVarint(attribute, cursor);
    } else {
      skipField(attribute, cursor, wireType);
    }
  }
}

function readSiteCode(site: Uint8Array): string {
  const cursor: Cursor = { offset: 0, end: site.length };
  let code = "";
  while (cursor.offset < cursor.end) {
    const { field, wireType } = readKey(site, cursor);
    if (field === 1) {
      requireWireType(wireType, 2);
      code = decodeString(readBytes(site, cursor));
    } else if (field === 2 || field === 3) {
      requireWireType(wireType, 2);
      void readBytes(site, cursor);
    } else if (field === 4 || field === 68_000) {
      requireWireType(wireType, 2);
      void decodeString(readBytes(site, cursor));
    } else {
      skipField(site, cursor, wireType);
    }
  }
  return normalizeSiteCode(code);
}

function readDomainRule(
  domain: Uint8Array,
  materialize: boolean,
): { rule: GeositeRule | null; supported: boolean } {
  const cursor: Cursor = { offset: 0, end: domain.length };
  let type = 0;
  let value = "";
  while (cursor.offset < cursor.end) {
    const { field, wireType } = readKey(domain, cursor);
    if (field === 1) {
      requireWireType(wireType, 0);
      type = readVarint(domain, cursor);
    } else if (field === 2) {
      requireWireType(wireType, 2);
      value = decodeString(readBytes(domain, cursor));
    } else if (field === 3) {
      requireWireType(wireType, 2);
      validateAttribute(readBytes(domain, cursor));
    } else {
      skipField(domain, cursor, wireType);
    }
  }
  if (!value) throw new Error("missing geosite domain value");
  if (!materialize) return { rule: null, supported: type === 0 || type === 2 || type === 3 };
  const rule = materializeDomainRule(type, value);
  return { rule, supported: rule !== null };
}

function readSiteRules(
  site: Uint8Array,
  materialize: boolean,
  remainingEntries: number,
): { entries: number; rules: readonly GeositeRule[] | null } {
  const cursor: Cursor = { offset: 0, end: site.length };
  const rules: GeositeRule[] = [];
  let entries = 0;
  let supported = true;
  while (cursor.offset < cursor.end) {
    const { field, wireType } = readKey(site, cursor);
    if (field === 1) {
      requireWireType(wireType, 2);
      void decodeString(readBytes(site, cursor));
    } else if (field === 2) {
      requireWireType(wireType, 2);
      entries += 1;
      if (entries > remainingEntries || entries > MAX_GEOSITE_CATEGORY_ENTRIES) {
        throw new Error("geosite entry budget exceeded");
      }
      const decoded = readDomainRule(readBytes(site, cursor), materialize && supported);
      if (!decoded.supported) {
        supported = false;
        rules.length = 0;
      } else if (decoded.rule) {
        rules.push(decoded.rule);
      }
    } else if (field === 3) {
      requireWireType(wireType, 2);
      void readBytes(site, cursor);
    } else if (field === 4 || field === 68_000) {
      requireWireType(wireType, 2);
      void decodeString(readBytes(site, cursor));
    } else {
      skipField(site, cursor, wireType);
    }
  }
  return { entries, rules: materialize && supported ? rules : null };
}

export function decodeActiveGeositeCategories(
  content: Uint8Array,
  selectors: readonly string[],
): ReadonlyMap<string, readonly GeositeRule[] | null> {
  const result = new Map<string, readonly GeositeRule[] | null>();
  const requestedCodes = new Map<string, string>();
  for (const normalized of boundedActiveSelectors(selectors)) {
    result.set(normalized, null);
    if (!normalized.includes("@")) requestedCodes.set(normalized, normalized);
  }
  if (content.length === 0 || content.length > MAX_GEOSITE_CONTENT_BYTES) return result;

  try {
    const seen = new Set<string>();
    let totalEntries = 0;
    const cursor: Cursor = { offset: 0, end: content.length };
    while (cursor.offset < cursor.end) {
      const { field, wireType } = readKey(content, cursor);
      if (field !== 1) {
        skipField(content, cursor, wireType);
        continue;
      }
      requireWireType(wireType, 2);
      const site = readBytes(content, cursor);
      const code = readSiteCode(site);
      const selector = requestedCodes.get(code);
      const duplicate = selector ? seen.has(selector) : false;
      const decoded = readSiteRules(
        site,
        Boolean(selector && !duplicate),
        MAX_ACTIVE_GEOSITE_RULES - totalEntries,
      );
      totalEntries += decoded.entries;
      if (!selector) continue;
      if (duplicate) {
        result.set(selector, null);
        continue;
      }
      seen.add(selector);
      result.set(selector, decoded.rules);
    }
  } catch {
    for (const selector of result.keys()) result.set(selector, null);
  }
  return result;
}

function readGeositeFile(path: string): { content: Buffer; identity: FileIdentity } | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      before.size === 0 ||
      before.size > MAX_GEOSITE_CONTENT_BYTES
    )
      return null;
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const read = readSync(descriptor, content, offset, content.length - offset, offset);
      if (read === 0) return null;
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink
    ) {
      return null;
    }
    return {
      content,
      identity: {
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        mode: before.mode,
        nlink: before.nlink,
      },
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

interface DirectorySnapshot {
  path: string;
  identity: FileIdentity;
}

function safeDirectory(path: string): DirectorySnapshot | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) return null;
    const realPath = realpathSync(path);
    const realStats = lstatSync(realPath);
    if (
      !realStats.isDirectory() ||
      realStats.isSymbolicLink() ||
      (realStats.mode & 0o022) !== 0 ||
      realStats.dev !== stats.dev ||
      realStats.ino !== stats.ino
    ) {
      return null;
    }
    return {
      path: realPath,
      identity: {
        path: realPath,
        dev: realStats.dev,
        ino: realStats.ino,
        size: realStats.size,
        mtimeMs: realStats.mtimeMs,
        ctimeMs: realStats.ctimeMs,
        mode: realStats.mode,
        nlink: realStats.nlink,
      },
    };
  } catch {
    return null;
  }
}

function identityMatches(identity: FileIdentity, current: ReturnType<typeof fstatSync>): boolean {
  return (
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.size === identity.size &&
    current.mtimeMs === identity.mtimeMs &&
    current.ctimeMs === identity.ctimeMs &&
    current.mode === identity.mode &&
    current.nlink === identity.nlink
  );
}

function identityIsCurrent(identity: FileIdentity, kind: "directory" | "file"): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      identity.path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (kind === "directory" ? constants.O_DIRECTORY : 0),
    );
    const current = fstatSync(descriptor);
    return (
      (kind === "directory" ? current.isDirectory() : current.isFile()) &&
      (current.mode & 0o022) === 0 &&
      (kind === "directory" || current.nlink === 1) &&
      identityMatches(identity, current)
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type GeositeFileCandidate =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; read: { content: Buffer; identity: FileIdentity } };

function readGeositeCandidate(path: string): GeositeFileCandidate {
  try {
    void lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid" };
  }
  const read = readGeositeFile(path);
  return read ? { kind: "valid", read } : { kind: "invalid" };
}

function sameUnderlyingFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function selectGeositeCandidate(
  lower: GeositeFileCandidate,
  upper: GeositeFileCandidate,
): { content: Buffer; identity: FileIdentity } | null {
  if (lower.kind === "valid" && upper.kind === "absent") return lower.read;
  if (upper.kind === "valid" && lower.kind === "absent") return upper.read;
  if (
    lower.kind === "valid" &&
    upper.kind === "valid" &&
    sameUnderlyingFile(lower.read.identity, upper.read.identity)
  ) {
    return lower.read;
  }
  return null;
}

function candidateIsCurrent(candidate: GeositeFileCandidate, path: string): boolean {
  if (candidate.kind === "valid") return identityIsCurrent(candidate.read.identity, "file");
  if (candidate.kind === "invalid") return false;
  try {
    void lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function materializeActiveGeositeSnapshot(
  mihomoDirectory: string,
  selectors: readonly string[],
): ActiveGeositeSnapshot {
  const uniqueSelectors = boundedActiveSelectors(selectors);
  if (uniqueSelectors.length === 0) {
    return { categories: new Map(), isCurrent: () => true };
  }
  const directory = safeDirectory(mihomoDirectory);
  const lowerPath = directory ? join(directory.path, "geosite.dat") : "";
  const upperPath = directory ? join(directory.path, "GeoSite.dat") : "";
  const lower = directory ? readGeositeCandidate(lowerPath) : ({ kind: "invalid" } as const);
  const upper = directory ? readGeositeCandidate(upperPath) : ({ kind: "invalid" } as const);
  const read = selectGeositeCandidate(lower, upper);
  const categories = read
    ? decodeActiveGeositeCategories(read.content, uniqueSelectors)
    : new Map(uniqueSelectors.map((selector) => [selector, null] as const));
  return {
    categories,
    isCurrent: () => {
      if (!directory || !read) return false;
      const currentDirectory = safeDirectory(mihomoDirectory);
      return (
        currentDirectory !== null &&
        sameUnderlyingFile(directory.identity, currentDirectory.identity) &&
        identityIsCurrent(directory.identity, "directory") &&
        candidateIsCurrent(lower, lowerPath) &&
        candidateIsCurrent(upper, upperPath)
      );
    },
  };
}
