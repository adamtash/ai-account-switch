import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// Unique needle: the start of getApiKey() in AuthStorage.
// We insert this.reload() right after the opening comment so every API call
// re-reads auth.json from disk, picking up tokens written by claude-as/codex-as.
const NEEDLE =
  "    async getApiKey(providerId, sessionId) {\n" +
  "        // Runtime override takes highest priority\n" +
  "        const runtimeKey";

const REPLACEMENT =
  "    async getApiKey(providerId, sessionId) {\n" +
  "        // Runtime override takes highest priority\n" +
  "        this.reload();\n" +
  "        const runtimeKey";

const BACKUP_SUFFIX = ".gsd-as.bak";

export function resolveGsdBinary() {
  try {
    return execSync("which gsd", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "gsd binary not found in PATH. Make sure gsd is installed."
    );
  }
}

export function resolveGsdAuthStoragePath(gsdBin) {
  // Resolve symlink (gsd -> .../gsd-pi/dist/loader.js)
  let realBin = gsdBin;
  try {
    realBin = fs.realpathSync(gsdBin);
  } catch {
    // use as-is
  }

  // loader is in dist/, walk up one level to the package root
  const distDir = path.dirname(realBin);
  const pkgRoot = path.dirname(distDir);

  return path.join(
    pkgRoot,
    "packages",
    "pi-coding-agent",
    "dist",
    "core",
    "auth-storage.js"
  );
}

export function formatGsdPatchStatus(content) {
  if (content.includes(REPLACEMENT)) return "patched";
  if (content.includes(NEEDLE)) return "unpatched";
  return "unknown";
}

export function checkGsd(gsdBin) {
  try {
    const filePath = resolveGsdAuthStoragePath(gsdBin);
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        status: "unknown",
        error: `auth-storage.js not found: ${filePath}`
      };
    }
    const content = fs.readFileSync(filePath, "utf8");
    return {
      ok: true,
      filePath,
      backupPath: filePath + BACKUP_SUFFIX,
      status: formatGsdPatchStatus(content)
    };
  } catch (error) {
    return {
      ok: false,
      status: "unknown",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function patchGsd(gsdBin) {
  const filePath = resolveGsdAuthStoragePath(gsdBin);

  if (!fs.existsSync(filePath)) {
    throw new Error(`GSD auth-storage.js not found at: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const status = formatGsdPatchStatus(content);

  if (status === "patched") {
    return {
      filePath,
      backupPath: filePath + BACKUP_SUFFIX,
      changed: false,
      createdBackup: false
    };
  }

  if (status !== "unpatched") {
    throw new Error(
      "GSD auth-storage.js does not contain the expected pattern. " +
        "It may have changed with a GSD update — check for a new release of ai-as."
    );
  }

  const backupPath = filePath + BACKUP_SUFFIX;
  let createdBackup = false;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    createdBackup = true;
  }

  const patched = content.replace(NEEDLE, REPLACEMENT);
  fs.writeFileSync(filePath, patched, "utf8");

  return {
    filePath,
    backupPath,
    changed: true,
    createdBackup
  };
}

export function restoreGsd(gsdBin) {
  const filePath = resolveGsdAuthStoragePath(gsdBin);
  const backupPath = filePath + BACKUP_SUFFIX;

  if (!fs.existsSync(backupPath)) {
    throw new Error(`No GSD backup found at: ${backupPath}`);
  }

  fs.copyFileSync(backupPath, filePath);

  return {
    filePath,
    backupPath,
    restored: true
  };
}
