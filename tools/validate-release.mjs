#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertSafeArchivePath,
  manifestBaseVersion,
  normalizeArchivePath,
  parseCliArgs,
  parseZipEntries,
  readJson,
  readUtf8,
  readZipEntry,
  sha256,
  sourceTreeSha256,
  validateReleaseEvidence,
  versionFromTag,
} from "./release-utils.mjs";

const args = parseCliArgs(process.argv.slice(2));
const repoRoot = path.resolve(args["repo-root"] || process.cwd());
const pluginRoot = path.resolve(repoRoot, args["plugin-root"] || "plugins/freshread");
const marketplacePath = path.resolve(repoRoot, args.marketplace || ".agents/plugins/marketplace.json");
const errors = [];
const requireReleaseEvidence = args["require-release-evidence"] === true || Boolean((args.zip || args["zip-dir"]) && args["allow-unqualified"] !== true);
if (args["require-release-evidence"] === true && args["allow-unqualified"] === true) {
  throw new Error("--require-release-evidence and --allow-unqualified cannot be combined");
}
if (args["allow-unqualified"] === true && !args.zip && !args["zip-dir"]) {
  throw new Error("--allow-unqualified is only valid while checking a CI smoke ZIP");
}

const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const manifest = await capture(() => readJson(manifestPath), `Read ${manifestPath}`);
const packageMetadata = await capture(() => readJson(path.join(pluginRoot, "package.json")), "Read plugin package.json");
if (manifest) validateManifest(manifest, packageMetadata);

const marketplace = await capture(() => readJson(marketplacePath), `Read ${marketplacePath}`);
if (marketplace) validateMarketplace(marketplace);

const releaseEvidence = requireReleaseEvidence
  ? await capture(
      () => validateReleaseEvidence(pluginRoot, { marketplaceName: marketplace?.name, manifest }),
      "Validate deterministic and live benchmark evidence",
    )
  : await capture(
      async () => ({ current: await sourceTreeSha256(pluginRoot) }),
      "Compute current plugin source identity",
    );

const readmePaths = [path.join(repoRoot, "README.md"), path.join(repoRoot, "README.zh-CN.md")];
for (const readmePath of readmePaths) {
  const text = await capture(() => readUtf8(readmePath), `Read ${readmePath}`);
  if (text !== null) await validateMarkdownLinks(readmePath, text);
}
if (await exists(path.join(repoRoot, "README.md"))) {
  const english = await readUtf8(path.join(repoRoot, "README.md"));
  if (!english.includes("README.zh-CN.md")) errors.push("README.md must link to README.zh-CN.md");
}
if (await exists(path.join(repoRoot, "README.zh-CN.md"))) {
  const chinese = await readUtf8(path.join(repoRoot, "README.zh-CN.md"));
  if (!chinese.includes("README.md")) errors.push("README.zh-CN.md must link to README.md");
}
await validateLicenseParity();

for (const requiredPath of [
  "hooks/hooks.json",
  "skills/freshread/SKILL.md",
  "scripts/freshread-hook.cjs",
  "src/freshread-core.cjs",
]) {
  if (!(await exists(path.join(pluginRoot, ...requiredPath.split("/"))))) {
    errors.push(`Required plugin file is missing: ${requiredPath}`);
  }
}

let zipPath = args.zip ? path.resolve(repoRoot, args.zip) : null;
if (!zipPath && args["zip-dir"]) {
  const zipDir = path.resolve(repoRoot, args["zip-dir"]);
  const candidates = (await fs.readdir(zipDir)).filter((name) => /^freshread-v.+\.zip$/.test(name));
  if (candidates.length !== 1) {
    errors.push(`Expected exactly one FreshRead ZIP in ${zipDir}, found ${candidates.length}`);
  } else {
    zipPath = path.join(zipDir, candidates[0]);
  }
}
if (zipPath) await validateZip(zipPath, manifest, releaseEvidence, requireReleaseEvidence);

