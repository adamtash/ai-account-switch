import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIVE_AUTH_NEEDLE, MEMOIZED_AUTH_NEEDLE, inspectBinary, patchBuffer } from "../src/claude/patch.js";
import {
  emptyStore,
  getAccount,
  readAccountsStore,
  resolveAccountsFile,
  setActiveAccount,
  upsertAccount,
  writeAccountsStore
} from "../src/claude/accounts.js";
import {
  getPlaintextCredentialsPath,
  readCurrentOauth,
  writeCurrentOauth
} from "../src/claude/auth.js";
import {
  buildClaudeLoginUrl,
  createPkcePair,
  createState,
  normalizeUsageLimit,
  parseRedirectUrl
} from "../src/claude/oauth.js";
import { main, pickNextAccount } from "../src/claude/cli.js";

const fixture = Buffer.from(
  [
    "prefix",
    MEMOIZED_AUTH_NEEDLE,
    "if(process.env.CLAUDE_CODE_OAUTH_TOKEN)return{accessToken:'x'};",
    "suffix"
  ].join(""),
  "latin1"
);

const patched = patchBuffer(fixture);

assert.equal(patched.changed, true);
assert.equal(inspectBinary(patched.buffer).isPatched, true);
assert.equal(patched.buffer.toString("latin1").includes(LIVE_AUTH_NEEDLE), true);
assert.equal(patched.buffer.length, fixture.length);

const idempotent = patchBuffer(patched.buffer);
assert.equal(idempotent.changed, false);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-as-"));
const accountsFile = resolveAccountsFile(path.join(tempRoot, "accounts.json"));
let store = emptyStore();
store = upsertAccount(store, {
  name: "work",
  oauth: { accessToken: "a", refreshToken: "b", expiresAt: 1, scopes: ["x"] }
});
store = setActiveAccount(store, "work");
writeAccountsStore(accountsFile, store);
const loadedStore = readAccountsStore(accountsFile);
assert.equal(getAccount(loadedStore, "work").oauth.accessToken, "a");
assert.equal(loadedStore.activeAccountName, "work");

const claudeConfigDir = path.join(tempRoot, ".claude");
const credentialWrite = writeCurrentOauth(
  { accessToken: "token-1", refreshToken: "refresh-1", expiresAt: 10, scopes: ["user:profile"] },
  { backend: "plaintext", claudeConfigDir }
);
assert.equal(credentialWrite.backend, "plaintext");
assert.equal(fs.existsSync(getPlaintextCredentialsPath({ claudeConfigDir })), true);
assert.equal(readCurrentOauth({ backend: "plaintext", claudeConfigDir }).accessToken, "token-1");

const { codeVerifier, codeChallenge } = createPkcePair();
assert.equal(codeVerifier.length > 10, true);
assert.equal(codeChallenge.length > 10, true);
const state = createState();
const loginUrl = buildClaudeLoginUrl({ codeChallenge, state, port: 45454 });
assert.equal(
  new URL(loginUrl).searchParams.get("redirect_uri"),
  "http://localhost:45454/callback"
);
assert.equal(parseRedirectUrl(`http://localhost:45454/callback?code=abc&state=${state}`, state).code, "abc");
assert.deepEqual(normalizeUsageLimit({ utilization: 42, resets_at: 1234 }), {
  utilization: 42,
  resetsAt: 1234
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
assert.equal(
  earliestResetPick.reason.explanation.includes("resets sooner"),
  true
);
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
assert.equal(
  tieBreakPick.reason.explanation.includes("less 5h headroom"),
  true
);
assert.equal(
  pickNextAccount([
    {
      name: "full@example.com",
      error: null,
      fiveHour: { utilization: 100, resetsAt: 1000 }
    }
  ]),
  null
);

const emptyAccountsFile = resolveAccountsFile(path.join(tempRoot, "empty-accounts.json"));
writeAccountsStore(emptyAccountsFile, emptyStore());
const capturedLogs = [];
const originalLog = console.log;
console.log = (...args) => {
  capturedLogs.push(args.join(" "));
};
try {
  await main(["list", "--accounts-file", emptyAccountsFile]);
} finally {
  console.log = originalLog;
}
assert.equal(capturedLogs.length > 0, true);
assert.equal(capturedLogs.join("\n").includes("\"name\""), false);
assert.equal(capturedLogs.join("\n").includes("\"rows\": []"), true);
assert.equal(capturedLogs.join("\n").includes("\"binaryPatch\""), true);

const capturedHelp = [];
console.log = (...args) => {
  capturedHelp.push(args.join(" "));
};
try {
  await main(["--help"]);
} finally {
  console.log = originalLog;
}
assert.equal(capturedHelp.join("\n").includes("claude-as           Open the full-screen account picker"), true);
assert.equal(capturedHelp.join("\n").includes("add                Add the current Claude account using its email"), true);
assert.equal(capturedHelp.join("\n").includes("use --name <x>     Patch Claude, then switch to a saved account"), true);
assert.equal(capturedHelp.join("\n").includes("pick               Patch Claude, then switch to the best account"), true);

console.log("ok");
