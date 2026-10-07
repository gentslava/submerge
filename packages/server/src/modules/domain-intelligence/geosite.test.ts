import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeActiveGeositeCategories,
  MAX_ACTIVE_GEOSITE_RULES,
  MAX_ACTIVE_GEOSITE_SELECTORS,
  materializeActiveGeositeSnapshot,
} from "./geosite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function protobufVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining > 0 ? 0x80 : 0));
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function protobufBytes(field: number, value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([protobufVarint(field * 8 + 2), protobufVarint(bytes.length), bytes]);
}

function domain(type: number, value: string): Buffer {
  return Buffer.concat([protobufVarint(8), protobufVarint(type), protobufBytes(2, value)]);
}

function site(code: string, domains: readonly Buffer[]): Buffer {
  return protobufBytes(
    1,
    Buffer.concat([protobufBytes(1, code), ...domains.map((entry) => protobufBytes(2, entry))]),
  );
}

function repeatedSite(code: string, count: number): Buffer {
  const codeField = protobufBytes(1, code);
  const domainField = protobufBytes(2, domain(2, "x"));
  const body = Buffer.alloc(codeField.length + domainField.length * count);
  codeField.copy(body);
  for (let index = 0; index < count; index += 1) {
    domainField.copy(body, codeField.length + domainField.length * index);
  }
  return protobufBytes(1, body);
}

describe("decodeActiveGeositeCategories", () => {
  it("decodes Mihomo's plain, root-domain and full-domain entries", () => {
    const database = Buffer.concat([
      site("YOUTUBE", [
        domain(0, "video-cdn"),
        domain(2, "youtube.example"),
        domain(3, "exact.youtube.example"),
      ]),
    ]);

    expect(decodeActiveGeositeCategories(database, ["youtube"]).get("youtube")).toEqual([
      { kind: "keyword", value: "video-cdn" },
      { kind: "suffix", value: "youtube.example" },
      { kind: "exact", value: "exact.youtube.example" },
    ]);
  });

  it("fails closed for a regex category, missing category, or attribute selector", () => {
    const database = site("YOUTUBE", [domain(1, "^youtube\\.example$")]);
    const categories = decodeActiveGeositeCategories(database, [
      "youtube",
      "missing",
      "youtube@ads",
    ]);

    expect(categories.get("youtube")).toBeNull();
    expect(categories.get("missing")).toBeNull();
    expect(categories.get("youtube@ads")).toBeNull();
  });

  it("fails every requested category closed when the protobuf is malformed", () => {
    const categories = decodeActiveGeositeCategories(Buffer.from([0x0a, 0x7f]), ["youtube"]);

    expect(categories.get("youtube")).toBeNull();
  });

  it("rejects a known field encoded with the wrong wire type", () => {
    const malformedSite = Buffer.concat([
      protobufVarint(8),
      protobufVarint(1),
      protobufBytes(2, domain(2, "youtube.example")),
    ]);

    expect(
      decodeActiveGeositeCategories(protobufBytes(1, malformedSite), ["youtube"]).get("youtube"),
    ).toBeNull();
  });

  it("rejects malformed nested domains in an unrequested category", () => {
    const malformedSite = Buffer.concat([protobufBytes(1, "OTHER"), Buffer.from([0x12, 0x7f])]);
    const database = Buffer.concat([
      site("YOUTUBE", [domain(2, "youtube.example")]),
      protobufBytes(1, malformedSite),
    ]);

    expect(decodeActiveGeositeCategories(database, ["youtube"]).get("youtube")).toBeNull();
  });

  it("rejects overflowing uint64 varints", () => {
    const overflowingUint64 = Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02,
    ]);
    const siteWithUnknownVarint = Buffer.concat([
      protobufBytes(1, "YOUTUBE"),
      protobufVarint(5 * 8),
      overflowingUint64,
      protobufBytes(2, domain(2, "youtube.example")),
    ]);

    expect(
      decodeActiveGeositeCategories(protobufBytes(1, siteWithUnknownVarint), ["youtube"]).get(
        "youtube",
      ),
    ).toBeNull();
  });

  it("rejects protobuf field numbers above the protocol maximum", () => {
    const tooLargeField = 0x20000000;
    const topLevel = Buffer.concat([
      protobufVarint(tooLargeField * 8),
      protobufVarint(1),
      site("YOUTUBE", [domain(2, "youtube.example")]),
    ]);
    const nestedSite = Buffer.concat([
      protobufBytes(1, "YOUTUBE"),
      protobufVarint(tooLargeField * 8),
      protobufVarint(1),
      protobufBytes(2, domain(2, "youtube.example")),
    ]);

    expect(decodeActiveGeositeCategories(topLevel, ["youtube"]).get("youtube")).toBeNull();
    expect(
      decodeActiveGeositeCategories(protobufBytes(1, nestedSite), ["youtube"]).get("youtube"),
    ).toBeNull();
  });

  it("does not trim a database category identifier that Mihomo would not select", () => {
    const database = site(" YOUTUBE ", [domain(2, "youtube.example")]);

    expect(decodeActiveGeositeCategories(database, ["youtube"]).get("youtube")).toBeNull();
  });

  it.each([
    [2, "example.com."],
    [3, " example.com"],
    [3, "ｅxample.com"],
    [0, " video-cdn"],
  ])(
    "keeps a category opaque when type %s value %j needs semantic normalization",
    (type, value) => {
      const database = site("YOUTUBE", [domain(type, value)]);

      expect(decodeActiveGeositeCategories(database, ["youtube"]).get("youtube")).toBeNull();
    },
  );

  it("keeps selectors beyond the aggregate selector budget opaque", () => {
    const selectors = Array.from(
      { length: MAX_ACTIVE_GEOSITE_SELECTORS + 1 },
      (_, index) => `category-${index}`,
    );
    const database = site(selectors.at(-1) ?? "", [domain(2, "example")]);

    const categories = decodeActiveGeositeCategories(database, selectors);

    expect(categories.get(selectors.at(-1) ?? "")).toBeUndefined();
  });

  it("fails all requested categories closed when the aggregate rule budget is exceeded", () => {
    const firstCount = Math.floor(MAX_ACTIVE_GEOSITE_RULES / 2) + 1;
    const secondCount = MAX_ACTIVE_GEOSITE_RULES - firstCount + 1;
    const database = Buffer.concat([
      repeatedSite("FIRST", firstCount),
      repeatedSite("SECOND", secondCount),
    ]);

    const categories = decodeActiveGeositeCategories(database, ["first", "second"]);

    expect(categories.get("first")).toBeNull();
    expect(categories.get("second")).toBeNull();
  });
});

