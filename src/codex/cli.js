import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchGsd, resolveGsdBinary, restoreGsd } from "../gsd/patch.js";
import process from "node:process";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import {
  emptyStore,
  getAccount,
  readAccountsStore,
  removeAccount,
  resolveAccountsFile,
  setActiveAccount,
  upsertAccount,
  writeAccountsStore
} from "./accounts.js";
import {
  fingerprintAuth,
  getAuthFilePath,
  readCurrentAuth,
  resolveCodexHome,
  shortFingerprint,
  writeCurrentAuth
} from "./auth.js";
import { getCodexAccountSnapshot, resolveCodexCommand } from "./rpc.js";

function parseArgs(argv) {
  let command = process.stdout.isTTY && process.stdin.isTTY ? "ui" : "help";
  let name;
  let accountsFile;
  let codexHome;
  let withApiKey = false;
  let deviceAuth = false;

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

    if (value === "--codex-home") {
      codexHome = rest[index + 1];
      index += 1;
      continue;
    }

    if (value === "--with-api-key") {
      withApiKey = true;
      continue;
    }

    if (value === "--device-auth") {
      deviceAuth = true;
      continue;
    }

    if (value === "--help" || value === "-h") {
      command = "help";
    }
  }

  return {
    command,
    subcommand,
    name,
    accountsFile: resolveAccountsFile(accountsFile),
    codexHome: codexHome ? path.resolve(codexHome) : undefined,
    withApiKey,
    deviceAuth
  };
}

function normalizeCommand(command, subcommand) {
  if (command === "login") {
    return { command: "add", subcommand };
  }

  if (command === "switch") {
    return { command: "use", subcommand };
  }

  if (command === "next") {
    return { command: "pick", subcommand };
  }

  if (command === "current") {
    return { command: "status", subcommand };
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
      "codex-as",
      "Switch Codex accounts from a full-screen terminal UI or a simple shell flow.",
      "",
      "Default:",
      "  codex-as           Open the full-screen account picker",
      "",
      "Simple flow:",
      "  1. codex-as add",
      "  2. codex-as",
      "  3. codex-as pick",
      "  4. codex-as use --name <account>",
      "",
      "Main commands:",
      "  ui                 Open the full-screen accounts UI",
      "  patch-gsd          Patch the GSD runtime so account switches take effect mid-session",
      "  add                Log into a new Codex account and save it",
      "  list               Show saved accounts and live 5h / 7d usage",
      "  pick               Switch to the best available account for the current 5h window",
      "  use --name <x>     Switch to a saved account",
      "  status             Show the current Codex auth target",
      "  import-current     Save whatever account is currently in ~/.codex/auth.json",
      "",
      "Examples:",
      "  codex-as",
      "  codex-as add",
      "  codex-as list",
      "  codex-as pick",
      "  codex-as use --name you@example.com",
      "  codex-as import-current",
      "",
      "Useful options:",
      "  --name <value>     Required for use/remove; optional override for add/import-current",
      "  --accounts-file    Use a custom accounts.json path",
      "  --codex-home       Use a custom Codex home instead of ~/.codex",
      "  --with-api-key     Pass through to codex login",
      "  --device-auth      Pass through to codex login",
      "  -h, --help         Show this help",
      "",
      "Aliases:",
      "  login              Same as: add",
      "  switch             Same as: use",
      "  next               Same as: pick",
      "  current            Same as: status",
      "  accounts remove    Remove a saved account",
      "  accounts list      Same as: list"
    ].join("\n")
  );
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

function magenta(text) {
  return color(text, "35");
}

