import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyStore,
  getAccount,
  readAccountsStore,
  resolveAccountsFile,
  setActiveAccount,
  upsertAccount,
  writeAccountsStore
} from "../src/codex/accounts.js";
import {
  fingerprintAuth,
  getAuthFilePath,
  readCurrentAuth,
  writeCurrentAuth
} from "../src/codex/auth.js";
import { normalizeRateLimits } from "../src/codex/rpc.js";
import {
  addAccount,
  importCurrentAccount,
  loadAccountsView,
  loadStatus,
  main,
  pickBestAccount,
  pickNextAccount,
  switchToAccount
} from "../src/codex/cli.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-as-"));
const fakeCodexPath = path.join(tempRoot, "fake-codex.cjs");
fs.writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const authFile = path.join(codexHome, "auth.json");

function readAuth() {
  if (!fs.existsSync(authFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(authFile, "utf8"));
}

function writeAuth(value) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(value, null, 2) + "\\n");
}

if (args[0] === "login") {
  if (args[1] === "status") {
    const auth = readAuth();
    if (!auth) {
      process.exit(1);
    }
    console.log(auth.profile?.type === "apiKey" ? "Logged in using API key" : "Logged in using ChatGPT");
    process.exit(0);
  }

  const payload = JSON.parse(process.env.FAKE_CODEX_LOGIN_PAYLOAD || "null");
  if (!payload) {
    console.error("missing FAKE_CODEX_LOGIN_PAYLOAD");
    process.exit(1);
  }
  writeAuth(payload);
  process.exit(0);
}

