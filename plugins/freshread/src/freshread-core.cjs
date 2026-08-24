"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const STATES = Object.freeze({
  UNKNOWN: "UNKNOWN",
  FRESH: "FRESH",
  STALE_SELF: "STALE_SELF",
  STALE_EXTERNAL: "STALE_EXTERNAL",
  MISSING: "MISSING",
});

const STATE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MIN_STALE_LOCK_MS = 1000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTEGER_STRING_PATTERN = /^\d+$/;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function pathKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function finitePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function canonicalPath(cwd, filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function recordIdentityPath(record) {
  if (!isObject(record)) return null;
  return record.identityPath ||
    (record.snapshot && record.snapshot.metadata && record.snapshot.metadata.realPath) ||
    (record.observation && record.observation.metadata && record.observation.metadata.realPath) ||
    record.path ||
    null;
}

function displayPath(cwd, filePath) {
  const relative = path.relative(cwd, filePath);
  const raw = isWithin(cwd, filePath) && relative ? relative : filePath;
  return raw.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "?");
}

function modelSafeFragment(value, maxLength = 2000) {
  return String(value == null ? "" : value)
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "?")
    .slice(0, maxLength);
}

function bigintString(value, fallbackMs) {
  if (typeof value === "bigint") return value.toString();
  return String(Math.round(Number(fallbackMs || 0) * 1_000_000));
}