if (errors.length > 0) {
  console.error("Release validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Release validation passed for ${normalizeArchivePath(path.relative(repoRoot, pluginRoot))}`);
  if (zipPath) console.log(`Validated ZIP: ${zipPath}`);
}

async function capture(operation, label) {
  try {
    return await operation();
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}

async function validateLicenseParity() {
  const rootLicensePath = path.join(repoRoot, "LICENSE");
  const pluginLicensePath = path.join(pluginRoot, "LICENSE");
  try {
    const [rootLicense, pluginLicense] = await Promise.all([
      fs.readFile(rootLicensePath),
      fs.readFile(pluginLicensePath),
    ]);
    if (!rootLicense.equals(pluginLicense)) errors.push("Root LICENSE and plugins/freshread/LICENSE must be byte-identical");
  } catch (error) {
    errors.push(`Validate LICENSE parity: ${error.message}`);
  }
}

function validateManifest(value, packageValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("Plugin manifest must be a JSON object");
    return;
  }
  if (value.name !== "freshread") errors.push(`Plugin manifest name must be freshread, received ${value.name}`);
  try {
    if (manifestBaseVersion(value.version) !== value.version) {
      errors.push("Release plugin manifest version must not contain build metadata");
    }
    versionFromTag(`v${value.version}`);
    if (packageValue?.version !== value.version) {
      errors.push(`package.json version ${packageValue?.version ?? "<missing>"} must exactly match plugin manifest version ${value.version}`);
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (value.license !== "MIT") errors.push("Plugin manifest license must be MIT");
  if (value.skills !== "./skills/") errors.push("Plugin manifest skills must point to ./skills/");
  if (value.hooks !== undefined) errors.push("Plugin manifest must not contain the unsupported hooks field");
  if (!value.interface?.displayName || !value.interface?.shortDescription) {
    errors.push("Plugin manifest interface metadata is incomplete");
  }
}

function validateMarketplace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("Marketplace must be a JSON object");
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value.name ?? "")) errors.push("Marketplace name is missing or invalid");
  if (!value.interface?.displayName) errors.push("Marketplace interface.displayName is required");
  if (!Array.isArray(value.plugins)) {
    errors.push("Marketplace plugins must be an array");
    return;
  }
  const matches = value.plugins.filter((entry) => entry?.name === "freshread");
  if (matches.length !== 1) {
    errors.push(`Marketplace must contain exactly one freshread entry, found ${matches.length}`);
    return;
  }
  const entry = matches[0];
  if (entry.policy?.installation !== "AVAILABLE") errors.push("freshread policy.installation must be AVAILABLE");
  if (entry.policy?.authentication !== "ON_INSTALL") errors.push("freshread policy.authentication must be ON_INSTALL");
  if (typeof entry.category !== "string" || entry.category.length === 0) errors.push("freshread category is required");

  const source = entry.source;
  if (typeof source === "string") {
    validateMarketplacePath(source);
    return;
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    errors.push("freshread marketplace source must be a path or source object");
    return;
  }
  if (source.source === "local") {
    validateMarketplacePath(source.path);
  } else if (source.source === "git-subdir") {
    validateMarketplacePath(source.path);
    if (!isGitUrl(source.url)) errors.push("git-subdir source.url must be an HTTPS or SSH Git URL");
    if (!source.ref && !source.sha) errors.push("git-subdir source must pin ref or sha");
  } else {
    errors.push(`freshread source must be local or git-subdir for plugins/freshread, received ${source.source}`);
  }
}

function validateMarketplacePath(value) {
  if (value !== "./plugins/freshread") {
    errors.push(`freshread marketplace path must be ./plugins/freshread, received ${value}`);
  }
}

function isGitUrl(value) {
  return typeof value === "string" && (/^https:\/\//.test(value) || /^ssh:\/\//.test(value) || /^git@[^:]+:/.test(value));
}

async function validateMarkdownLinks(readmePath, text) {
  const destinations = [];
  const inlinePattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(inlinePattern)) destinations.push(extractDestination(match[1]));
  const definitionPattern = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of text.matchAll(definitionPattern)) destinations.push(extractDestination(match[1]));

  for (const destination of destinations.filter(Boolean)) {
    if (/^(?:https?:|mailto:|codex:|data:)/i.test(destination) || destination.startsWith("#")) continue;
    const withoutFragment = destination.split("#", 1)[0].split("?", 1)[0];
    if (!withoutFragment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      errors.push(`${readmePath} has a link with invalid URL encoding: ${destination}`);
      continue;
    }
    const target = path.resolve(path.dirname(readmePath), decoded);
    if (!target.startsWith(`${repoRoot}${path.sep}`) && target !== repoRoot) {
      errors.push(`${readmePath} link escapes the repository: ${destination}`);
    } else if (!(await exists(target))) {
      errors.push(`${readmePath} has a broken relative link: ${destination}`);
    }
  }
}

function extractDestination(raw) {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.split(/\s+/, 1)[0];
}

