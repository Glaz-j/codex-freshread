import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export async function readUtf8(filePath) {
  const bytes = await fs.readFile(filePath);
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`${filePath} is not valid UTF-8: ${error.message}`);
  }
  if (text.includes("\uFFFD")) {
    throw new Error(`${filePath} contains a Unicode replacement character`);
  }
  return text;
}

export async function readJson(filePath) {
  const text = await readUtf8(filePath);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

export function normalizeArchivePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function assertSafeArchivePath(value) {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
}

export function versionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match) {
    throw new Error(`Release tag must be SemVer with a leading v (for example v0.1.0): ${tag}`);
  }
  return tag.slice(1);
}

export function manifestBaseVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Plugin manifest version must be a non-empty string");
  }
  return version.split("+", 1)[0];
}

export async function listFiles(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const ignored = options.ignored ?? (() => false);
  const entries = [];

  async function visit(directory, relativeDirectory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relativePath = normalizeArchivePath(path.join(relativeDirectory, child.name));
      if (ignored(relativePath, child)) continue;
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Release input must not contain symbolic links: ${absolutePath}`);
      }
      if (child.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (child.isFile()) {
        entries.push({ absolutePath, relativePath });
      } else {
        throw new Error(`Unsupported release input type: ${absolutePath}`);
      }
    }
  }

  await visit(root, "");
  return entries;
}

export async function sourceTreeSha256(pluginRoot) {
  const root = path.resolve(pluginRoot);
  const files = [];

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative === ".git" ||
        relative.startsWith(".git/") ||
        relative === "node_modules" ||
        relative.startsWith("node_modules/") ||
        relative === "benchmarks/results" ||
        relative.startsWith("benchmarks/results/")
      ) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
      else throw new Error(`Source tree contains an unsupported filesystem entry: ${relative}`);
    }
  }

  await visit(root);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  const digest = createHash("sha256");
  for (const file of files) {
    const contents = await fs.readFile(file.absolute);
    digest.update(file.relative);
    digest.update("\0");
    digest.update(String(contents.length));
    digest.update("\0");
    digest.update(contents);
    digest.update("\0");
  }
  return {
    algorithm: "SHA-256",
    digest: digest.digest("hex"),
    fileCount: files.length,
    excludes: ["node_modules/**", ".git/**", "benchmarks/results/**"],
  };
}

export async function validateReleaseEvidence(pluginRoot, options = {}) {
  const root = path.resolve(pluginRoot);
  const current = await sourceTreeSha256(root);
  const deterministicPath = path.join(root, "benchmarks", "results", "latest.json");
  const livePath = path.join(root, "benchmarks", "results", "live-latest.json");
  const liveEventsPath = path.join(root, "benchmarks", "results", "live-latest.events.json");
  const deterministicBytes = await fs.readFile(deterministicPath);
  const liveBytes = await fs.readFile(livePath);
  const liveEventsBytes = await fs.readFile(liveEventsPath);
  const deterministic = await readJson(deterministicPath);
  const live = await readJson(livePath);
  const liveEvents = await readJson(liveEventsPath);
  const violations = [];

  requireSourceMatch("Deterministic benchmark", deterministic.sourceTree, current, violations);
  if (deterministic.launchGate?.passed !== true) {
    violations.push("Deterministic benchmark launchGate.passed must be true");
  }
  if (deterministic.launchGate?.deterministicEligible !== true) {
    violations.push("Deterministic benchmark launchGate.deterministicEligible must be true");
  }

  requireSourceMatch("Live benchmark", live.sourceTree, current, violations);
  if (live.status !== "PASS") violations.push(`Live benchmark status must be PASS, received ${live.status}`);
  if (live.passed !== true) violations.push("Live benchmark passed must be true");
  if (live.liveEligible !== true) violations.push("Live benchmark liveEligible must be true");
  if (live.releaseEligible !== true) violations.push("Live benchmark releaseEligible must be true");

  const expectedMarketplace = options.marketplaceName;
  const expectedManifest = options.manifest;
  if (!expectedMarketplace) violations.push("Expected release marketplace name is required");
  if (!expectedManifest?.name || !expectedManifest?.version) violations.push("Expected plugin manifest identity is required");
  if (expectedMarketplace && live.installedPlugin?.marketplace !== expectedMarketplace) {
    violations.push(`Live benchmark installed marketplace ${live.installedPlugin?.marketplace ?? "<missing>"} does not match ${expectedMarketplace}`);
  }
  if (expectedManifest?.name && live.installedPlugin?.plugin !== expectedManifest.name) {
    violations.push(`Live benchmark installed plugin ${live.installedPlugin?.plugin ?? "<missing>"} does not match ${expectedManifest.name}`);
  }
  if (expectedManifest?.version && live.installedPlugin?.version !== expectedManifest.version) {
    violations.push(`Live benchmark installed version ${live.installedPlugin?.version ?? "<missing>"} does not match ${expectedManifest.version}`);
  }
  if (live.installedPlugin?.matchesSource !== true) violations.push("Live benchmark installedPlugin.matchesSource must be true");
  if (live.installedPlugin?.hookContractValid !== true) violations.push("Live benchmark installedPlugin.hookContractValid must be true");
  if (live.eventArtifact?.name !== "live-latest.events.json") violations.push("Live benchmark eventArtifact.name must be live-latest.events.json");
  if (live.eventArtifact?.bytes !== liveEventsBytes.length) violations.push("Live benchmark eventArtifact.bytes does not match live-latest.events.json");
  if (live.eventArtifact?.sha256 !== sha256(liveEventsBytes)) violations.push("Live benchmark eventArtifact.sha256 does not match live-latest.events.json");
  if (!live.runId || live.eventArtifact?.runId !== live.runId || liveEvents.runId !== live.runId) {
    violations.push("Live benchmark runId does not bind the report and event artifact");
  }
  if (!Number.isInteger(live.schemaVersion) || liveEvents.schemaVersion !== live.schemaVersion) {
    violations.push("Live report and event artifact schemaVersion must be the same integer");
  }
  if (liveEvents.status !== live.status || liveEvents.status !== "PASS") {
    violations.push(`Live event artifact status must match report status PASS, received ${liveEvents.status}`);
  }

  if (
    deterministic.sourceTree?.digest !== live.sourceTree?.digest ||
    deterministic.sourceTree?.fileCount !== live.sourceTree?.fileCount
  ) {
    violations.push("Deterministic and live benchmark source identities do not match");
  }

  if (violations.length > 0) {
    throw new Error(`Release evidence is stale or ineligible:\n- ${violations.join("\n- ")}`);
  }

  return {
    current,
    deterministic: {
      path: "benchmarks/results/latest.json",
      generatedAt: deterministic.generatedAt ?? null,
      sourceDigest: deterministic.sourceTree.digest,
      fileCount: deterministic.sourceTree.fileCount,
      fileSha256: sha256(deterministicBytes),
      passed: true,
      deterministicEligible: true,
    },
    live: {
      path: "benchmarks/results/live-latest.json",
      generatedAt: live.generatedAt ?? null,
      sourceDigest: live.sourceTree.digest,
      fileCount: live.sourceTree.fileCount,
      fileSha256: sha256(liveBytes),
      status: live.status,
      passed: true,
      liveEligible: true,
      releaseEligible: true,
      installedPlugin: {
        marketplace: live.installedPlugin.marketplace,
        plugin: live.installedPlugin.plugin,
        version: live.installedPlugin.version,
        matchesSource: true,
        hookContractValid: true,
      },
      eventArtifact: {
        path: "benchmarks/results/live-latest.events.json",
        runId: live.runId,
        schemaVersion: liveEvents.schemaVersion,
        status: liveEvents.status,
        bytes: liveEventsBytes.length,
        sha256: sha256(liveEventsBytes),
      },
    },
    matchingSourceDigest: true,
  };
}

function requireSourceMatch(label, reported, current, violations) {
  if (reported?.digest !== current.digest) {
    violations.push(`${label} source digest ${reported?.digest ?? "<missing>"} does not match current ${current.digest}`);
  }
  if (reported?.fileCount !== current.fileCount) {
    violations.push(`${label} fileCount ${reported?.fileCount ?? "<missing>"} does not match current ${current.fileCount}`);
  }
}

export function resolveGitCommit(repoRoot, preferred) {
  if (preferred) return preferred;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function resolveSourceEpoch(repoRoot, commit) {
  if (/^\d+$/.test(process.env.SOURCE_DATE_EPOCH ?? "")) {
    return Number(process.env.SOURCE_DATE_EPOCH);
  }
  if (commit) {
    try {
      const output = execFileSync("git", ["show", "-s", "--format=%ct", commit], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (/^\d+$/.test(output)) return Number(output);
    } catch {
      // Fall through to a current-time timestamp for non-Git local packaging.
    }
  }
  return Math.floor(Date.now() / 1000);
}

export function parseZipEntries(zipBytes) {
  if (!Buffer.isBuffer(zipBytes) || zipBytes.length < 22) throw new Error("ZIP is too small to contain an end record");
  const endSignature = 0x06054b50;
  const minimumEndOffset = Math.max(0, zipBytes.length - 65_557);
  let endOffset = -1;
  for (let offset = zipBytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record not found");

  const diskNumber = zipBytes.readUInt16LE(endOffset + 4);
  const centralDisk = zipBytes.readUInt16LE(endOffset + 6);
  const diskEntries = zipBytes.readUInt16LE(endOffset + 8);
  const totalEntries = zipBytes.readUInt16LE(endOffset + 10);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  const commentLength = zipBytes.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Multi-disk and ZIP64 archives are not supported");
  }
  if (endOffset + 22 + commentLength !== zipBytes.length) throw new Error("ZIP end-record comment length is invalid");
  if (centralOffset + centralSize > endOffset) {
    throw new Error("ZIP central directory points outside the archive");
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > centralOffset + centralSize || offset + 46 > zipBytes.length) {
      throw new Error(`Truncated ZIP central-directory record at offset ${offset}`);
    }
    if (zipBytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central-directory record at offset ${offset}`);
    }
    const flags = zipBytes.readUInt16LE(offset + 8);
    const method = zipBytes.readUInt16LE(offset + 10);
    const crc = zipBytes.readUInt32LE(offset + 16);
    const compressedSize = zipBytes.readUInt32LE(offset + 20);
    const uncompressedSize = zipBytes.readUInt32LE(offset + 24);
    const nameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const localOffset = zipBytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const recordEnd = nameStart + nameLength + extraLength + commentLength;
    if (recordEnd > centralOffset + centralSize || recordEnd > zipBytes.length) {
      throw new Error(`ZIP central-directory record exceeds its declared boundary at offset ${offset}`);
    }
    const name = zipBytes.subarray(nameStart, nameStart + nameLength).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    entries.push({ name, flags, method, crc32: crc, compressedSize, uncompressedSize, localOffset });
    offset = recordEnd;
  }
  if (offset !== centralOffset + centralSize) throw new Error("ZIP central-directory size does not match its records");
  return entries;
}

