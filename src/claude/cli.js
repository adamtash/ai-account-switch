import {
  defaultBackupPath,
  expandHome,
  formatStatus,
  patchBinary,
  readBinary,
  resolveClaudeBinary,
  restoreBinary
} from "./patch.js";
import { patchGsd, resolveGsdBinary, restoreGsd } from "../gsd/patch.js";
import readline from "node:readline/promises";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getAccount,
  readAccountsStore,
  removeAccount,
  resolveAccountsFile,
  setActiveAccount,
  upsertAccount,
  writeAccountsStore
} from "./accounts.js";
import {
  getCredentialAccountName,
  getCredentialServiceName,
  readCurrentOauth,
  writeCurrentOauth
} from "./auth.js";
import {
  buildClaudeLoginUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  extractProfileMetadata,
  fetchUsage,
  fetchProfile,
  normalizeOauthTokens,
  normalizeUsageLimit,
  parseRedirectUrl,
  refreshTokens,
  suggestAccountName
} from "./oauth.js";

function parseArgs(argv) {
  let command = process.stdout.isTTY && process.stdin.isTTY ? "ui" : "help";
  let target;
  let backup;
  let name;
  let accountsFile;
  let backend;
  let redirectUrl;
  let port = 54545;
  let claudeConfigDir;
  let loginHint;
  let loginMethod;
  let orgUUID;

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    command = rest.shift();
  }

  let subcommand;
  if (rest[0] && !rest[0].startsWith("-")) {
    subcommand = rest.shift();
  }

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--target") {
      target = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--backup") {
      backup = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--name") {
      name = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--accounts-file") {
      accountsFile = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--backend") {
      backend = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--redirect-url") {
      redirectUrl = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--port") {
      port = Number(rest[index + 1]);
      index += 1;
      continue;
    }

    if (value === "--claude-config-dir") {
      claudeConfigDir = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--login-hint") {
      loginHint = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--login-method") {
      loginMethod = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--org-uuid") {
      orgUUID = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--help" || value === "-h") {
      command = "help";
    }
  }

  return {
    command,
    subcommand,
    target: expandHome(target),
    backup: expandHome(backup),
    name,
    accountsFile: resolveAccountsFile(expandHome(accountsFile)),
    backend,
    redirectUrl,
    port,
    claudeConfigDir: expandHome(claudeConfigDir),
    loginHint,
    loginMethod,
    orgUUID
  };
}

function normalizeCommand(command, subcommand) {
  if (command === "add") {
    return { command: "login", subcommand };
  }

  if (command === "use") {
    return { command: "switch", subcommand };
  }

  if (command === "pick") {
    return { command: "next", subcommand };
  }

  if (command === "status") {
    return { command: "current", subcommand };
  }

  if (command === "ls") {
    return { command: "list", subcommand };
  }

  if (command === "rm" || command === "remove") {
    return { command: "accounts", subcommand: "remove" };
  }

  return { command, subcommand };
}

function printHelp() {
  console.log(
    [
      "claude-as",
      "Keep Claude sessions alive while switching accounts.",
      "",
      "Default:",
      "  claude-as           Open the full-screen account picker",
      "",
      "Simple flow:",
      "  1. claude-as add",
      "  2. claude-as",
      "  3. claude-as pick",
      "  4. claude-as use --name <account>",
      "",
      "Main commands:",
      "  ui                 Open the full-screen accounts UI",
      "  patch              Patch the Claude binary once",
      "  patch-gsd          Patch the GSD runtime so account switches take effect mid-session",
      "  add                Add the current Claude account using its email",
      "  list               Show saved accounts and usage",
      "  pick               Patch Claude, then switch to the best account for the current 5h window",
      "  use --name <x>     Patch Claude, then switch to a saved account",
      "  status             Show the active Claude credential target",
      "  restore            Undo the Claude patch from backup",
      "  restore-gsd        Undo the GSD patch from backup",
      "",
      "Examples:",
      "  claude-as",
      "  claude-as add",
      "  claude-as list",
      "  claude-as pick",
      "  claude-as use --name you@example.com",
      "  claude-as import-current --name work",
      "",
      "Useful options:",
      "  --name <value>     Required for switch/import/remove; optional override for login",
      "  --target <path>    Use a specific Claude binary for patch/check/restore",
      "  --accounts-file    Use a custom accounts.json path",
      "  --redirect-url     Paste the OAuth callback URL directly",
      "  -h, --help         Show this help",
      "",
      "Advanced commands:",
      "  check              Show patch status",
      "  login              Same as: add",
      "  switch             Same as: use",
      "  next               Same as: pick",
      "  current            Same as: status",
      "  accounts remove    Remove a saved account",
      "  accounts list      Same as: list"
    ].join("\n")
  );
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function getClaudeOptions(args) {
  return {
    backend: args.backend,
    claudeConfigDir: args.claudeConfigDir
  };
}

function requireName(name, purpose) {
  if (!name) {
    throw new Error(`Missing --name for ${purpose}.`);
  }
}

function supportsColor() {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== "1");
}