async function validateZip(filePath, diskManifest, evidence, evidenceRequired) {
  const zipBytes = await capture(() => fs.readFile(filePath), `Read ${filePath}`);
  if (!zipBytes) return;
  const zipName = path.basename(filePath);
  const zipNameMatch = /^freshread-(v.+)\.zip$/.exec(zipName);
  if (!zipNameMatch) {
    errors.push(`Release ZIP name must be freshread-vX.Y.Z.zip, received ${zipName}`);
  } else {
    try {
      const zipVersion = versionFromTag(zipNameMatch[1]);
      if (diskManifest && zipVersion !== diskManifest.version) {
        errors.push(`Release ZIP version ${zipVersion} differs from plugin manifest version ${diskManifest.version}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  let entries;
  try {
    entries = parseZipEntries(zipBytes);
  } catch (error) {
    errors.push(`${filePath}: ${error.message}`);
    return;
  }
  const names = new Set();
  const caseInsensitiveNames = new Map();
  for (const entry of entries) {
    try {
      assertSafeArchivePath(entry.name);
    } catch (error) {
      errors.push(error.message);
    }
    if (names.has(entry.name)) errors.push(`ZIP contains duplicate path: ${entry.name}`);
    names.add(entry.name);
    const foldedName = entry.name.toLocaleLowerCase("en-US");
    const existingCase = caseInsensitiveNames.get(foldedName);
    if (existingCase && existingCase !== entry.name) {
      errors.push(`ZIP contains a case-insensitive path collision: ${existingCase} and ${entry.name}`);
    } else {
      caseInsensitiveNames.set(foldedName, entry.name);
    }
    if (entry.name.startsWith("plugins/freshread/")) errors.push("ZIP must contain plugin files at its root, not under plugins/freshread/");
    if (entry.name.split("/").some((part) => part === ".git" || part === "node_modules")) {
      errors.push(`ZIP contains excluded path: ${entry.name}`);
    }
    try {
      readZipEntry(zipBytes, entry);
    } catch (error) {
      errors.push(`ZIP entry integrity failed for ${entry.name}: ${error.message}`);
    }
  }
  for (const required of [
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "skills/freshread/SKILL.md",
    "scripts/freshread-hook.cjs",
    "src/freshread-core.cjs",
    "package.json",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
  ]) {
    if (!names.has(required)) errors.push(`ZIP is missing required root path: ${required}`);
  }
  const manifestEntry = entries.find((entry) => entry.name === ".codex-plugin/plugin.json");
  if (manifestEntry) {
    try {
      const archived = JSON.parse(readZipEntry(zipBytes, manifestEntry).toString("utf8"));
      if (archived.name !== "freshread") errors.push("ZIP plugin manifest name is not freshread");
      if (diskManifest && archived.version !== diskManifest.version) errors.push("ZIP plugin manifest version differs from the source manifest");
    } catch (error) {
      errors.push(`Unable to validate ZIP plugin manifest: ${error.message}`);
    }
  }
  const packageEntry = entries.find((entry) => entry.name === "package.json");
  if (packageEntry && diskManifest) {
    try {
      const archivedPackage = JSON.parse(readZipEntry(zipBytes, packageEntry).toString("utf8"));
      if (archivedPackage.version !== diskManifest.version) {
        errors.push("ZIP package.json version differs from the plugin manifest version");
      }
    } catch (error) {
      errors.push(`Unable to validate ZIP package.json: ${error.message}`);
    }
  }
  for (const readmeName of ["README.md", "README.zh-CN.md"]) {
    const readmeEntry = entries.find((entry) => entry.name === readmeName);
    if (!readmeEntry) continue;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readZipEntry(zipBytes, readmeEntry));
      validateArchivedMarkdownLinks(readmeName, text, names);
    } catch (error) {
      errors.push(`Unable to validate archived ${readmeName}: ${error.message}`);
    }
  }
  if (evidenceRequired && !evidence) errors.push("ZIP validation requires current, release-eligible deterministic and live benchmark evidence");
  await validateReleaseSidecars(filePath, zipBytes, entries, evidence, zipNameMatch?.[1] ?? null, evidenceRequired);
}

async function validateReleaseSidecars(zipPath, zipBytes, entries, evidence, zipTag, evidenceRequired) {
  const directory = path.dirname(zipPath);
  const manifestPath = path.join(directory, "release-manifest.json");
  const checksumsPath = path.join(directory, "SHA256SUMS");
  const notesPath = path.join(directory, "release-notes.md");
  const releaseManifest = await capture(() => readJson(manifestPath), `Read ${manifestPath}`);
  const checksumText = await capture(() => readUtf8(checksumsPath), `Read ${checksumsPath}`);
  const notes = await capture(() => readUtf8(notesPath), `Read ${notesPath}`);
  const zipDigest = sha256(zipBytes);

  if (releaseManifest) {
    if (releaseManifest.artifact?.name !== path.basename(zipPath)) errors.push("release-manifest artifact.name does not match the ZIP filename");
    if (releaseManifest.artifact?.size !== zipBytes.length) errors.push("release-manifest artifact.size does not match the ZIP");
    if (releaseManifest.artifact?.sha256 !== zipDigest) errors.push("release-manifest artifact.sha256 does not match the ZIP");
    if (releaseManifest.artifact?.entryCount !== entries.length) errors.push("release-manifest artifact.entryCount does not match the ZIP");
    if (zipTag && releaseManifest.release?.tag !== zipTag) errors.push("release-manifest release.tag does not match the ZIP tag");
    if (evidence) {
      if (releaseManifest.sourceTree?.digest !== evidence.current.digest) errors.push("release-manifest sourceTree.digest does not match current source");
      if (releaseManifest.sourceTree?.fileCount !== evidence.current.fileCount) errors.push("release-manifest sourceTree.fileCount does not match current source");
      if (evidenceRequired && releaseManifest.qualification?.releaseEligible !== true) {
        errors.push("release-manifest must mark the final artifact releaseEligible");
      }
      if (!evidenceRequired && releaseManifest.qualification?.mode !== "ci-structure-smoke") {
        errors.push("An unqualified ZIP must be marked as a CI structure smoke artifact");
      }
      if (evidenceRequired && releaseManifest.benchmarkEvidence?.deterministic?.fileSha256 !== evidence.deterministic.fileSha256) {
        errors.push("release-manifest deterministic evidence hash does not match the checked-in report");
      }
      if (evidenceRequired && releaseManifest.benchmarkEvidence?.live?.fileSha256 !== evidence.live.fileSha256) {
        errors.push("release-manifest live evidence hash does not match the checked-in report");
      }
      if (evidenceRequired) {
        const archivedEvent = releaseManifest.benchmarkEvidence?.live?.eventArtifact;
        const currentEvent = evidence.live.eventArtifact;
        if (
          archivedEvent?.sha256 !== currentEvent.sha256 ||
          archivedEvent?.bytes !== currentEvent.bytes ||
          archivedEvent?.runId !== currentEvent.runId ||
          archivedEvent?.schemaVersion !== currentEvent.schemaVersion ||
          archivedEvent?.status !== currentEvent.status
        ) {
          errors.push("release-manifest live event artifact binding does not match checked-in evidence");
        }
      }
    }
  }

  if (checksumText !== null) {
    const sums = new Map();
    for (const line of checksumText.trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
      if (!match) {
        errors.push(`Invalid SHA256SUMS line: ${line}`);
        continue;
      }
      sums.set(match[2], match[1]);
    }
    if (sums.get(path.basename(zipPath)) !== zipDigest) errors.push("SHA256SUMS does not contain the exact ZIP digest");
    try {
      const manifestBytes = await fs.readFile(manifestPath);
      if (sums.get("release-manifest.json") !== sha256(manifestBytes)) {
        errors.push("SHA256SUMS does not contain the exact release-manifest.json digest");
      }
    } catch (error) {
      errors.push(`Read ${manifestPath} for checksum validation: ${error.message}`);
    }
    if (sums.size !== 2) errors.push(`SHA256SUMS must contain exactly two assets, found ${sums.size}`);
  }

  if (notes !== null) {
    for (const requiredText of ["codex plugin marketplace add", "Windows", "Ubuntu", "macOS", "SHA256SUMS"]) {
      if (!notes.includes(requiredText)) errors.push(`release-notes.md is missing required release guidance: ${requiredText}`);
    }
    if (evidence && !notes.includes(evidence.current.digest)) errors.push("release-notes.md does not name the qualified source digest");
  }
}

function validateArchivedMarkdownLinks(readmeName, text, archiveNames) {
  const destinations = [];
  const inlinePattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(inlinePattern)) destinations.push(extractDestination(match[1]));
  const definitionPattern = /^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of text.matchAll(definitionPattern)) destinations.push(extractDestination(match[1]));
  for (const destination of destinations.filter(Boolean)) {
    if (/^(?:https?:|mailto:|codex:|data:)/i.test(destination) || destination.startsWith("#")) continue;
    const withoutFragment = destination.split("#", 1)[0].split("?", 1)[0];
    if (!withoutFragment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      errors.push(`Archived ${readmeName} has invalid URL encoding: ${destination}`);
      continue;
    }
    const base = path.posix.dirname(readmeName);
    const target = path.posix.normalize(path.posix.join(base, decoded));
    if (target === ".." || target.startsWith("../") || path.posix.isAbsolute(target)) {
      errors.push(`Archived ${readmeName} link escapes the ZIP root: ${destination}`);
    } else if (!archiveNames.has(target)) {
      errors.push(`Archived ${readmeName} has a broken relative link: ${destination}`);
    }
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