function labelValue(label, value) {
  return `  ${label.padEnd(11, " ")} ${value ?? "-"}`;
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

function getUtilizationValue(limit) {
  const value = Number(limit?.utilization);
  if (!Number.isFinite(value)) {
    return -1;
  }

  return Math.max(0, Math.min(100, value));
}

function getResetSortValue(limit) {
  if (!limit?.resetsAt) {
    return Number.POSITIVE_INFINITY;
  }

  const value = Number(limit.resetsAt);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function usageLabel(limit) {
  if (!limit) {
    return "no data";
  }

  const utilization = getUtilizationValue(limit);
  if (utilization >= 100) {
    return "full";
  }

  if (utilization >= 85) {
    return "nearly full";
  }

  if (utilization >= 60) {
    return "busy";
  }

  if (utilization > 0) {
    return "available";
  }

  return "fresh";
}

function usageTint(limit) {
  const utilization = getUtilizationValue(limit);
  if (utilization >= 90) {
    return bad;
  }

  if (utilization >= 70) {
    return warn;
  }

  return good;
}

function meter(percent, width = 12) {
  if (!Number.isFinite(percent) || percent < 0) {
    return `${"░".repeat(width)} n/a`;
  }

  const glyphs = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  const clamped = Math.max(0, Math.min(100, percent));
  let units = Math.round(((100 - clamped) / 100) * width * 8);
  let output = "";

  for (let index = 0; index < width; index += 1) {
    const step = Math.max(0, Math.min(8, units));
    output += glyphs[step];
    units -= 8;
  }

  return `${output.replaceAll(" ", "░")} ${clamped}%`;
}

function renderUsage(label, limit) {
  const tint = usageTint(limit);
  return `${label.padEnd(4, " ")} ${tint(meter(getUtilizationValue(limit)))} ${dim(usageLabel(limit))} ${dim(formatDate(limit?.resetsAt))}`;
}

function printJsonFallback(value) {
  console.log(JSON.stringify(value, null, 2));
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
    if (action === "patch" && result.changed) {
      lines.push(labelValue("Effect", good("running GSD sessions will pick up new accounts immediately")));
    }
    printPanel(title, lines);
  } catch (error) {
    printPanel(title, [labelValue("Error", bad(error.message))]);
  }
}

function printPanel(title, lines = []) {
  console.log(accent(title));
  for (const line of lines) {
    console.log(line);
  }
}

function hashLabel(auth) {
  return shortFingerprint(auth) || "-";
}

function describeAccount(profile, auth) {
  if (profile?.type === "chatgpt" && profile.email) {
    return profile.email;
  }

  if (profile?.type === "apiKey") {
    return `api-key-${hashLabel(auth)}`;
  }

  if (auth?.tokens?.account_id) {
    return `chatgpt-${String(auth.tokens.account_id).slice(0, 8)}`;
  }

  return `account-${hashLabel(auth)}`;
}

function simplifyProfile(account) {
  if (!account) {
    return null;
  }

  return {
    type: account.type || null,
    email: account.email || null,
    planType: account.planType || null
  };
}

function buildRowFromSnapshot(storeAccount, snapshot, currentFingerprint, activeAccountName) {
  const authFingerprint = fingerprintAuth(storeAccount.auth);
  const profile = simplifyProfile(snapshot.account) || storeAccount.profile || null;
  return {
    name: storeAccount.name,
    updatedAt: storeAccount.updatedAt,
    createdAt: storeAccount.createdAt,
    active:
      authFingerprint === currentFingerprint ||
      (!currentFingerprint && storeAccount.name === activeAccountName),
    email: profile?.email || null,
    type: profile?.type || null,
    planType: profile?.planType || snapshot.rateLimits?.planType || null,
    fiveHour: snapshot.rateLimits?.primary || null,
    weekly: snapshot.rateLimits?.secondary || null,
    credits: snapshot.rateLimits?.credits || null,
    error: null
  };
}

async function withTempCodexHome(auth, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-as-"));
  try {
    if (auth) {
      writeCurrentAuth(auth, { codexHome: tempDir });
    }
    return await fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function getSnapshotForAuth(auth) {
  return await withTempCodexHome(auth, async (codexHome) =>
    getCodexAccountSnapshot({ codexHome })
  );
}

async function runCodexLogin(args) {
  const loginArgs = ["login"];
  if (args.withApiKey) {
    loginArgs.push("--with-api-key");
  }
  if (args.deviceAuth) {
    loginArgs.push("--device-auth");
  }

  return await withTempCodexHome(null, async (codexHome) => {
    const result = spawnSync(resolveCodexCommand(), loginArgs, {
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      },
      stdio: "inherit"
    });

    if (result.status !== 0) {
      throw new Error(`codex login failed.`);
    }

    const auth = readCurrentAuth({ codexHome });
    if (!auth) {
      throw new Error(`codex login completed but no auth.json was written.`);
    }

    const snapshot = await getCodexAccountSnapshot({ codexHome });
    return {
      auth,
      snapshot
    };
  });
}

function resolveSavedName(name, snapshot, auth) {
  if (name) {
    return name;
  }

  return describeAccount(simplifyProfile(snapshot.account), auth);
}

function getCurrentFingerprint(args) {
  return fingerprintAuth(readCurrentAuth({ codexHome: resolveCodexHome(args) }));
}

async function saveAccount({ args, auth, snapshot, name, setActive }) {
  const accountsFile = args.accountsFile;
  const store = readAccountsStore(accountsFile);
  const accountName = resolveSavedName(name, snapshot, auth);
  const nextStore = upsertAccount(store, {
    name: accountName,
    auth,
    profile: simplifyProfile(snapshot.account)
  });
  const finalStore = setActive ? setActiveAccount(nextStore, accountName) : nextStore;
  writeAccountsStore(accountsFile, finalStore);

  if (setActive) {
    const credentialWrite = writeCurrentAuth(auth, args);
    return {
      accountName,
      accountsFile,
      authFile: credentialWrite.authFile,
      profile: simplifyProfile(snapshot.account),
      credentialWrite,
      fiveHour: snapshot.rateLimits?.primary || null,
      weekly: snapshot.rateLimits?.secondary || null
    };
  }

  return {
    accountName,
    accountsFile,
    authFile: getAuthFilePath(args),
    profile: simplifyProfile(snapshot.account),
    fiveHour: snapshot.rateLimits?.primary || null,
    weekly: snapshot.rateLimits?.secondary || null
  };
}

function renderCurrentAccountName(store, currentFingerprint) {
  return (
    store.accounts.find((account) => fingerprintAuth(account.auth) === currentFingerprint)?.name || null
  );
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

function printAccountRows(view) {
  const rows = Array.isArray(view) ? view : view.rows;

  if (!process.stdout.isTTY) {
    printJsonFallback(Array.isArray(view) ? rows : view);
    return;
  }

  console.log(accent("CODEX AS ACCOUNTS"));
  console.log(`${dim("accounts")} ${rows.length}`);
  console.log("");

  if (rows.length === 0) {
    console.log(dim("No saved accounts."));
    return;
  }

  const recommendation = pickNextAccount(rows);
  if (recommendation) {
    console.log(magenta(`Recommended: ${recommendation.row.name}`));
    console.log(`${dim("Why")} ${recommendation.reason.explanation}`);
    console.log("");
  }

  for (const row of rows) {
    const marker = row.active ? good("* active") : dim("- saved ");
    const title = row.active ? good(row.name) : accent(row.name);
    const status = row.error ? bad(row.error) : good("live usage loaded");
    console.log(`${marker} ${title}`);
    console.log(`  Email      ${truncate(row.email || "-", 72)}`);
    console.log(`  Type       ${row.type || "-"}${row.planType ? ` / ${row.planType}` : ""}`);
    console.log(`  Updated    ${formatDate(row.updatedAt)}`);
    console.log(`  ${renderUsage("5h", row.fiveHour)}`);
    console.log(`  ${renderUsage("7d", row.weekly)}`);
    console.log(`  Status     ${status}`);
    console.log("");
  }
}

function printAccountActionResult(title, payload, extraLines = []) {
  if (!process.stdout.isTTY) {
    printJsonFallback(payload);
    return;
  }

  const lines = [
    labelValue("Account", payload.accountName || "-"),
    labelValue("Accounts", payload.accountsFile || "-"),
    labelValue("Auth File", payload.authFile || "-"),
    ...extraLines
  ];

  printPanel(title, lines);
}

function printStatus(payload) {
  if (!process.stdout.isTTY) {
    printJsonFallback(payload);
    return;
  }

  printPanel("CODEX AS STATUS", [
    labelValue("Codex Home", payload.codexHome),
    labelValue("Auth File", payload.authFile),
    labelValue("Saved Match", payload.savedAccountName || "-"),
    labelValue("Account", payload.email || payload.type || "-"),
    labelValue("Plan", payload.planType || "-"),
    labelValue("5h", payload.fiveHour ? `${meter(getUtilizationValue(payload.fiveHour))} ${usageLabel(payload.fiveHour)}` : "-"),
    labelValue("7d", payload.weekly ? `${meter(getUtilizationValue(payload.weekly))} ${usageLabel(payload.weekly)}` : "-")
  ]);
}

export async function buildAccountsList(store, args) {
  const currentFingerprint = getCurrentFingerprint(args);
  const rows = [];

  for (const account of store.accounts) {
    try {
      const snapshot = await getSnapshotForAuth(account.auth);
      rows.push(
        buildRowFromSnapshot(
          account,
          snapshot,
          currentFingerprint,
          store.activeAccountName
        )
      );
    } catch (error) {
      const authFingerprint = fingerprintAuth(account.auth);
      rows.push({
        name: account.name,
        updatedAt: account.updatedAt,
        createdAt: account.createdAt,
        active:
          authFingerprint === currentFingerprint ||
          (!currentFingerprint && account.name === store.activeAccountName),
        email: account.profile?.email || null,
        type: account.profile?.type || null,
        planType: account.profile?.planType || null,
        fiveHour: null,
        weekly: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return rows.sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export async function loadAccountsView(args) {
  const store = readAccountsStore(args.accountsFile);
  const rows = await buildAccountsList(store, args);
  return { rows };
}

export function getCurrentState(args) {
  const codexHome = resolveCodexHome(args);
  const authFile = getAuthFilePath(args);
  const store = readAccountsStore(args.accountsFile);
  const currentFingerprint = getCurrentFingerprint(args);

  return {
    codexHome,
    authFile,
    hasCurrentAuth: Boolean(currentFingerprint),
    savedAccountName: renderCurrentAccountName(store, currentFingerprint),
    authFingerprint: currentFingerprint
  };
}

export async function loadStatus(args) {
  const state = getCurrentState(args);
  if (!state.hasCurrentAuth) {
    return {
      ...state,
      type: null,
      email: null,
      planType: null,
      fiveHour: null,
      weekly: null
    };
  }

  const snapshot = await getCodexAccountSnapshot({ codexHome: state.codexHome });
  return {
    ...state,
    type: snapshot.account?.type || null,
    email: snapshot.account?.email || null,
    planType: snapshot.account?.planType || snapshot.rateLimits?.planType || null,
    fiveHour: snapshot.rateLimits?.primary || null,
    weekly: snapshot.rateLimits?.secondary || null
  };
}

export async function addAccount(args) {
  const { auth, snapshot } = await runCodexLogin(args);
  return await saveAccount({
    args,
    auth,
    snapshot,
    name: args.name,
    setActive: true
  });
}

export async function importCurrentAccount(args) {
  const auth = readCurrentAuth(args);
  if (!auth) {
    throw new Error(`No current Codex auth found at ${getAuthFilePath(args)}.`);
  }

  const snapshot = await getCodexAccountSnapshot({ codexHome: resolveCodexHome(args) });
  return await saveAccount({
    args,
    auth,
    snapshot,
    name: args.name,
    setActive: true
  });
}

export function removeSavedAccount(args, accountName) {
  const store = readAccountsStore(args.accountsFile);
  const nextStore = removeAccount(store, accountName);
  writeAccountsStore(args.accountsFile, nextStore);
  return {
    accountName,
    accountsFile: args.accountsFile
  };
}

const GSD_AGENT_AUTH_PATH = path.join(os.homedir(), ".gsd", "agent", "auth.json");

function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function syncGsdAgentAuth(auth) {
  try {
    if (!fs.existsSync(GSD_AGENT_AUTH_PATH)) {
      return false;
    }

    const raw = fs.readFileSync(GSD_AGENT_AUTH_PATH, "utf8");
    const data = JSON.parse(raw);

    if (!data["openai-codex"]) {
      return false;
    }

    const tokens = auth?.tokens || {};
    const expires = jwtExpiresAt(tokens.access_token) ?? data["openai-codex"].expires;

    data["openai-codex"] = {
      ...data["openai-codex"],
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
      accountId: tokens.account_id
    };

    fs.writeFileSync(GSD_AGENT_AUTH_PATH, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function switchToAccount(args, accountName) {
  const store = readAccountsStore(args.accountsFile);
  const account = getAccount(store, accountName);
  if (!account) {
    throw new Error(`Saved account not found: ${accountName}`);
  }

  const credentialWrite = writeCurrentAuth(account.auth, args);
  const nextStore = setActiveAccount(store, accountName);
  writeAccountsStore(args.accountsFile, nextStore);
  const gsdSynced = syncGsdAgentAuth(account.auth);

  return {
    accountName,
    accountsFile: args.accountsFile,
    authFile: credentialWrite.authFile,
    credentialWrite,
    gsdSynced
  };
}

export async function pickBestAccount(args) {
  const view = await loadAccountsView(args);
  const recommendation = pickNextAccount(view.rows);
  if (!recommendation) {
    throw new Error(`No saved account has available 5h capacity right now.`);
  }

  const result = switchToAccount(args, recommendation.row.name);
  return {
    ...result,
    why: recommendation.reason.explanation
  };
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

export async function main(argv) {
  const parsed = parseArgs(argv);
  const { command, subcommand } = normalizeCommand(parsed.command, parsed.subcommand);

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "ui") {
    const { runAccountsUi } = await import("./ui.js");
    await runAccountsUi(parsed);
    return;
  }

  if (command === "patch-gsd") {
    printGsdPatchResult("CODEX AS PATCH GSD", () => patchGsd(resolveGsdBinary()), "patch");
    return;
  }

  if (command === "restore-gsd") {
    printGsdPatchResult("CODEX AS RESTORE GSD", () => restoreGsd(resolveGsdBinary()), "restore");
    return;
  }

  if (command === "add") {
    const result = await addAccount(parsed);
    printAccountActionResult("CODEX AS ADDED", result, [
      labelValue("Picked Name", result.accountName),
      labelValue("5h", result.fiveHour ? `${meter(getUtilizationValue(result.fiveHour))} ${usageLabel(result.fiveHour)}` : "-"),
      labelValue("7d", result.weekly ? `${meter(getUtilizationValue(result.weekly))} ${usageLabel(result.weekly)}` : "-")
    ]);
    return;
  }

  if (command === "import-current") {
    const result = await importCurrentAccount(parsed);
    printAccountActionResult("CODEX AS IMPORTED", result, [
      labelValue("Picked Name", result.accountName)
    ]);
    return;
  }

  if (command === "list" || (command === "accounts" && subcommand === "list")) {
    const view = await loadAccountsView(parsed);
    printAccountRows(view);
    return;
  }

  if (command === "status") {
    const status = await loadStatus(parsed);
    printStatus(status);
    return;
  }

  if (command === "use") {
    requireName(parsed.name, "use");
    const result = switchToAccount(parsed, parsed.name);
    printAccountActionResult("CODEX AS ACTIVE", result, [
      ...(result.gsdSynced ? [labelValue("GSD", good("agent auth synced"))] : [])
    ]);
    return;
  }

  if (command === "pick") {
    const result = await pickBestAccount(parsed);
    printAccountActionResult("CODEX AS PICKED", result, [
      labelValue("Why", result.why),
      ...(result.gsdSynced ? [labelValue("GSD", good("agent auth synced"))] : [])
    ]);
    return;
  }

  if (command === "accounts" && subcommand === "remove") {
    let accountName = parsed.name;
    if (!accountName && process.stdout.isTTY && process.stdin.isTTY) {
      accountName = await prompt("Account name to remove: ");
    }
    requireName(accountName, "remove");
    const result = removeSavedAccount(parsed, accountName);
    printAccountActionResult("CODEX AS REMOVED", result);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