describe("materializeActiveGeositeSnapshot", () => {
  it("pins the regular local database identity for the validation run", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-snapshot-"));
    roots.push(root);
    const path = join(root, "geosite.dat");
    writeFileSync(path, site("YOUTUBE", [domain(2, "youtube.example")]));

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);
    expect(snapshot.categories.get("youtube")).toEqual([
      { kind: "suffix", value: "youtube.example" },
    ]);
    expect(snapshot.isCurrent()).toBe(true);

    writeFileSync(path, site("YOUTUBE", [domain(2, "changed.example")]));
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("supports Mihomo images that use the canonical GeoSite.dat casing", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-uppercase-"));
    roots.push(root);
    writeFileSync(join(root, "GeoSite.dat"), site("YOUTUBE", [domain(2, "youtube.example")]));

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);

    expect(snapshot.categories.get("youtube")).toEqual([
      { kind: "suffix", value: "youtube.example" },
    ]);
    expect(snapshot.isCurrent()).toBe(true);
  });

  it("fails closed when distinct lower- and upper-case databases coexist", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-ambiguous-"));
    roots.push(root);
    writeFileSync(join(root, "geosite.dat"), site("YOUTUBE", [domain(2, "lower.example")]));
    writeFileSync(join(root, "GeoSite.dat"), site("YOUTUBE", [domain(2, "upper.example")]));

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);

    const sameFilesystemEntry =
      statSync(join(root, "geosite.dat")).ino === statSync(join(root, "GeoSite.dat")).ino;
    if (sameFilesystemEntry) {
      expect(snapshot.categories.get("youtube")).toEqual([
        { kind: "suffix", value: "upper.example" },
      ]);
      expect(snapshot.isCurrent()).toBe(true);
    } else {
      expect(snapshot.categories.get("youtube")).toBeNull();
      expect(snapshot.isCurrent()).toBe(false);
    }
  });

  it("rejects a symlinked database", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-symlink-"));
    roots.push(root);
    const target = join(root, "target.dat");
    writeFileSync(target, site("YOUTUBE", [domain(2, "youtube.example")]));
    const directory = join(root, "mihomo");
    mkdirSync(directory);
    symlinkSync(target, join(directory, "geosite.dat"));

    const snapshot = materializeActiveGeositeSnapshot(directory, ["youtube"]);
    expect(snapshot.categories.get("youtube")).toBeNull();
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("rejects a group-writable database", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-writable-file-"));
    roots.push(root);
    const path = join(root, "geosite.dat");
    writeFileSync(path, site("YOUTUBE", [domain(2, "youtube.example")]));
    chmodSync(path, 0o664);

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);

    expect(snapshot.categories.get("youtube")).toBeNull();
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("rejects a hard-linked database", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-hardlink-"));
    roots.push(root);
    const target = join(root, "target.dat");
    writeFileSync(target, site("YOUTUBE", [domain(2, "youtube.example")]));
    linkSync(target, join(root, "geosite.dat"));

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);

    expect(snapshot.categories.get("youtube")).toBeNull();
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("rejects a group-writable database directory", () => {
    const root = mkdtempSync(join(tmpdir(), "submerge-geosite-writable-directory-"));
    roots.push(root);
    writeFileSync(join(root, "geosite.dat"), site("YOUTUBE", [domain(2, "youtube.example")]));
    chmodSync(root, 0o775);

    const snapshot = materializeActiveGeositeSnapshot(root, ["youtube"]);

    expect(snapshot.categories.get("youtube")).toBeNull();
    expect(snapshot.isCurrent()).toBe(false);
  });
});
