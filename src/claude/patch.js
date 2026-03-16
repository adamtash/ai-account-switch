import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MEMOIZED_AUTH_NEEDLE =
  "e8=_q(()=>{if(process.env.CLAUDE_CODE_OAUTH_TOKEN)return{accessToken:process.env.CLAUDE_CODE_OAUTH_TOKEN";
export const LIVE_AUTH_NEEDLE =
  "e8=(0,()=>{if(process.env.CLAUDE_CODE_OAUTH_TOKEN)return{accessToken:process.env.CLAUDE_CODE_OAUTH_TOKEN";
export const DEFAULT_BACKUP_SUFFIX = ".claude-as.bak";
const PATCH_FROM = "e8=_q(()=>{";
const PATCH_TO = "e8=(0,()=>{";

function runWhich(command) {
  const result = spawnSync("which", [command], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value || null;
}

function resignBinaryIfNeeded(binaryPath) {
  if (process.platform !== "darwin") {
    return null;
  }

  const result = spawnSync("codesign", ["-f", "-s", "-", binaryPath], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || "Failed to re-sign the patched Claude binary."
    );
  }

  return {
    method: "ad-hoc"
  };
}

export function resolveClaudeBinary(targetPath) {
  if (targetPath) {
    return path.resolve(targetPath);
  }

  const fromPath = runWhich("claude");
  if (!fromPath) {
    throw new Error("Unable to find `claude` on PATH.");
  }

  return fs.realpathSync(fromPath);
}

export function defaultBackupPath(binaryPath) {
  return `${binaryPath}${DEFAULT_BACKUP_SUFFIX}`;
}

export function inspectBinary(buffer) {
  const text = buffer.toString("latin1");
  const memoizedIndex = text.indexOf(MEMOIZED_AUTH_NEEDLE);
  const liveIndex = text.indexOf(LIVE_AUTH_NEEDLE);

  return {
    memoizedIndex,
    liveIndex,
    isPatchable: memoizedIndex !== -1 && liveIndex === -1,
    isPatched: liveIndex !== -1
  };
}

export function patchBuffer(buffer) {
  const patched = Buffer.from(buffer);
  const info = inspectBinary(buffer);

  if (info.isPatched) {
    return {
      changed: false,
      buffer: patched,
      reason: "already-patched"
    };
  }

  if (!info.isPatchable) {
    throw new Error(
      "Could not find the Claude OAuth memoization site in the target binary."
    );
  }

  const start = info.memoizedIndex;
  patched.write(PATCH_TO, start, "latin1");

  return {
    changed: true,
    buffer: patched,
    reason: "patched"
  };
}

export function readBinary(binaryPath) {
  return fs.readFileSync(binaryPath);
}

export function ensureBackup(binaryPath, backupPath) {
  if (fs.existsSync(backupPath)) {
    return false;
  }

  fs.copyFileSync(binaryPath, backupPath);
  return true;
}

export function patchBinary(binaryPath, backupPath = defaultBackupPath(binaryPath)) {
  const original = readBinary(binaryPath);
  const result = patchBuffer(original);

  if (!result.changed) {
    return {
      binaryPath,
      backupPath,
      changed: false,
      createdBackup: false,
      signature: null
    };
  }

  const createdBackup = ensureBackup(binaryPath, backupPath);
  fs.writeFileSync(binaryPath, result.buffer);
  const signature = resignBinaryIfNeeded(binaryPath);

  return {
    binaryPath,
    backupPath,
    changed: true,
    createdBackup,
    signature
  };
}

export function restoreBinary(binaryPath, backupPath = defaultBackupPath(binaryPath)) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  fs.copyFileSync(backupPath, binaryPath);

  return {
    binaryPath,
    backupPath
  };
}

export function formatStatus(binaryPath, buffer) {
  const info = inspectBinary(buffer);

  return {
    binaryPath,
    status: info.isPatched ? "patched" : info.isPatchable ? "unpatched" : "unknown"
  };
}

export function expandHome(inputPath) {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}
