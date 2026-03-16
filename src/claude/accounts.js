import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_VERSION = 1;
const DEFAULT_STORE_DIR = path.join(os.homedir(), ".claude-as");
const DEFAULT_STORE_FILE = path.join(DEFAULT_STORE_DIR, "accounts.json");

function normalizeAccount(account) {
  const timestamp = new Date().toISOString();
  return {
    name: account.name,
    createdAt: account.createdAt || timestamp,
    updatedAt: timestamp,
    oauth: account.oauth,
    profile: account.profile || null,
    tokenAccount: account.tokenAccount || null
  };
}

export function resolveAccountsFile(inputPath) {
  if (!inputPath) {
    return DEFAULT_STORE_FILE;
  }

  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

export function emptyStore() {
  return {
    version: STORE_VERSION,
    activeAccountName: null,
    accounts: []
  };
}

export function readAccountsStore(accountsFile) {
  if (!fs.existsSync(accountsFile)) {
    return emptyStore();
  }

  const raw = fs.readFileSync(accountsFile, "utf8");
  const parsed = JSON.parse(raw);

  return {
    version: parsed.version || STORE_VERSION,
    activeAccountName: parsed.activeAccountName || null,
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
  };
}

export function writeAccountsStore(accountsFile, store) {
  fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
  fs.writeFileSync(accountsFile, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  fs.chmodSync(accountsFile, 0o600);
}

export function getAccount(store, name) {
  return store.accounts.find((account) => account.name === name) || null;
}

export function upsertAccount(store, account) {
  const normalized = normalizeAccount(account);
  const existing = getAccount(store, normalized.name);

  if (!existing) {
    return {
      ...store,
      accounts: [...store.accounts, normalized]
    };
  }

  return {
    ...store,
    accounts: store.accounts.map((entry) =>
      entry.name === normalized.name
        ? {
            ...existing,
            ...normalized,
            createdAt: existing.createdAt
          }
        : entry
    )
  };
}

export function setActiveAccount(store, name) {
  return {
    ...store,
    activeAccountName: name
  };
}

export function removeAccount(store, name) {
  const accounts = store.accounts.filter((account) => account.name !== name);
  return {
    ...store,
    activeAccountName:
      store.activeAccountName === name ? null : store.activeAccountName,
    accounts
  };
}
