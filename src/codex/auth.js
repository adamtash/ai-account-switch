import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexHome(options = {}) {
  return path.resolve(
    options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  );
}

export function getAuthFilePath(options = {}) {
  return path.join(resolveCodexHome(options), "auth.json");
}

export function readCurrentAuth(options = {}) {
  const authFile = getAuthFilePath(options);
  if (!fs.existsSync(authFile)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(authFile, "utf8"));
}

export function writeCurrentAuth(auth, options = {}) {
  const authFile = getAuthFilePath(options);
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(authFile, 0o600);
  return {
    authFile
  };
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

export function fingerprintAuth(auth) {
  if (!auth) {
    return null;
  }

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(auth)))
    .digest("hex");
}

export function shortFingerprint(auth) {
  const fingerprint = fingerprintAuth(auth);
  return fingerprint ? fingerprint.slice(0, 8) : null;
}
