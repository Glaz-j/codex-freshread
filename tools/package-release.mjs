#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeArchivePath,
  crc32,
  listFiles,
  manifestBaseVersion,
  normalizeArchivePath,
  parseCliArgs,
  readJson,
  resolveGitCommit,
  resolveSourceEpoch,
  sha256,
  sourceTreeSha256,
  validateReleaseEvidence,
  versionFromTag,
} from "./release-utils.mjs";

const args = parseCliArgs(process.argv.slice(2));
const repoRoot = path.resolve(args["repo-root"] || process.cwd());
const pluginRoot = path.resolve(repoRoot, args["plugin-root"] || "plugins/freshread");
const outDir = path.resolve(repoRoot, args["out-dir"] || "dist");
const marketplacePath = path.resolve(repoRoot, args.marketplace || ".agents/plugins/marketplace.json");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = await readJson(manifestPath);
const packageMetadata = await readJson(path.join(pluginRoot, "package.json"));
const marketplaceConfig = await readJson(marketplacePath);
const smokeMode = args.smoke === true;
if (smokeMode && args.tag) throw new Error("--smoke cannot be combined with an explicit --tag");
const evidence = smokeMode
  ? await collectSmokeEvidence(pluginRoot)
  : await validateReleaseEvidence(pluginRoot, { marketplaceName: marketplaceConfig.name, manifest });
const baseVersion = manifestBaseVersion(manifest.version);
if (baseVersion !== manifest.version) {
  throw new Error("Release plugin manifest version must not contain build metadata");
}
const tag = args.tag || `v${manifest.version}`;
const releaseVersion = versionFromTag(tag);

if (packageMetadata.version !== manifest.version) {
  throw new Error(`package.json version ${packageMetadata.version} does not exactly match plugin manifest version ${manifest.version}`);
}
if (releaseVersion !== manifest.version) {
  throw new Error(`Tag ${tag} does not exactly match plugin manifest version ${manifest.version}`);
}
if (manifest.name !== "freshread") {
  throw new Error(`Expected plugin name freshread, received ${manifest.name}`);
}

const requiredRuntimePaths = [
  ".codex-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/freshread/SKILL.md",
  "scripts/freshread-hook.cjs",
  "src/freshread-core.cjs",
];
for (const relativePath of requiredRuntimePaths) {
  await fs.access(path.join(pluginRoot, ...relativePath.split("/")));
}

const ignoredParts = new Set([".git", "node_modules", ".cache", "coverage", "dist"]);
function ignored(relativePath) {
  const parts = relativePath.split("/");
  if (parts.some((part) => ignoredParts.has(part))) return true;
  const name = parts[parts.length - 1];
  return name === ".DS_Store" || name === "Thumbs.db" || name.endsWith(".log") || name === ".env" || name.startsWith(".env.");
}

const inputFiles = await listFiles(pluginRoot, { ignored });
const archiveEntries = new Map();
for (const file of inputFiles) {
  const archivePath = normalizeArchivePath(file.relativePath);
  assertSafeArchivePath(archivePath);
  const data = await fs.readFile(file.absolutePath);
  archiveEntries.set(archivePath, {
    name: archivePath,
    data,
    mode: canonicalArchiveMode(archivePath, data),
  });
}

for (const docName of [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
]) {
  const sourcePath = path.join(repoRoot, docName);
  await fs.access(sourcePath);
  const data = await fs.readFile(sourcePath);
  const existing = archiveEntries.get(docName);
  if (existing && !existing.data.equals(data)) {
    throw new Error(`${docName} differs between the repository root and plugin root`);
  }
  const archiveData = docName.startsWith("README") ? rewriteReadmeForArchive(data, tag) : data;
  archiveEntries.set(docName, {
    name: docName,
    data: archiveData,
    mode: canonicalArchiveMode(docName, archiveData),
  });
}