function color(text, code) {
  if (!supportsColor()) {
    return text;
  }

  return `\u001b[${code}m${text}\u001b[0m`;
}

function dim(text) {
  return color(text, "2");
}

function accent(text) {
  return color(text, "36");
}

function good(text) {
  return color(text, "32");
}

function warn(text) {
  return color(text, "33");
}

function bad(text) {
  return color(text, "31");
}

function truncate(value, width) {
  if (!value) {
    return "-";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatReset(value) {
  if (!value) {
    return "reset -";
  }

  return `reset ${formatDate(value)}`;
}

function formatUsageBar(limit) {
  if (!limit) {
    return dim("[..........] n/a");
  }

  const utilization = Math.max(0, Math.min(100, Number(limit.utilization) || 0));
  const filled = Math.max(0, Math.min(10, Math.round(utilization / 10)));
  const bar = `[${"#".repeat(filled)}${".".repeat(10 - filled)}] ${utilization}%`;

  if (utilization >= 90) {
    return bad(bar);
  }

  if (utilization >= 70) {
    return warn(bar);
  }

  return good(bar);
}

function renderAccountRow(label, limit) {
  return `${label.padEnd(4, " ")} ${formatUsageBar(limit)} ${dim(formatReset(limit?.resetsAt))}`;
}

function labelValue(label, value) {
  return `  ${label.padEnd(10, " ")} ${value ?? "-"}`;
}

function printJsonFallback(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printPanel(title, lines = []) {
  console.log(accent(title));
  for (const line of lines) {
    console.log(line);
  }
}

function formatCredentialWrite(writeResult) {
  if (!writeResult) {
    return "-";
  }

  if (writeResult.backend === "keychain") {
    return `keychain (${writeResult.serviceName})`;
  }

  if (writeResult.backend === "plaintext") {
    return `plaintext (${writeResult.credentialsPath})`;
  }

  return writeResult.backend || "-";
}

function printGsdPatchResult(title, fn, action) {
  if (!process.stdout.isTTY) {
    try { printJsonFallback({ action, ...fn() }); } catch (e) { console.error(e.message); }
    return;
  }
  try {
    const result = fn();
    const status = action === "restore" ? good("restored") : result.changed ? good("patched") : warn("already patched");
    const lines = [
      labelValue("Status", status),
      labelValue("File", result.filePath),
      labelValue("Backup", result.backupPath)
    ];
    if (action === "patch") {
      lines.push(labelValue("Changed", result.changed ? "yes" : "no"));
      if (result.changed) {
        lines.push(labelValue("Effect", good("running GSD sessions will pick up new accounts immediately")));
      }
    }
    printPanel(title, lines);
  } catch (error) {
    printPanel(title, [labelValue("Error", bad(error.message))]);
  }
}

function printCheckResult(result) {
  if (!process.stdout.isTTY) {
    printJsonFallback(result);
    return;
  }

  const statusText =
    result.status === "patched"
      ? good("patched")
      : result.status === "unpatched"
        ? warn("not patched")
        : bad("unknown");

  printPanel("CLAUDE AS STATUS", [
    labelValue("Status", statusText),
    labelValue("Binary", result.binaryPath),
    labelValue("Backup", result.backupPath)
  ]);
}

function printPatchLikeResult(title, result, action) {
  if (!process.stdout.isTTY) {
    printJsonFallback({ action, ...result });
    return;
  }

  const status =
    action === "restore"
      ? good("restored")
      : result.changed
        ? good("patched")
        : warn("already patched");

  const lines = [
    labelValue("Status", status),
    labelValue("Binary", result.binaryPath),
    labelValue("Backup", result.backupPath)
  ];

  if (action === "patch") {
    lines.push(
      labelValue("Changed", result.changed ? "yes" : "no"),
      labelValue("Backup New", result.createdBackup ? "yes" : "no")
    );
    if (result.signature?.method) {
      lines.push(labelValue("Signed", result.signature.method));
    }
    if (result.changed) {
      lines.push(labelValue("Restart", warn("required once for already-running Claude sessions")));
    }
    lines.push(labelValue("Note", dim("patch targets an internal binary pattern — re-run after Claude updates if sessions stop picking up new accounts")));
  }

  printPanel(title, lines);
}

function printCurrentResult(result) {
  if (!process.stdout.isTTY) {
    printJsonFallback(result);
    return;
  }

  printPanel("CLAUDE AS CURRENT", [
    labelValue("Accounts", result.accountsFile),
    labelValue("Service", result.credentialServiceName),
    labelValue("Account", result.credentialAccountName),
    labelValue("OAuth", result.hasCurrentOauth ? good("present") : warn("missing")),
    labelValue("Expires", formatDate(result.expiresAt)),
    labelValue(
      "Scopes",
      Array.isArray(result.scopes) && result.scopes.length > 0
        ? result.scopes.join(", ")
        : "-"
    )
  ]);
}

function printAccountActionResult(title, payload, extraLines = []) {
  if (!process.stdout.isTTY) {
    printJsonFallback(payload);
    return;
  }

  const lines = [
    labelValue("Account", payload.accountName || "-"),
    labelValue("Accounts", payload.accountsFile || "-"),
    ...extraLines
  ];

  if (payload.credentialWrite) {
    lines.push(labelValue("Store", formatCredentialWrite(payload.credentialWrite)));
  }

  printPanel(title, lines);
}

function getBinaryPatchSummary(targetPath) {
  try {
    const binaryPath = resolveClaudeBinary(targetPath);
    const backupPath = defaultBackupPath(binaryPath);
    const status = formatStatus(binaryPath, readBinary(binaryPath));
    return {
      ok: true,
      binaryPath,
      backupPath,
      status: status.status
    };
  } catch (error) {
    return {
      ok: false,
      status: "unknown",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function getResetSortValue(limit) {
  if (!limit?.resetsAt) {
    return Number.POSITIVE_INFINITY;
  }

  const value = Number(limit.resetsAt);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function getUtilizationValue(limit) {
  const value = Number(limit?.utilization);
  if (!Number.isFinite(value)) {
    return -1;
  }

  return Math.max(0, Math.min(100, value));
}

export function pickNextAccount(rows) {
  const candidates = rows
    .filter((row) => {
      if (row.error || !row.fiveHour) return false;
      if (getUtilizationValue(row.fiveHour) >= 100) return false;
      if (row.weekly && getUtilizationValue(row.weekly) >= 100) return false;
      return true;
    })
    .sort((left, right) => {
      // 1. Use expiring 5h capacity first (soonest 5h reset)
      const fiveHourResetDiff = getResetSortValue(left.fiveHour) - getResetSortValue(right.fiveHour);
      if (fiveHourResetDiff !== 0) return fiveHourResetDiff;

      // 2. Higher 5h utilization first (more expiring capacity to burn)
      const fiveHourUtilDiff = getUtilizationValue(right.fiveHour) - getUtilizationValue(left.fiveHour);
      if (fiveHourUtilDiff !== 0) return fiveHourUtilDiff;

      // 3. Use expiring weekly capacity first (soonest weekly reset)
      const weeklyResetDiff = getResetSortValue(left.weekly) - getResetSortValue(right.weekly);
      if (weeklyResetDiff !== 0) return weeklyResetDiff;

      // 4. Higher weekly utilization first (more expiring weekly capacity to burn)
      const weeklyUtilDiff = getUtilizationValue(right.weekly) - getUtilizationValue(left.weekly);
      if (weeklyUtilDiff !== 0) return weeklyUtilDiff;

      return left.name.localeCompare(right.name);
    });

  if (candidates.length === 0) {
    return null;
  }

  const chosen = candidates[0];
  const second = candidates[1] || null;
  let explanation = "picked because it was the only account with available capacity";

  if (second) {
    const chosenFiveReset = getResetSortValue(chosen.fiveHour);
    const secondFiveReset = getResetSortValue(second.fiveHour);
    const chosenWeeklyReset = getResetSortValue(chosen.weekly);
    const secondWeeklyReset = getResetSortValue(second.weekly);

    if (chosenFiveReset !== secondFiveReset) {
      explanation = "picked because its 5h window resets sooner than the other available accounts";
    } else if (getUtilizationValue(chosen.fiveHour) !== getUtilizationValue(second.fiveHour)) {
      explanation = "picked because it has less 5h headroom left, so expiring capacity gets used first";
    } else if (chosenWeeklyReset !== secondWeeklyReset) {
      explanation = "picked because its weekly window resets sooner — use remaining capacity before it expires";
    } else {
      explanation = "picked because it has less weekly headroom left, so expiring capacity gets used first";
    }
  }

  return {
    row: chosen,
    reason: {
      fiveHourUtilization: getUtilizationValue(chosen.fiveHour),
      fiveHourResetsAt: chosen.fiveHour?.resetsAt || null,
      explanation
    }
  };
}

function printAccounts(view) {
  const rows = Array.isArray(view) ? view : view.rows;
  const binaryPatch = Array.isArray(view) ? null : view.binaryPatch;

  if (!process.stdout.isTTY) {
    printJsonFallback(Array.isArray(view) ? rows : view);
    return;
  }

  const activeCount = rows.filter((row) => row.active).length;
  console.log(accent("CLAUDE AS ACCOUNTS"));
  console.log(
    `${dim("accounts")} ${rows.length}  ${dim("active")} ${activeCount}`
  );
  if (binaryPatch) {
    const patchLabel =
      binaryPatch.status === "patched"
        ? good("patched")
        : binaryPatch.status === "unpatched"
          ? warn("not patched")
          : bad("unknown");
    console.log(`${dim("claude")} ${patchLabel}`);
    if (!binaryPatch.ok && binaryPatch.error) {
      console.log(`${dim("note")} ${truncate(binaryPatch.error, 72)}`);
    }
  }
  console.log("");

  if (rows.length === 0) {
    console.log(dim("No saved accounts."));
    return;
  }

  for (const row of rows) {
    const marker = row.active
      ? row.binaryPatched
        ? good("* active + patched")
        : warn("* active")
      : dim("- saved ");
    const title = row.active ? good(row.name) : accent(row.name);
    const syncState = row.error
      ? bad("usage unavailable")
      : row.refreshed
        ? warn("token refreshed")
        : good("usage loaded");

    console.log(`${marker} ${title}`);
    console.log(`  Email   ${truncate(row.email || "-", 72)}`);
    console.log(`  Updated ${formatDate(row.updatedAt)}`);
    console.log(`  ${renderAccountRow("5h", row.fiveHour)}`);
    console.log(`  ${renderAccountRow("7d", row.weekly)}`);
    console.log(`  Status  ${syncState}`);
    if (row.active) {
      console.log(
        `  Claude  ${
          row.binaryPatched
            ? good("patched")
            : row.binaryPatchStatus === "unpatched"
              ? warn("not patched")
              : bad("unknown")
        }`
      );
    }

    if (row.error) {
      console.log(`  Error   ${truncate(row.error, 72)}`);
    }

    console.log("");
  }
}

async function loadAccountUsage(account) {
  let oauth = account.oauth;
  let refreshed = false;

  if (oauth?.expiresAt && oauth?.refreshToken && oauth.expiresAt <= Date.now()) {
    const refreshedTokens = await refreshTokens({
      refreshToken: oauth.refreshToken,
      scopes: oauth.scopes
    });
    oauth = normalizeOauthTokens(refreshedTokens, null);
    refreshed = true;
  }

  try {
    const usage = await fetchUsage(oauth.accessToken);
    return {
      account: {
        ...account,
        oauth
      },
      usage: {
        fiveHour: normalizeUsageLimit(usage.five_hour),
        weekly: normalizeUsageLimit(usage.seven_day)
      },
      refreshed,
      error: null
    };
  } catch (error) {
    if (!oauth?.refreshToken || refreshed) {
      return {
        account: {
          ...account,
          oauth
        },
        usage: null,
        refreshed,
        error: error.message
      };
    }

    const refreshedTokens = await refreshTokens({
      refreshToken: oauth.refreshToken,
      scopes: oauth.scopes
    });
    const refreshedOauth = normalizeOauthTokens(refreshedTokens, null);
    const usage = await fetchUsage(refreshedOauth.accessToken);

    return {
      account: {
        ...account,
        oauth: refreshedOauth
      },
      usage: {
        fiveHour: normalizeUsageLimit(usage.five_hour),
        weekly: normalizeUsageLimit(usage.seven_day)
      },
      refreshed: true,
      error: null
    };
  }
}

export async function buildAccountsList(store, accountsFile, targetPath) {
  const binaryPatch = getBinaryPatchSummary(targetPath);
  const results = await Promise.all(
    store.accounts.map(async (account) => {
      try {
        return await loadAccountUsage(account);
      } catch (error) {
        return {
          account,
          usage: null,
          refreshed: false,
          error: error.message
        };
      }
    })
  );

  let nextStore = store;
  let changed = false;
  const refreshedByName = new Map();
  for (const result of results) {
    if (result.refreshed) {
      refreshedByName.set(result.account.name, result.account);
      changed = true;
    }
  }

  if (changed) {
    nextStore = {
      ...store,
      accounts: store.accounts.map((account) =>
        refreshedByName.get(account.name) || account
      )
    };
    writeAccountsStore(accountsFile, nextStore);
  }

  const rows = results.map((result) => {
    const active = result.account.name === nextStore.activeAccountName;
    return {
      name: result.account.name,
      active,
      email:
        result.account.profile?.emailAddress ||
        result.account.tokenAccount?.emailAddress ||
        null,
      updatedAt: result.account.updatedAt,
      fiveHour: result.usage?.fiveHour || null,
      weekly: result.usage?.weekly || null,
      refreshed: result.refreshed,
      error: result.error,
      binaryPatched: active && binaryPatch.status === "patched",
      binaryPatchStatus: active ? binaryPatch.status : null
    };
  });

  return {
    rows,
    binaryPatch
  };
}

export async function loadAccountsView(args) {
  const store = readAccountsStore(args.accountsFile);
  return buildAccountsList(store, args.accountsFile, args.target);
}

export function getCurrentState(args) {
  const oauth = readCurrentOauth(getClaudeOptions(args));
  return {
    accountsFile: args.accountsFile,
    credentialServiceName: getCredentialServiceName(getClaudeOptions(args)),
    credentialAccountName: getCredentialAccountName(),
    hasCurrentOauth: Boolean(oauth),
    expiresAt: oauth?.expiresAt || null,
    scopes: oauth?.scopes || null
  };
}

export function patchClaude(args) {
  const binaryPath = resolveClaudeBinary(args.target);
  const backupPath = args.backup || defaultBackupPath(binaryPath);
  return patchBinary(binaryPath, backupPath);
}

export function checkClaude(args) {
  const binaryPath = resolveClaudeBinary(args.target);
  const backupPath = args.backup || defaultBackupPath(binaryPath);
  const status = formatStatus(binaryPath, readBinary(binaryPath));
  return { ...status, backupPath };
}

export function restoreClaude(args) {
  const binaryPath = resolveClaudeBinary(args.target);
  const backupPath = args.backup || defaultBackupPath(binaryPath);
  return restoreBinary(binaryPath, backupPath);
}

const GSD_AGENT_AUTH_PATH = path.join(os.homedir(), ".gsd", "agent", "auth.json");

export function syncGsdAgentAuth(oauth) {
  try {
    if (!fs.existsSync(GSD_AGENT_AUTH_PATH)) {
      return false;
    }

    const raw = fs.readFileSync(GSD_AGENT_AUTH_PATH, "utf8");
    const data = JSON.parse(raw);

    if (!data.anthropic) {
      return false;
    }

    data.anthropic = {
      ...data.anthropic,
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires: oauth.expiresAt
    };

    fs.writeFileSync(GSD_AGENT_AUTH_PATH, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function switchToAccount(args, accountName) {
  const patchResult = patchClaude(args);
  const accountsFile = args.accountsFile;
  const store = readAccountsStore(accountsFile);
  const account = getAccount(store, accountName);

  if (!account) {
    throw new Error(`Account not found: ${accountName}`);
  }

  const writeResult = writeCurrentOauth(account.oauth, getClaudeOptions(args));
  const nextStore = setActiveAccount(store, account.name);
  writeAccountsStore(accountsFile, nextStore);
  const gsdSynced = syncGsdAgentAuth(account.oauth);

  return {
    action: "switch",
    accountName: account.name,
    accountsFile,
    credentialWrite: writeResult,
    patch: patchResult,
    gsdSynced
  };
}

export function removeSavedAccount(args, accountName) {
  const store = readAccountsStore(args.accountsFile);
  const nextStore = removeAccount(store, accountName);
  writeAccountsStore(args.accountsFile, nextStore);
  return {
    action: "accounts.remove",
    accountName,
    accountsFile: args.accountsFile
  };
}

export async function pickBestAccount(args) {
  const patchResult = patchClaude(args);
  const store = readAccountsStore(args.accountsFile);
  const view = await buildAccountsList(store, args.accountsFile, args.target);
  const selection = pickNextAccount(view.rows);

  if (!selection) {
    throw new Error("No switchable account found. All saved accounts are full or usage data is unavailable.");
  }

  const account = getAccount(store, selection.row.name);
  if (!account) {
    throw new Error(`Selected account not found in store: ${selection.row.name}`);
  }

  const writeResult = writeCurrentOauth(account.oauth, getClaudeOptions(args));
  const nextStore = setActiveAccount(store, account.name);
  writeAccountsStore(args.accountsFile, nextStore);
  const gsdSynced = syncGsdAgentAuth(account.oauth);

  return {
    action: "next",
    accountName: account.name,
    accountsFile: args.accountsFile,
    patch: patchResult,
    credentialWrite: writeResult,
    fiveHourUtilization: selection.reason.fiveHourUtilization,
    fiveHourResetsAt: selection.reason.fiveHourResetsAt,
    why: selection.reason.explanation,
    gsdSynced
  };
}

export async function handleLogin(args) {
  const accountsFile = args.accountsFile;
  const store = readAccountsStore(accountsFile);
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createState();
  const url = buildClaudeLoginUrl({
    codeChallenge,
    state,
    port: args.port,
    orgUUID: args.orgUUID,
    loginHint: args.loginHint,
    loginMethod: args.loginMethod
  });

  console.log("Open this URL in your browser:");
  console.log(url);
  console.log("");
  console.log(
    `After Claude redirects to http://localhost:${args.port}/callback, copy the full redirected URL and paste it here.`
  );

  const redirectInput =
    args.redirectUrl ||
    (await prompt("Redirect URL: "));
  const { code } = parseRedirectUrl(redirectInput, state);
  const tokenResponse = await exchangeCodeForTokens({
    code,
    state,
    codeVerifier,
    port: args.port
  });
  let profile = null;
  let profileWarning = null;
  try {
    profile = await fetchProfile(tokenResponse.access_token);
  } catch (error) {
    profileWarning = error.message;
  }
  const oauth = normalizeOauthTokens(tokenResponse, profile);
  const metadata = extractProfileMetadata(profile, tokenResponse);
  const suggestedName = suggestAccountName(profile, tokenResponse);
  const accountName = args.name || suggestedName;

  let nextStore = upsertAccount(store, {
    name: accountName,
    oauth,
    profile: metadata.profile,
    tokenAccount: metadata.tokenAccount
  });
  nextStore = setActiveAccount(nextStore, accountName);
  writeAccountsStore(accountsFile, nextStore);

  const writeResult = writeCurrentOauth(oauth, getClaudeOptions(args));
  printAccountActionResult(
    "CLAUDE AS LOGIN",
    {
      action: "login",
      accountName,
      accountsFile,
      credentialWrite: writeResult,
      activeAccountName: nextStore.activeAccountName,
      profileWarning
    },
    [
      labelValue("Active", nextStore.activeAccountName),
      labelValue("Warning", profileWarning || "-")
    ]
  );
}

function handleSwitch(args) {
  requireName(args.name, "switch");
  const result = switchToAccount(args, args.name);

  printAccountActionResult("CLAUDE AS SWITCH", {
    ...result
  }, [
    labelValue("Patched", result.patch.changed ? good("yes") : warn("already")),
    labelValue("Signed", result.patch.signature?.method || "-"),
    labelValue(
      "Restart",
      result.patch.changed
        ? warn("required once if Claude was already running")
        : good("not needed")
    ),
    labelValue("Note", dim("patch targets an internal binary pattern — re-run after Claude updates if sessions stop picking up new accounts")),
    ...(result.gsdSynced ? [labelValue("GSD", good("agent auth synced"))] : [])
  ]);
}

function handleImportCurrent(args) {
  requireName(args.name, "import-current");
  const oauth = readCurrentOauth(getClaudeOptions(args));

  if (!oauth) {
    throw new Error("No current Claude OAuth token found in the configured credential store.");
  }

  const accountsFile = args.accountsFile;
  const store = readAccountsStore(accountsFile);
  const nextStore = upsertAccount(store, {
    name: args.name,
    oauth
  });
  writeAccountsStore(accountsFile, nextStore);

  printAccountActionResult("CLAUDE AS IMPORT", {
    action: "import-current",
    accountName: args.name,
    accountsFile
  });
}

function handleCurrent(args) {
  printCurrentResult(getCurrentState(args));
}

async function handleAccounts(args) {
  const store = readAccountsStore(args.accountsFile);

  if (args.subcommand === "list" || !args.subcommand) {
    const view = await buildAccountsList(store, args.accountsFile, args.target);
    printAccounts(view);
    return;
  }

  if (args.subcommand === "remove") {
    requireName(args.name, "accounts remove");
    printAccountActionResult("CLAUDE AS REMOVE", removeSavedAccount(args, args.name));
    return;
  }

  throw new Error(`Unknown accounts subcommand: ${args.subcommand}`);
}

async function handleNext(args) {
  const result = await pickBestAccount(args);

  printAccountActionResult(
    "CLAUDE AS NEXT",
    {
      ...result
    },
    [
      labelValue(
        "Patched",
        result.patch.changed ? good("yes") : warn("already")
      ),
      labelValue("Signed", result.patch.signature?.method || "-"),
      labelValue(
        "Restart",
        result.patch.changed
          ? warn("required once if Claude was already running")
          : good("not needed")
      ),
      labelValue("5h Usage", `${result.fiveHourUtilization}%`),
      labelValue("5h Reset", formatDate(result.fiveHourResetsAt)),
      labelValue("Why", result.why),
      labelValue("Note", dim("patch targets an internal binary pattern — re-run after Claude updates if sessions stop picking up new accounts")),
      ...(result.gsdSynced ? [labelValue("GSD", good("agent auth synced"))] : [])
    ]
  );
}

export async function main(argv) {
  const parsed = parseArgs(argv);
  const normalized = normalizeCommand(parsed.command, parsed.subcommand);
  const args = {
    ...parsed,
    command: normalized.command,
    subcommand: normalized.subcommand
  };

  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "ui") {
    const { runAccountsUi } = await import("./ui.js");
    await runAccountsUi(args);
    return;
  }

  if (args.command === "check") {
    printCheckResult(checkClaude(args));
    return;
  }

  if (args.command === "patch") {
    printPatchLikeResult("CLAUDE AS PATCH", patchClaude(args), "patch");
    return;
  }

  if (args.command === "restore") {
    printPatchLikeResult("CLAUDE AS RESTORE", restoreClaude(args), "restore");
    return;
  }

  if (args.command === "patch-gsd") {
    printGsdPatchResult("CLAUDE AS PATCH GSD", () => patchGsd(resolveGsdBinary()), "patch");
    return;
  }

  if (args.command === "restore-gsd") {
    printGsdPatchResult("CLAUDE AS RESTORE GSD", () => restoreGsd(resolveGsdBinary()), "restore");
    return;
  }

  if (args.command === "login") {
    await handleLogin(args);
    return;
  }

  if (args.command === "switch") {
    handleSwitch(args);
    return;
  }

  if (args.command === "import-current") {
    handleImportCurrent(args);
    return;
  }

  if (args.command === "current") {
    handleCurrent(args);
    return;
  }

  if (args.command === "next") {
    await handleNext(args);
    return;
  }

  if (args.command === "list") {
    await handleAccounts({
      ...args,
      command: "accounts",
      subcommand: "list"
    });
    return;
  }

  if (args.command === "accounts") {
    await handleAccounts(args);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}