function metadataFromStat(stat, realPath) {
  return {
    realPath,
    size: Number(stat.size),
    mtimeNs: bigintString(stat.mtimeNs, stat.mtimeMs),
    ctimeNs: bigintString(stat.ctimeNs, stat.ctimeMs),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

function sameMetadata(a, b) {
  return Boolean(
    a && b &&
    pathKey(a.realPath) === pathKey(b.realPath) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function sameFileIdentity(entry, metadata) {
  if (!entry || !metadata) return false;
  const dev = String(entry.dev);
  const ino = String(entry.ino);
  if (ino === "0") return false;
  return dev === String(metadata.dev) && ino === String(metadata.ino);
}

function changedAtFromMetadata(metadata) {
  if (!metadata || !metadata.mtimeNs) return null;
  const milliseconds = Number(BigInt(metadata.mtimeNs) / 1_000_000n);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function summarize(files) {
  const summary = {
    tracked: files.length,
    UNKNOWN: 0,
    FRESH: 0,
    STALE_SELF: 0,
    STALE_EXTERNAL: 0,
    MISSING: 0,
  };
  for (const file of files) {
    if (Object.hasOwn(summary, file.state)) summary[file.state] += 1;
  }
  return summary;
}

class FreshReadEngine {
  constructor(options = {}) {
    if (!options.cwd) throw new Error("FreshReadEngine requires cwd");
    if (!options.dataDir) throw new Error("FreshReadEngine requires dataDir");
    if (!options.sessionId) throw new Error("FreshReadEngine requires sessionId");
    this.cwd = path.resolve(options.cwd);
    this.dataDir = path.resolve(options.dataDir);
    this.sessionId = String(options.sessionId);
    this.enabled = options.enabled !== false;
    this.allowOutsideWorkspace = options.allowOutsideWorkspace === true;
    this.maxFileBytes = finitePositive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.lockTimeoutMs = finitePositive(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = Math.max(
      finitePositive(options.staleLockMs, DEFAULT_STALE_LOCK_MS),
      this.lockTimeoutMs * 2,
      MIN_STALE_LOCK_MS
    );
    this.clock = typeof options.now === "function" ? options.now : Date.now;
    const sessionKey = sha256Text(`${this.sessionId}\u0000${pathKey(this.cwd)}`).slice(0, 32);
    this.sessionDir = path.join(this.dataDir, "sessions");
    this.statePath = path.join(this.sessionDir, `${sessionKey}.json`);
    this.lockPath = `${this.statePath}.lock`;
    this.lockToken = null;
    this.metrics = {
      statCalls: 0,
      hashCalls: 0,
      bytesHashed: 0,
      stateReads: 0,
      stateWrites: 0,
      lockRetries: 0,
    };
  }

  _emptyState() {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      sessionId: this.sessionId,
      cwd: this.cwd,
      createdAt: nowIso(this.clock()),
      updatedAt: nowIso(this.clock()),
      files: {},
    };
  }

  _validateStoredPath(value, label) {
    if (typeof value !== "string" || !value || !path.isAbsolute(value)) return `${label} is not an absolute path`;
    const normalized = path.normalize(value);
    if (!this.allowOutsideWorkspace && !isWithin(this.cwd, normalized)) return `${label} is outside the workspace scope`;
    return null;
  }

  _validateMetadata(value, label) {
    if (!isObject(value)) return `${label} is not an object`;
    const pathError = this._validateStoredPath(value.realPath, `${label}.realPath`);
    if (pathError) return pathError;
    if (!Number.isSafeInteger(value.size) || value.size < 0) return `${label}.size is invalid`;
    for (const field of ["mtimeNs", "ctimeNs", "dev", "ino"]) {
      if (typeof value[field] !== "string" || !INTEGER_STRING_PATTERN.test(value[field])) {
        return `${label}.${field} is invalid`;
      }
    }
    return null;
  }

  _validateSnapshot(value, label) {
    if (!isObject(value)) return `${label} is not an object`;
    if (typeof value.hash !== "string" || !SHA256_PATTERN.test(value.hash)) return `${label}.hash is invalid`;
    const metadataError = this._validateMetadata(value.metadata, `${label}.metadata`);
    if (metadataError) return metadataError;
    if (!isTimestamp(value.readAt)) return `${label}.readAt is invalid`;
    if (!isNullableString(value.toolName)) return `${label}.toolName is invalid`;
    if (!isNullableString(value.toolUseId)) return `${label}.toolUseId is invalid`;
    return null;
  }

  _validateObservation(value, label) {
    if (!isObject(value)) return `${label} is not an object`;
    if (!isTimestamp(value.checkedAt)) return `${label}.checkedAt is invalid`;
    if (value.missing === true) {
      if (value.hash !== undefined || value.metadata !== undefined) return `${label} mixes missing and file identity`;
      return null;
    }
    if (typeof value.hash !== "string" || !SHA256_PATTERN.test(value.hash)) return `${label}.hash is invalid`;
    return this._validateMetadata(value.metadata, `${label}.metadata`);
  }

  _validateLastSelf(value, label) {
    if (value === null) return null;
    if (!isObject(value)) return `${label} is not an object or null`;
    if (!isTimestamp(value.at)) return `${label}.at is invalid`;
    if (!isNullableString(value.toolUseId)) return `${label}.toolUseId is invalid`;
    if (value.missing === true) {
      if (value.hash !== undefined) return `${label} mixes missing and file identity`;
      return null;
    }
    if (typeof value.hash !== "string" || !SHA256_PATTERN.test(value.hash)) return `${label}.hash is invalid`;
    return null;
  }

  _validateRecord(value, label) {
    if (!isObject(value)) return `${label} is not an object`;
    const pathError = this._validateStoredPath(value.path, `${label}.path`);
    if (pathError) return pathError;
    if (typeof value.displayPath !== "string") return `${label}.displayPath is invalid`;
    const snapshotError = this._validateSnapshot(value.snapshot, `${label}.snapshot`);
    if (snapshotError) return snapshotError;
    const observationError = this._validateObservation(value.observation, `${label}.observation`);
    if (observationError) return observationError;
    const lastSelfError = this._validateLastSelf(value.lastSelf, `${label}.lastSelf`);
    if (lastSelfError) return lastSelfError;
    if (typeof value.externalSinceRead !== "boolean") return `${label}.externalSinceRead is invalid`;
    if (value.identityPath !== undefined) {
      const identityError = this._validateStoredPath(value.identityPath, `${label}.identityPath`);
      if (identityError) return identityError;
      if (pathKey(value.identityPath) !== pathKey(value.snapshot.metadata.realPath)) {
        return `${label}.identityPath does not match its snapshot identity`;
      }
    }
    return null;
  }

  _validateState(value) {
    if (!isObject(value)) return "state is not an object";
    if (value.schemaVersion !== STATE_SCHEMA_VERSION) return "unsupported state schema";
    if (value.sessionId !== this.sessionId) return "state belongs to another session";
    if (typeof value.cwd !== "string" || !value.cwd || !path.isAbsolute(value.cwd) ||
        pathKey(path.resolve(value.cwd)) !== pathKey(this.cwd)) {
      return "state belongs to another workspace";
    }
    if (!isTimestamp(value.createdAt)) return "state createdAt is invalid";
    if (!isTimestamp(value.updatedAt)) return "state updatedAt is invalid";
    if (!isObject(value.files)) return "state files map is invalid";
    for (const [key, record] of Object.entries(value.files)) {
      if (!path.isAbsolute(key)) return `state file key is invalid: ${key}`;
      const recordError = this._validateRecord(record, `state.files[${JSON.stringify(key)}]`);
      if (recordError) return recordError;
    }
    return null;
  }

  _normalizeStateIdentities(state) {
    const normalized = Object.create(null);
    let changed = false;
    for (const [storedKey, record] of Object.entries(state.files)) {
      const identityPath = path.normalize(recordIdentityPath(record));
      if (record.identityPath !== identityPath) {
        record.identityPath = identityPath;
        changed = true;
      }
      const identityKey = pathKey(identityPath);
      if (storedKey !== identityKey) changed = true;
      const existing = normalized[identityKey];
      if (!existing) {
        normalized[identityKey] = record;
        continue;
      }
      changed = true;
      const existingReadAt = Date.parse(existing.snapshot.readAt);
      const candidateReadAt = Date.parse(record.snapshot.readAt);
      if (candidateReadAt > existingReadAt ||
          (candidateReadAt === existingReadAt && record.externalSinceRead && !existing.externalSinceRead)) {
        normalized[identityKey] = record;
      }
    }
    if (changed) state.files = normalized;
    return changed;
  }

  _findRecord(state, filePath, resolution = null) {
    const canonical = canonicalPath(this.cwd, filePath);
    if (!canonical) return { canonical: null, identityPath: null, key: null, record: null };
    const canonicalKey = pathKey(canonical);
    const entries = Object.entries(state.files);
    if (state.files[canonicalKey]) {
      return {
        canonical,
        identityPath: recordIdentityPath(state.files[canonicalKey]),
        key: canonicalKey,
        record: state.files[canonicalKey],
      };
    }
    for (const [key, record] of entries) {
      if (pathKey(recordIdentityPath(record)) === canonicalKey) {
        return { canonical, identityPath: recordIdentityPath(record), key, record };
      }
    }
    for (const [key, record] of entries) {
      if (pathKey(record.path) === canonicalKey) {
        return { canonical, identityPath: recordIdentityPath(record), key, record };
      }
    }
    if (entries.length === 0) {
      return { canonical, identityPath: null, key: null, record: null };
    }
    const resolved = resolution || this._resolvePath(filePath);
    const identityPath = resolved && resolved.realPath;
    if (identityPath) {
      const identityKey = pathKey(identityPath);
      if (state.files[identityKey]) {
        return { canonical, identityPath, key: identityKey, record: state.files[identityKey] };
      }
      for (const [key, record] of entries) {
        if (pathKey(recordIdentityPath(record)) === identityKey) {
          return { canonical, identityPath, key, record };
        }
      }
      for (const [key, record] of entries) {
        // A normal file's lexical path and remembered identity are identical, so
        // resolving it again cannot reveal an alias retarget. Restrict this
        // fallback to records that were actually reached through an alias. This
        // preserves retarget detection without making N ordinary reads O(N^2).
        if (pathKey(record.path) === pathKey(recordIdentityPath(record))) continue;
        const recordResolution = this._resolvePath(record.path);
        if (recordResolution.realPath && pathKey(recordResolution.realPath) === identityKey) {
          return { canonical, identityPath, key, record };
        }
      }
    }
    return { canonical, identityPath: identityPath || null, key: null, record: null };
  }

  _recordMatchesFileIdentity(record, resolution, currentResolution = null) {
    if (!record || !resolution || resolution.kind !== "file") return false;
    if (this._recordCurrentMatchesFileIdentity(resolution, currentResolution)) return true;
    return Boolean(
      record.snapshot && sameFileIdentity(resolution.entry, record.snapshot.metadata) ||
      record.observation && sameFileIdentity(resolution.entry, record.observation.metadata)
    );
  }

  _recordCurrentMatchesFileIdentity(resolution, currentResolution) {
    return Boolean(
      resolution && resolution.kind === "file" &&
      currentResolution && currentResolution.kind === "file" &&
      sameFileIdentity(resolution.entry, metadataFromStat(currentResolution.entry, currentResolution.realPath))
    );
  }

  _readState() {
    this.metrics.stateReads += 1;
    if (!fs.existsSync(this.statePath)) return { state: this._emptyState(), corrupt: false, detail: null, migrated: false };
    try {
      const entry = fs.lstatSync(this.statePath);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("state path is not a regular file");
      if (entry.size > MAX_STATE_BYTES) throw new Error("state file exceeds 16 MiB safety limit");
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      const validation = this._validateState(parsed);
      if (validation) throw new Error(validation);
      const migrated = this._normalizeStateIdentities(parsed);
      return { state: parsed, corrupt: false, detail: null, migrated };
    } catch (error) {
      return {
        state: this._emptyState(),
        corrupt: true,
        detail: `FreshRead state is corrupt or unreadable: ${error.message}`,
        migrated: false,
      };
    }
  }

  _writeState(state) {
    state.updatedAt = nowIso(this.clock());
    const validation = this._validateState(state);
    if (validation) throw new Error(`refusing to write invalid FreshRead state: ${validation}`);
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new Error("FreshRead state exceeds 16 MiB safety limit");
    }
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.statePath) && fs.lstatSync(this.statePath).isSymbolicLink()) {
      throw new Error("refusing to replace a symlinked FreshRead state file");
    }
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = fs.openSync(tempPath, "wx", 0o600);
      try {
        fs.writeFileSync(handle, serialized, "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      try {
        fs.renameSync(tempPath, this.statePath);
      } catch (error) {
        if (process.platform !== "win32" || !["EEXIST", "EPERM", "EACCES"].includes(error.code)) throw error;
        fs.copyFileSync(tempPath, this.statePath);
        fs.unlinkSync(tempPath);
      }
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
    this.metrics.stateWrites += 1;
  }

  _lockOwnerPath(token) {
    return path.join(this.lockPath, `owner-${token}.json`);
  }

  _tryReclaimStaleLock() {
    let lockStat;
    try {
      lockStat = fs.lstatSync(this.lockPath);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (["EPERM", "EACCES"].includes(error.code)) return false;
      throw error;
    }
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw new Error("FreshRead lock path is not a regular directory");
    }
    let names;
    try {
      names = fs.readdirSync(this.lockPath);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (["EPERM", "EACCES"].includes(error.code)) return false;
      throw error;
    }
    if (names.length > 1 || (names.length === 1 && !/^owner-[0-9a-f-]+\.json$/i.test(names[0]))) return false;
    let newestMtime = lockStat.mtimeMs;
    let ownerPath = null;
    let ownerPid = null;
    if (names.length === 1) {
      ownerPath = path.join(this.lockPath, names[0]);
      let ownerStat;
      try {
        ownerStat = fs.lstatSync(ownerPath);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        if (["EPERM", "EACCES"].includes(error.code)) return false;
        throw error;
      }
      if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) return false;
      newestMtime = Math.max(newestMtime, ownerStat.mtimeMs);
      if (ownerStat.size <= 4096) {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          const token = names[0].slice("owner-".length, -".json".length);
          if (isObject(owner) && owner.token === token && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            ownerPid = owner.pid;
          }
        } catch {}
      }
    }
    if (Date.now() - newestMtime <= this.staleLockMs) return false;
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
        return false;
      } catch (error) {
        if (error && ["EPERM", "EACCES"].includes(error.code)) return false;
      }
    }
    if (ownerPath) {
      try {
        fs.unlinkSync(ownerPath);
      } catch (error) {
        if (error.code === "ENOENT") return false;
        if (["EPERM", "EACCES"].includes(error.code)) return false;
        throw error;
      }
    }
    try {
      fs.rmdirSync(this.lockPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(error.code)) return false;
      throw error;
    }
  }

  _acquireLock() {
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      const token = crypto.randomUUID();
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        try {
          fs.writeFileSync(
            this._lockOwnerPath(token),
            `${JSON.stringify({ token, pid: process.pid, createdAt: nowIso() })}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 }
          );
        } catch (ownerError) {
          try { fs.rmdirSync(this.lockPath); } catch {}
          throw ownerError;
        }
        this.lockToken = token;
        return token;
      } catch (error) {
        const transientWindowsContention = process.platform === "win32" &&
          ["EPERM", "EACCES"].includes(error.code);
        if (error.code !== "EEXIST" && !transientWindowsContention) throw error;
        this.metrics.lockRetries += 1;
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error("timed out waiting for FreshRead state lock");
        const reclaimed = this._tryReclaimStaleLock();
        if (reclaimed && !transientWindowsContention) continue;
        Atomics.wait(WAIT_BUFFER, 0, 0, Math.min(25, Math.max(1, this.lockTimeoutMs - (Date.now() - started))));
      }
    }
  }

  _releaseLock(token = this.lockToken) {
    if (!token) return;
    let removedOwner = false;
    try {
      fs.unlinkSync(this._lockOwnerPath(token));
      removedOwner = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (removedOwner) {
      const started = Date.now();
      const releaseTimeoutMs = Math.min(this.lockTimeoutMs, 1000);
      const expectedOwnerName = path.basename(this._lockOwnerPath(token));
      while (true) {
        try {
          fs.rmdirSync(this.lockPath);
          break;
        } catch (error) {
          if (error.code === "ENOENT") break;
          const transientWindowsContention = process.platform === "win32" &&
            ["EPERM", "EACCES"].includes(error.code);
          if (!["ENOTEMPTY", "EEXIST"].includes(error.code) && !transientWindowsContention) throw error;
          let names;
          try {
            names = fs.readdirSync(this.lockPath);
          } catch (readError) {
            if (readError.code === "ENOENT") break;
            const transientWindowsReadContention = process.platform === "win32" &&
              ["EPERM", "EACCES"].includes(readError.code);
            if (!transientWindowsReadContention) throw readError;
          }
          if (names && names.some((name) => name !== expectedOwnerName)) {
            throw new Error("refusing to release a FreshRead state lock with a different owner");
          }
          if (Date.now() - started >= releaseTimeoutMs) {
            throw new Error("timed out releasing FreshRead state lock", { cause: error });
          }
          Atomics.wait(
            WAIT_BUFFER,
            0,
            0,
            Math.min(5, Math.max(1, releaseTimeoutMs - (Date.now() - started)))
          );
        }
      }
    }
    if (this.lockToken === token) this.lockToken = null;
  }

  _withState(mutator) {
    if (!this.enabled) return mutator(this._emptyState(), { corrupt: false, detail: "FreshRead is disabled" }).value;
    const lockToken = this._acquireLock();
    try {
      const loaded = this._readState();
      const result = mutator(loaded.state, loaded) || {};
      if (result.changed || loaded.migrated) this._writeState(loaded.state);
      return result.value;
    } finally {
      this._releaseLock(lockToken);
    }
  }

  _resolvePath(filePath) {
    this.metrics.statCalls += 1;
    try {
      const canonical = canonicalPath(this.cwd, filePath);
      if (!canonical) return { kind: "error", detail: "invalid or empty path" };
      if (!this.allowOutsideWorkspace && !isWithin(this.cwd, canonical)) {
        return { kind: "error", path: canonical, detail: "path is outside the workspace scope" };
      }
      let entry;
      try {
        entry = fs.lstatSync(canonical, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return this._resolveMissingPath(canonical);
        throw error;
      }
      const realPath = fs.realpathSync.native(canonical);
      if (!this.allowOutsideWorkspace && !isWithin(this.cwd, realPath)) {
        return { kind: "error", path: canonical, detail: "symlink target is outside the workspace scope" };
      }
      if (entry.isSymbolicLink()) entry = fs.statSync(canonical, { bigint: true });
      if (entry.isDirectory()) return { kind: "directory", path: canonical, realPath, entry };
      if (!entry.isFile()) return { kind: "other", path: canonical, realPath, entry };
      return { kind: "file", path: canonical, realPath, entry };
    } catch (error) {
      return { kind: "error", path: canonicalPath(this.cwd, filePath), detail: error.message };
    }
  }

  _resolveMissingPath(canonical) {
    let ancestor = path.dirname(canonical);
    while (true) {
      let lexicalEntry;
      try {
        lexicalEntry = fs.lstatSync(ancestor, { bigint: true });
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
          return { kind: "error", path: canonical, detail: error.message };
        }
        const parent = path.dirname(ancestor);
        if (pathKey(parent) === pathKey(ancestor)) {
          return { kind: "error", path: canonical, detail: "cannot resolve a safe existing ancestor" };
        }
        ancestor = parent;
        continue;
      }
      try {
        const realPath = fs.realpathSync.native(ancestor);
        const entry = lexicalEntry.isSymbolicLink()
          ? fs.statSync(ancestor, { bigint: true })
          : lexicalEntry;
        if (!entry.isDirectory()) {
          return { kind: "error", path: canonical, detail: "missing path has a non-directory ancestor" };
        }
        if (!this.allowOutsideWorkspace && !isWithin(this.cwd, realPath)) {
          return { kind: "error", path: canonical, detail: "missing path resolves through an ancestor outside the workspace scope" };
        }
        return { kind: "missing", path: canonical, ancestorRealPath: realPath };
      } catch (error) {
        return { kind: "error", path: canonical, detail: error.message };
      }
    }
  }

  _probe(filePath) {
    const resolved = this._resolvePath(filePath);
    if (resolved.kind !== "file") {
      if (resolved.kind === "directory" || resolved.kind === "other") {
        return { kind: "error", path: resolved.path, detail: "path is not a regular file" };
      }
      return resolved;
    }
    try {
      const entry = resolved.entry;
      if (Number(entry.size) > this.maxFileBytes) {
        return { kind: "error", path: resolved.path, detail: `file exceeds ${this.maxFileBytes} byte safety limit` };
      }
      return { kind: "file", path: resolved.path, metadata: metadataFromStat(entry, resolved.realPath) };
    } catch (error) {
      return { kind: "error", path: canonicalPath(this.cwd, filePath), detail: error.message };
    }
  }

  _hashFile(filePath) {
    this.metrics.hashCalls += 1;
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const descriptor = fs.openSync(filePath, "r");
    let bytes = 0;
    try {
      while (true) {
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        digest.update(buffer.subarray(0, count));
        bytes += count;
      }
    } finally {
      fs.closeSync(descriptor);
    }
    this.metrics.bytesHashed += bytes;
    return digest.digest("hex");
  }

  _capture(filePath, previousObservation = null, forceHash = false) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = this._probe(filePath);
      if (before.kind !== "file") return before;
      if (!forceHash && previousObservation && previousObservation.hash && sameMetadata(before.metadata, previousObservation.metadata)) {
        return {
          kind: "file",
          path: before.path,
          hash: previousObservation.hash,
          metadata: before.metadata,
          reusedHash: true,
        };
      }
      try {
        const hash = this._hashFile(before.path);
        const after = this._probe(before.path);
        if (after.kind === "file" && sameMetadata(before.metadata, after.metadata)) {
          return { kind: "file", path: before.path, hash, metadata: after.metadata, reusedHash: false };
        }
      } catch (error) {
        if (attempt === 1) return { kind: "error", path: before.path, detail: error.message };
      }
    }
    return { kind: "error", path: canonicalPath(this.cwd, filePath), detail: "file changed while hashing" };
  }

  _classify(record, capture) {
    if (!record || !record.snapshot || !record.snapshot.hash) {
      return { state: STATES.UNKNOWN, detail: "FreshRead has no reliable snapshot" };
    }
    if (capture.kind === "missing") return { state: STATES.MISSING, detail: "file no longer exists" };
    if (capture.kind !== "file") return { state: STATES.UNKNOWN, detail: capture.detail || "current file identity is unavailable" };
    const sameIdentity = pathKey(capture.metadata.realPath) === pathKey(record.snapshot.metadata.realPath);
    if (sameIdentity && capture.hash === record.snapshot.hash) {
      return { state: STATES.FRESH, detail: "content matches the last reliable read" };
    }
    if (!record.externalSinceRead && record.lastSelf && record.lastSelf.hash === capture.hash) {
      return { state: STATES.STALE_SELF, detail: "content changed through an observed Codex write" };
    }
    return { state: STATES.STALE_EXTERNAL, detail: "content changed without a matching current-session write" };
  }

  _result(record, state, detail, capture = null) {
    const filePath = record ? record.path : capture && capture.path;
    return {
      path: filePath || null,
      displayPath: filePath ? displayPath(this.cwd, filePath) : null,
      state,
      detail,
      readAt: record && record.snapshot ? record.snapshot.readAt : null,
      changedAt: capture && capture.metadata ? changedAtFromMetadata(capture.metadata) : null,
      snapshotHash: record && record.snapshot ? record.snapshot.hash : null,
      currentHash: capture && capture.kind === "file" ? capture.hash : null,
    };
  }

  _inspectRecord(record, { forceHash = false } = {}) {
    const capture = this._capture(record.path, record.observation, forceHash);
    const classification = this._classify(record, capture);
    let changed = false;
    if (capture.kind === "file") {
      const nextObservation = {
        hash: capture.hash,
        metadata: capture.metadata,
        checkedAt: nowIso(this.clock()),
      };
      if (!record.observation || record.observation.hash !== nextObservation.hash || !sameMetadata(record.observation.metadata, nextObservation.metadata)) {
        record.observation = nextObservation;
        changed = true;
      }
      if (classification.state === STATES.STALE_EXTERNAL && !record.externalSinceRead) {
        record.externalSinceRead = true;
        changed = true;
      } else if (classification.state === STATES.FRESH && record.externalSinceRead) {
        record.externalSinceRead = false;
        changed = true;
      }
    } else if (capture.kind === "missing") {
      const nextObservation = { missing: true, checkedAt: nowIso(this.clock()) };
      if (!record.observation || !record.observation.missing) {
        record.observation = nextObservation;
        changed = true;
      }
    }
    return {
      changed,
      value: this._result(record, classification.state, classification.detail, capture),
    };
  }

  recordRead(filePath, meta = {}) {
    if (!this.enabled) return this._result(null, STATES.UNKNOWN, "FreshRead is disabled", { path: canonicalPath(this.cwd, filePath) });
    return this._withState((state, loaded) => {
      const found = this._findRecord(state, filePath);
      const existing = found.record;
      const capture = this._capture(filePath, existing && existing.observation, false);
      if (capture.kind !== "file") {
        return {
          changed: false,
          value: this._result(existing, STATES.UNKNOWN, capture.detail || "read did not produce a reliable file snapshot", capture),
        };
      }
      const at = nowIso(this.clock());
      const record = {
        path: capture.path,
        displayPath: displayPath(this.cwd, capture.path),
        identityPath: capture.metadata.realPath,
        snapshot: {
          hash: capture.hash,
          metadata: capture.metadata,
          readAt: at,
          toolName: meta.toolName || null,
          toolUseId: meta.toolUseId || null,
        },
        observation: {
          hash: capture.hash,
          metadata: capture.metadata,
          checkedAt: at,
        },
        lastSelf: null,
        externalSinceRead: false,
      };
      const identityKey = pathKey(capture.metadata.realPath);
      if (found.key && found.key !== identityKey) delete state.files[found.key];
      state.files[identityKey] = record;
      return { changed: true, value: this._result(record, STATES.FRESH, loaded.corrupt ? loaded.detail : "snapshot recorded", capture) };
    });
  }

  recordVerifiedRead(evidence, meta = {}) {
    if (!this.enabled) {
      return this._result(null, STATES.UNKNOWN, "FreshRead is disabled", {
        path: canonicalPath(this.cwd, evidence && evidence.path),
      });
    }
    if (!isObject(evidence)) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence is not an object");
    }
    const canonical = canonicalPath(this.cwd, evidence.path);
    if (!canonical || (!this.allowOutsideWorkspace && !isWithin(this.cwd, canonical))) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence path is outside the workspace scope", { path: canonical });
    }
    if (typeof evidence.hash !== "string" || !SHA256_PATTERN.test(evidence.hash)) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence hash is invalid", { path: canonical });
    }
    const metadataError = this._validateMetadata(evidence.metadata, "verified read evidence metadata");
    if (metadataError) return this._result(null, STATES.UNKNOWN, metadataError, { path: canonical });
    if (Number(evidence.metadata.size) > this.maxFileBytes) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence exceeds the file safety limit", { path: canonical });
    }
    if (!isTimestamp(evidence.readAt)) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence readAt is invalid", { path: canonical });
    }
    const identityPath = path.normalize(evidence.metadata.realPath);
    if (evidence.realPath !== undefined &&
        (typeof evidence.realPath !== "string" || pathKey(evidence.realPath) !== pathKey(identityPath))) {
      return this._result(null, STATES.UNKNOWN, "verified read evidence realPath is inconsistent", { path: canonical });
    }

    return this._withState((state, loaded) => {
      const found = this._findRecord(state, canonical);
      const current = this._capture(canonical, null, true);
      const checkedAt = nowIso(this.clock());
      const record = {
        path: canonical,
        displayPath: displayPath(this.cwd, canonical),
        identityPath,
        snapshot: {
          hash: evidence.hash,
          metadata: { ...evidence.metadata, realPath: identityPath },
          readAt: evidence.readAt,
          toolName: meta.toolName || null,
          toolUseId: meta.toolUseId || null,
        },
        observation: current.kind === "file"
          ? { hash: current.hash, metadata: current.metadata, checkedAt }
          : current.kind === "missing"
            ? { missing: true, checkedAt }
            : { hash: evidence.hash, metadata: { ...evidence.metadata, realPath: identityPath }, checkedAt },
        lastSelf: null,
        externalSinceRead: false,
      };
      const classification = this._classify(record, current);
      if (classification.state === STATES.STALE_EXTERNAL) record.externalSinceRead = true;
      const identityKey = pathKey(identityPath);
      if (found.key && found.key !== identityKey) delete state.files[found.key];
      state.files[identityKey] = record;
      return {
        changed: true,
        value: this._result(
          record,
          classification.state,
          loaded.corrupt ? loaded.detail : classification.detail,
          current
        ),
      };
    });
  }

  recordSelfWrite(filePath, meta = {}) {
    if (!this.enabled) return this._result(null, STATES.UNKNOWN, "FreshRead is disabled", { path: canonicalPath(this.cwd, filePath) });
    return this._withState((state, loaded) => {
      const found = this._findRecord(state, filePath);
      const resolution = this._resolvePath(filePath);
      const records = new Set(found.record ? [found.record] : []);
      if (resolution.kind === "file") {
        for (const record of Object.values(state.files)) {
          const currentResolution = this._resolvePath(record.path);
          if (this._recordCurrentMatchesFileIdentity(resolution, currentResolution)) records.add(record);
        }
      }
      if (!records.size) {
        return { changed: false, value: this._result(null, STATES.UNKNOWN, loaded.detail || "file is not in this session read set", { path: found.canonical }) };
      }

      let representative = null;
      let changed = false;
      for (const record of records) {
        const capture = this._capture(record.path, record.observation, true);
        const at = nowIso(this.clock());
        if (capture.kind === "file") {
          record.lastSelf = { hash: capture.hash, at, toolUseId: meta.toolUseId || null };
          record.observation = { hash: capture.hash, metadata: capture.metadata, checkedAt: at };
          changed = true;
        } else if (capture.kind === "missing") {
          record.lastSelf = { missing: true, at, toolUseId: meta.toolUseId || null };
          record.observation = { missing: true, checkedAt: at };
          changed = true;
        }
        const classification = this._classify(record, capture);
        const result = this._result(record, classification.state, classification.detail, capture);
        if (!representative || result.state === STATES.UNKNOWN) representative = result;
      }
      return { changed, value: representative };
    });
  }

  inspect(filePath, options = {}) {
    if (!this.enabled) return this._result(null, STATES.UNKNOWN, "FreshRead is disabled", { path: canonicalPath(this.cwd, filePath) });
    return this._withState((state, loaded) => {
      const found = this._findRecord(state, filePath);
      const record = found.record;
      if (!record) return { changed: false, value: this._result(null, STATES.UNKNOWN, loaded.detail || "FreshRead has no reliable snapshot", { path: found.canonical }) };
      const result = this._inspectRecord(record, options);
      if (loaded.corrupt) result.value.detail = loaded.detail;
      return result;
    });
  }

  checkAll(options = {}) {
    if (!this.enabled) return { files: [], summary: summarize([]), corrupt: false, detail: "FreshRead is disabled" };
    return this._withState((state, loaded) => {
      const files = [];
      let changed = false;
      for (const key of Object.keys(state.files).sort()) {
        const result = this._inspectRecord(state.files[key], options);
        changed ||= result.changed;
        files.push(result.value);
      }
      files.sort((a, b) => String(a.displayPath).localeCompare(String(b.displayPath)));
      return {
        changed,
        value: { files, summary: summarize(files), corrupt: loaded.corrupt, detail: loaded.detail },
      };
    });
  }

  guardEdit(filePaths) {
    const unique = [...new Map(
      (filePaths || [])
        .map((item) => canonicalPath(this.cwd, item))
        .filter(Boolean)
        .map((item) => [pathKey(item), item])
    ).values()];
    if (!this.enabled || !unique.length) return { blocked: false, files: [], trackedPaths: [], reason: null };
    return this._withState((state, loaded) => {
      if (loaded.corrupt) {
        const files = unique.map((filePath) => this._result(null, STATES.UNKNOWN, loaded.detail, { path: filePath }));
        return {
          changed: false,
          value: {
            blocked: true,
            files,
            reason: `FreshRead blocked this edit because its session state is unreadable. ${modelSafeFragment(loaded.detail)} Re-read the target after repairing or clearing FreshRead state.`,
            stateWarning: modelSafeFragment(loaded.detail),
          },
        };
      }
      const unsafe = [];
      let changed = false;
      const matchedRecords = new Set();
      const historicalIdentityOnly = new Map();
      const descendantPaths = new Map();
      const pathsForRecord = (record) => {
        if (descendantPaths.has(record)) return descendantPaths.get(record);
        const observationPath = record.observation && record.observation.metadata && record.observation.metadata.realPath;
        const currentResolution = this._resolvePath(record.path);
        const value = {
          currentResolution,
          paths: [
            record.path,
            recordIdentityPath(record),
            observationPath,
            currentResolution.realPath,
          ].filter(Boolean),
        };
        descendantPaths.set(record, value);
        return value;
      };
      for (const candidatePath of unique) {
        const resolution = this._resolvePath(candidatePath);
        if (["error", "other"].includes(resolution.kind)) {
          unsafe.push(this._result(
            null,
            STATES.UNKNOWN,
            resolution.detail || "write target identity is unavailable",
            resolution,
          ));
          continue;
        }
        const found = this._findRecord(state, candidatePath, resolution);
        if (found.record) {
          matchedRecords.add(found.record);
        }
        const roots = [found.canonical, found.identityPath, resolution.realPath].filter(Boolean);
        for (const record of Object.values(state.files)) {
          const recordTarget = pathsForRecord(record);
          const pathMatch = roots.some((root) => recordTarget.paths.some((recordPath) => isWithin(root, recordPath)));
          const currentIdentityMatch = this._recordCurrentMatchesFileIdentity(resolution, recordTarget.currentResolution);
          const anyIdentityMatch = this._recordMatchesFileIdentity(record, resolution, recordTarget.currentResolution);
          if (pathMatch || anyIdentityMatch) {
            matchedRecords.add(record);
            if (!pathMatch && anyIdentityMatch && !currentIdentityMatch) {
              historicalIdentityOnly.set(record, candidatePath);
            }
          }
        }
      }
      for (const record of matchedRecords) {
        if (historicalIdentityOnly.has(record)) {
          const capture = this._capture(historicalIdentityOnly.get(record), null, true);
          unsafe.push(this._result(
            record,
            STATES.STALE_EXTERNAL,
            "write target still aliases the remembered file identity, but the read path now resolves elsewhere",
            capture,
          ));
          continue;
        }
        const result = this._inspectRecord(record, { forceHash: true });
        changed ||= result.changed;
        if (result.value.state !== STATES.FRESH) unsafe.push(result.value);
      }
      const names = unsafe.map((item) => `${item.displayPath} (${item.state})`).join(", ");
      return {
        changed,
        value: {
          blocked: unsafe.length > 0,
          files: unsafe,
          trackedPaths: [...matchedRecords].map((record) => record.path),
          reason: unsafe.length
            ? `FreshRead blocked this edit because remembered file context is no longer fresh: ${names}. Re-read the current file before editing.`
            : null,
          stateWarning: modelSafeFragment(loaded.detail),
        },
      };
    });
  }

  clear() {
    if (!this.enabled) return { cleared: 0 };
    return this._withState((state, loaded) => {
      const cleared = Object.keys(state.files).length;
      state.files = {};
      return { changed: loaded.corrupt || cleared > 0, value: { cleared } };
    });
  }

  formatStatus(report = this.checkAll()) {
    const lines = [
      "FreshRead status",
      "",
      `Tracked: ${report.summary.tracked} files`,
      `FRESH: ${report.summary.FRESH}`,
      `STALE_SELF: ${report.summary.STALE_SELF}`,
      `STALE_EXTERNAL: ${report.summary.STALE_EXTERNAL}`,
      `MISSING: ${report.summary.MISSING}`,
      `UNKNOWN: ${report.summary.UNKNOWN}`,
    ];
    if (report.corrupt && report.detail) lines.push("", `Warning: ${modelSafeFragment(report.detail)}`);
    return lines.join("\n");
  }

  formatInspect(report = this.checkAll()) {
    if (!report.files.length) return `${this.formatStatus(report)}\n\nNo files are tracked in this session.`;
    const lines = [this.formatStatus(report), ""];
    for (const file of report.files) {
      lines.push(`${file.displayPath} — ${file.state}`);
      if (file.readAt) lines.push(`  read: ${file.readAt}`);
      if (file.changedAt && file.state !== STATES.FRESH) lines.push(`  current changed: ${file.changedAt}`);
      if (file.detail) lines.push(`  ${modelSafeFragment(file.detail)}`);
    }
    return lines.join("\n");
  }

  formatFreshnessContext(report, { includeFresh = false } = {}) {
    const nonFresh = report.files.filter((file) => file.state !== STATES.FRESH);
    const selected = includeFresh
      ? [...nonFresh, ...report.files.filter((file) => file.state === STATES.FRESH)]
      : nonFresh;
    if (!selected.length && !report.corrupt) return null;
    const lines = ["⚠ FreshRead — filesystem truth overrides remembered file context.", ""];
    if (report.corrupt && report.detail) lines.push(`State warning: ${modelSafeFragment(report.detail)}`, "");
    for (const file of selected.slice(0, 100)) {
      lines.push(`- ${file.displayPath}: ${file.state}`);
      if (file.state !== STATES.FRESH) lines.push("  Re-read the current file before relying on remembered contents or editing it.");
    }
    if (selected.length > 100) {
      const omitted = selected.length - 100;
      lines.push(`- … ${omitted} more tracked ${omitted === 1 ? "file" : "files"} omitted`);
    }
    return lines.join("\n");
  }

  lifecycle(eventName, payload = {}) {
    const report = this.checkAll();
    if (eventName === "PreCompact" || eventName === "PostCompact") return null;
    const includeFresh = eventName === "SessionStart" && ["resume", "compact"].includes(payload.source);
    const context = this.formatFreshnessContext(report, { includeFresh });
    if (!context) return null;
    if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: context,
        },
      };
    }
    return { systemMessage: context };
  }
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  FreshReadEngine,
  STATES,
  canonicalPath,
  displayPath,
  isWithin,
  modelSafeFragment,
  pathKey,
  sameMetadata,
  sha256Text,
  summarize,
};
