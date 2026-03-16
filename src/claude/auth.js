import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function sha256Prefix(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function resolveClaudeConfigDir(options = {}) {
  return path.resolve(
    options.claudeConfigDir ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), ".claude")
  );
}

export function getCredentialServiceName(options = {}) {
  const configDir = resolveClaudeConfigDir(options);
  const oauthFileSuffix =
    options.oauthFileSuffix ||
    process.env.CLAUDE_CODE_OAUTH_FILE_SUFFIX ||
    "";
  const needsConfigHash =
    Boolean(options.claudeConfigDir) || Boolean(process.env.CLAUDE_CONFIG_DIR);
  const configHash = needsConfigHash ? `-${sha256Prefix(configDir)}` : "";
  return `Claude Code${oauthFileSuffix}-credentials${configHash}`;
}

export function getCredentialAccountName() {
  return process.env.USER || os.userInfo().username || "claude-code-user";
}

export function getPlaintextCredentialsPath(options = {}) {
  return path.join(resolveClaudeConfigDir(options), ".credentials.json");
}

function parseJsonOrNull(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runSecurity(args, input) {
  return spawnSync("security", args, {
    encoding: "utf8",
    input
  });
}

export function readKeychainCredentials(options = {}) {
  const serviceName = getCredentialServiceName(options);
  const accountName = getCredentialAccountName();
  const result = runSecurity(
    ["find-generic-password", "-a", accountName, "-w", "-s", serviceName],
    undefined
  );

  if (result.status !== 0) {
    return null;
  }

  return parseJsonOrNull(result.stdout.trim());
}

export function writeKeychainCredentials(payload, options = {}) {
  const serviceName = getCredentialServiceName(options);
  const accountName = getCredentialAccountName();
  const result = runSecurity(
    ["add-generic-password", "-a", accountName, "-s", serviceName, "-w", JSON.stringify(payload), "-U"],
    undefined
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Failed to write Claude credentials to macOS Keychain.");
  }

  return {
    backend: "keychain",
    serviceName,
    accountName
  };
}

export function readPlaintextCredentials(options = {}) {
  const credentialsPath = getPlaintextCredentialsPath(options);
  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  return parseJsonOrNull(fs.readFileSync(credentialsPath, "utf8"));
}

export function writePlaintextCredentials(payload, options = {}) {
  const credentialsPath = getPlaintextCredentialsPath(options);
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(credentialsPath, 0o600);
  return {
    backend: "plaintext",
    credentialsPath
  };
}

export function readClaudeCredentials(options = {}) {
  const backend = options.backend || "auto";

  if (backend === "keychain") {
    return readKeychainCredentials(options);
  }

  if (backend === "plaintext") {
    return readPlaintextCredentials(options);
  }

  if (process.platform === "darwin") {
    return readKeychainCredentials(options) || readPlaintextCredentials(options);
  }

  return readPlaintextCredentials(options);
}

export function writeClaudeCredentials(payload, options = {}) {
  const backend = options.backend || "auto";

  if (backend === "keychain") {
    return writeKeychainCredentials(payload, options);
  }

  if (backend === "plaintext") {
    return writePlaintextCredentials(payload, options);
  }

  if (process.platform === "darwin") {
    try {
      return writeKeychainCredentials(payload, options);
    } catch (error) {
      return {
        ...writePlaintextCredentials(payload, options),
        fallbackError: error.message
      };
    }
  }

  return writePlaintextCredentials(payload, options);
}

export function readCurrentOauth(options = {}) {
  const credentials = readClaudeCredentials(options);
  return credentials?.claudeAiOauth || null;
}

export function writeCurrentOauth(oauth, options = {}) {
  const existing = readClaudeCredentials(options) || {};
  const payload = {
    ...existing,
    claudeAiOauth: oauth
  };
  return writeClaudeCredentials(payload, options);
}