export function readZipEntry(zipBytes, entry) {
  const offset = entry.localOffset;
  if (offset < 0 || offset + 30 > zipBytes.length) throw new Error(`ZIP local-file record is out of bounds for ${entry.name}`);
  if (zipBytes.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local-file record for ${entry.name}`);
  }
  const flags = zipBytes.readUInt16LE(offset + 6);
  const method = zipBytes.readUInt16LE(offset + 8);
  const crc = zipBytes.readUInt32LE(offset + 14);
  const compressedSize = zipBytes.readUInt32LE(offset + 18);
  const uncompressedSize = zipBytes.readUInt32LE(offset + 22);
  const nameLength = zipBytes.readUInt16LE(offset + 26);
  const extraLength = zipBytes.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  if (nameStart + nameLength + extraLength > zipBytes.length) throw new Error(`ZIP local header is truncated for ${entry.name}`);
  const localName = zipBytes.subarray(nameStart, nameStart + nameLength).toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
  if (localName !== entry.name) throw new Error(`ZIP local and central filenames differ for ${entry.name}`);
  if (flags !== entry.flags || method !== entry.method) throw new Error(`ZIP local and central flags/method differ for ${entry.name}`);
  if (crc !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw new Error(`ZIP local and central integrity metadata differ for ${entry.name}`);
  }
  const dataStart = offset + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > zipBytes.length) throw new Error(`ZIP entry data is truncated for ${entry.name}`);
  const compressed = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);
  let data;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8) data = inflateRawSync(compressed);
  else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.uncompressedSize) throw new Error(`ZIP uncompressed size differs for ${entry.name}`);
  if (crc32(data) !== entry.crc32) throw new Error(`ZIP CRC-32 differs for ${entry.name}`);
  return data;
}