const sortedEntries = [...archiveEntries.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
const commit = resolveGitCommit(repoRoot, args.commit || process.env.GITHUB_SHA);
const sourceEpoch = resolveSourceEpoch(repoRoot, commit);
const zipBytes = createZip(sortedEntries, new Date(sourceEpoch * 1000));
const evidenceAfterPackaging = smokeMode
  ? await collectSmokeEvidence(pluginRoot)
  : await validateReleaseEvidence(pluginRoot, { marketplaceName: marketplaceConfig.name, manifest });
const sourceAfterPackaging = evidenceAfterPackaging.current;
if (
  sourceAfterPackaging.digest !== evidence.current.digest ||
  sourceAfterPackaging.fileCount !== evidence.current.fileCount ||
  evidenceAfterPackaging.deterministic.fileSha256 !== evidence.deterministic.fileSha256 ||
  evidenceAfterPackaging.live.fileSha256 !== evidence.live.fileSha256
) {
  throw new Error("Plugin source changed while release assets were being assembled; retry from a stable checkout");
}

await fs.mkdir(outDir, { recursive: true });
const zipName = `freshread-${tag}.zip`;
const zipPath = path.join(outDir, zipName);
await fs.writeFile(zipPath, zipBytes);

const sourceFiles = sortedEntries.map((entry) => ({
  path: entry.name,
  size: entry.data.length,
  sha256: sha256(entry.data),
}));
const marketplace = await optionalFileEvidence(marketplacePath, repoRoot);
const zipDigest = sha256(zipBytes);
const releaseManifest = {
  schemaVersion: 1,
  project: "FreshRead",
  release: {
    tag,
    version: releaseVersion,
    pluginManifestVersion: manifest.version,
    packageVersion: packageMetadata.version,
    commit,
    generatedAt: new Date(sourceEpoch * 1000).toISOString(),
  },
  artifact: {
    name: zipName,
    size: zipBytes.length,
    sha256: zipDigest,
    rootLayout: "plugin-files-at-archive-root",
    entryCount: sourceFiles.length,
  },
  sourceTree: evidence.current,
  qualification: {
    mode: smokeMode ? "ci-structure-smoke" : "release",
    releaseEligible: !smokeMode,
  },
  marketplace,
  benchmarkEvidence: {
    deterministic: evidence.deterministic,
    live: evidence.live,
    matchingSourceDigest: evidence.matchingSourceDigest,
  },
  files: sourceFiles,
};

const releaseManifestName = "release-manifest.json";
const releaseManifestPath = path.join(outDir, releaseManifestName);
const releaseManifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
await fs.writeFile(releaseManifestPath, releaseManifestBytes);

const checksumLines = [
  `${zipDigest}  ${zipName}`,
  `${sha256(releaseManifestBytes)}  ${releaseManifestName}`,
];
const checksumsPath = path.join(outDir, "SHA256SUMS");
await fs.writeFile(checksumsPath, `${checksumLines.join("\n")}\n`, "utf8");

const releaseNotesPath = path.join(outDir, "release-notes.md");
const releaseNotes = renderReleaseNotes({
  tag,
  sourceDigest: evidence.current.digest,
  zipName,
  qualified: !smokeMode,
});
await fs.writeFile(releaseNotesPath, releaseNotes, "utf8");

console.log(JSON.stringify({
  tag,
  version: releaseVersion,
  zip: zipPath,
  checksums: checksumsPath,
  manifest: releaseManifestPath,
  notes: releaseNotesPath,
  sha256: zipDigest,
  entries: sourceFiles.length,
}, null, 2));

async function optionalFileEvidence(filePath, rootPath) {
  try {
    const data = await fs.readFile(filePath);
    return {
      path: normalizeArchivePath(path.relative(rootPath, filePath)),
      sha256: sha256(data),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function collectSmokeEvidence(rootPath) {
  const current = await sourceTreeSha256(rootPath);
  const deterministic = await inspectReport(path.join(rootPath, "benchmarks", "results", "latest.json"), "deterministic");
  const live = await inspectReport(path.join(rootPath, "benchmarks", "results", "live-latest.json"), "live");
  return {
    current,
    deterministic,
    live,
    matchingSourceDigest: Boolean(
      deterministic.sourceDigest &&
      deterministic.sourceDigest === live.sourceDigest &&
      deterministic.fileCount === live.fileCount
    ),
  };
}

async function inspectReport(filePath, kind) {
  const bytes = await fs.readFile(filePath);
  const report = await readJson(filePath);
  if (kind === "deterministic") {
    return {
      path: "benchmarks/results/latest.json",
      generatedAt: report.generatedAt ?? null,
      sourceDigest: report.sourceTree?.digest ?? null,
      fileCount: report.sourceTree?.fileCount ?? null,
      fileSha256: sha256(bytes),
      passed: report.launchGate?.passed ?? null,
      deterministicEligible: report.launchGate?.deterministicEligible ?? null,
    };
  }
  return {
    path: "benchmarks/results/live-latest.json",
    generatedAt: report.generatedAt ?? null,
    sourceDigest: report.sourceTree?.digest ?? null,
    fileCount: report.sourceTree?.fileCount ?? null,
    fileSha256: sha256(bytes),
    status: report.status ?? null,
    passed: report.passed ?? null,
    liveEligible: report.liveEligible ?? null,
    releaseEligible: report.releaseEligible ?? null,
    installedPlugin: report.installedPlugin ?? null,
  };
}

function renderReleaseNotes({ tag: releaseTag, sourceDigest, zipName: releaseZip, qualified }) {
  const qualification = qualified
    ? `- The checked-in deterministic benchmark and Windows live Codex lifecycle A/B both qualify source digest \`${sourceDigest}\`.`
    : `- This is a CI packaging smoke artifact for source digest \`${sourceDigest}\`; it is not release-qualified and must not be published.`;
  return `# FreshRead ${releaseTag}

FreshRead guards supported Codex edits when remembered file content is no longer current.

## Install from the Git-backed marketplace

\`\`\`console
codex plugin marketplace add Glaz-j/codex-freshread --ref ${releaseTag}
codex plugin add freshread@freshread
\`\`\`

Start a new Codex CLI session, open \`/hooks\`, review and trust the six FreshRead hook definitions, then start a new thread.

## Qualification boundary

${qualification}
- Windows carries the current end-to-end live Hook qualification claim.
- Ubuntu carries cross-platform syntax/tests plus the deterministic benchmark in CI, but not the live Codex lifecycle A/B claim.
- macOS carries Node 20 syntax/tests in CI, but not the deterministic or live Codex lifecycle A/B qualification claim.

## Verify release assets

Download \`${releaseZip}\`, \`SHA256SUMS\`, and \`release-manifest.json\` into one directory, then verify:

\`\`\`console
sha256sum -c SHA256SUMS
\`\`\`

On PowerShell, run \`Get-FileHash -Algorithm SHA256 ${releaseZip}, release-manifest.json\` and compare both values with \`SHA256SUMS\`. The machine-readable manifest binds the ZIP, source digest, exact benchmark evidence, tag, and commit.
`;
}

function createZip(entries, timestamp) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  const { dosDate, dosTime } = toDosDateTime(timestamp);

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | (entry.mode || 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }

  if (entries.length > 0xffff) throw new Error("ZIP64 is not supported: too many release files");
  const centralSize = centralRecords.reduce((total, buffer) => total + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

function canonicalArchiveMode(archivePath, data) {
  return archivePath.endsWith(".sh") || (data.length >= 2 && data[0] === 0x23 && data[1] === 0x21)
    ? 0o755
    : 0o644;
}

function rewriteReadmeForArchive(data, releaseTag) {
  const repositoryBase = `https://github.com/Glaz-j/codex-freshread/blob/${releaseTag}/plugins/freshread/`;
  const text = data.toString("utf8");
  return Buffer.from(text.replace(/(\]\()plugins\/freshread\//g, `$1${repositoryBase}`), "utf8");
}

function toDosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  };
}