if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";

  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const message = JSON.parse(trimmed);
      const auth = readAuth();

      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake/0.0.0" } }) + "\\n");
        continue;
      }

      if (message.method === "account/read") {
        process.stdout.write(
          JSON.stringify({
            id: message.id,
            result: {
              account: auth ? auth.profile || null : null,
              requiresOpenaiAuth: true
            }
          }) + "\\n"
        );
        continue;
      }

      if (message.method === "account/rateLimits/read") {
        process.stdout.write(
          JSON.stringify({
            id: message.id,
            result: {
              rateLimits: auth ? auth.rateLimits || null : null,
              rateLimitsByLimitId: auth && auth.rateLimits ? { codex: auth.rateLimits } : null
            }
          }) + "\\n"
        );
      }
    }
  });

  process.stdin.resume();
}
`,
  { mode: 0o755 }
);

process.env.CODEX_AS_CODEX_BIN = fakeCodexPath;

const authA = {
  auth_mode: "chatgpt",
  tokens: {
    account_id: "acct-a",
    access_token: "access-a",
    refresh_token: "refresh-a"
  },
  profile: {
    type: "chatgpt",
    email: "alpha@example.com",
    planType: "team"
  },
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: 1773599000
    },
    secondary: {
      usedPercent: 10,
      windowDurationMins: 10080,
      resetsAt: 1774186000
    },
    credits: {
      hasCredits: false,
      unlimited: false,
      balance: null
    },
    planType: "team"
  }
};

const authB = {
  auth_mode: "chatgpt",
  tokens: {
    account_id: "acct-b",
    access_token: "access-b",
    refresh_token: "refresh-b"
  },
  profile: {
    type: "chatgpt",
    email: "beta@example.com",
    planType: "team"
  },
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 85,
      windowDurationMins: 300,
      resetsAt: 1773598000
    },
    secondary: {
      usedPercent: 25,
      windowDurationMins: 10080,
      resetsAt: 1774185000
    },
    credits: {
      hasCredits: false,
      unlimited: false,
      balance: null
    },
    planType: "team"
  }
};

const accountsFile = resolveAccountsFile(path.join(tempRoot, "accounts.json"));
const codexHome = path.join(tempRoot, ".codex");

let store = emptyStore();
store = upsertAccount(store, {
  name: "alpha@example.com",
  auth: authA,
  profile: authA.profile
});
store = setActiveAccount(store, "alpha@example.com");
writeAccountsStore(accountsFile, store);
const loadedStore = readAccountsStore(accountsFile);
assert.equal(getAccount(loadedStore, "alpha@example.com").auth.tokens.access_token, "access-a");
assert.equal(loadedStore.activeAccountName, "alpha@example.com");

const currentWrite = writeCurrentAuth(authA, { codexHome });
assert.equal(currentWrite.authFile, getAuthFilePath({ codexHome }));
assert.equal(readCurrentAuth({ codexHome }).tokens.access_token, "access-a");
assert.notEqual(fingerprintAuth(authA), fingerprintAuth(authB));

assert.deepEqual(normalizeRateLimits(authA.rateLimits).primary, {
  utilization: 20,
  resetsAt: 1773599000 * 1000,
  windowMinutes: 300
});

const earliestResetPick = pickNextAccount([
  {
    name: "full@example.com",
    error: null,
    fiveHour: { utilization: 100, resetsAt: 1000 }
  },
  {
    name: "later@example.com",
    error: null,
    fiveHour: { utilization: 95, resetsAt: 3000 }
  },
  {
    name: "soon@example.com",
    error: null,
    fiveHour: { utilization: 60, resetsAt: 2000 }
  },
  {
    name: "bad@example.com",
    error: "unavailable",
    fiveHour: { utilization: 10, resetsAt: 100 }
  }
]);
assert.equal(earliestResetPick.row.name, "soon@example.com");
assert.equal(earliestResetPick.reason.explanation.includes("resets sooner"), true);

const tieBreakPick = pickNextAccount([
  {
    name: "high@example.com",
    error: null,
    fiveHour: { utilization: 80, resetsAt: 5000 }
  },
  {
    name: "low@example.com",
    error: null,
    fiveHour: { utilization: 40, resetsAt: 5000 }
  }
]);
assert.equal(tieBreakPick.row.name, "high@example.com");
assert.equal(tieBreakPick.reason.explanation.includes("less 5h headroom"), true);

process.env.FAKE_CODEX_LOGIN_PAYLOAD = JSON.stringify(authA);
const addOne = await addAccount({
  accountsFile,
  codexHome
});
assert.equal(addOne.accountName, "alpha@example.com");

process.env.FAKE_CODEX_LOGIN_PAYLOAD = JSON.stringify(authB);
const addTwo = await addAccount({
  accountsFile,
  codexHome
});
assert.equal(addTwo.accountName, "beta@example.com");

const status = await loadStatus({ accountsFile, codexHome });
assert.equal(status.savedAccountName, "beta@example.com");
assert.equal(status.email, "beta@example.com");

const imported = await importCurrentAccount({
  accountsFile,
  codexHome,
  name: "current-copy"
});
assert.equal(imported.accountName, "current-copy");

const view = await loadAccountsView({ accountsFile, codexHome });
assert.equal(view.rows.length, 3);
assert.equal(view.rows.some((row) => row.active && row.name === "current-copy"), true);

const switched = switchToAccount(
  { accountsFile, codexHome },
  "alpha@example.com"
);
assert.equal(switched.accountName, "alpha@example.com");
assert.equal(readCurrentAuth({ codexHome }).tokens.account_id, "acct-a");

const picked = await pickBestAccount({ accountsFile, codexHome });
assert.equal(picked.accountName, "beta@example.com");
assert.equal(
  picked.why.includes("resets sooner") || picked.why.includes("less 5h headroom") || picked.why.includes("weekly"),
  true
);

const emptyAccountsFile = resolveAccountsFile(path.join(tempRoot, "empty-accounts.json"));
writeAccountsStore(emptyAccountsFile, emptyStore());
const capturedLogs = [];
const originalLog = console.log;
console.log = (...args) => {
  capturedLogs.push(args.join(" "));
};
try {
  await main(["list", "--accounts-file", emptyAccountsFile, "--codex-home", codexHome]);
} finally {
  console.log = originalLog;
}
assert.equal(capturedLogs.length > 0, true);
assert.equal(capturedLogs.join("\n").includes("\"rows\": []"), true);

const capturedHelp = [];
console.log = (...args) => {
  capturedHelp.push(args.join(" "));
};
try {
  await main(["--help"]);
} finally {
  console.log = originalLog;
}
assert.equal(capturedHelp.join("\n").includes("codex-as           Open the full-screen account picker"), true);
assert.equal(capturedHelp.join("\n").includes("add                Log into a new Codex account and save it"), true);
assert.equal(capturedHelp.join("\n").includes("pick               Switch to the best available account"), true);

console.log("ok");
