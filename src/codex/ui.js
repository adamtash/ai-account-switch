import React, { useEffect, useMemo, useState } from "react";
import htm from "htm";
import { Box, Text, render, useApp, useInput } from "ink";
import {
  addAccount,
  loadAccountsView,
  pickBestAccount,
  pickNextAccount,
  removeSavedAccount,
  switchToAccount
} from "./cli.js";

const html = htm.bind(React.createElement);

function truncate(value, width) {
  if (!value) return "-";
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function utilization(limit) {
  const value = Number(limit?.utilization);
  if (!Number.isFinite(value)) return -1;
  return Math.max(0, Math.min(100, value));
}

function usageBar(limit) {
  const pct = utilization(limit);
  if (pct < 0) return "░░░░░░░░░░░░ n/a";
  const glyphs = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  let units = Math.round(((100 - pct) / 100) * 12 * 8);
  let output = "";
  for (let i = 0; i < 12; i += 1) {
    output += glyphs[Math.max(0, Math.min(8, units))];
    units -= 8;
  }
  return `${output.replaceAll(" ", "░")} ${pct}%`;
}

function tintForUsage(limit) {
  const pct = utilization(limit);
  if (pct >= 90) return "red";
  if (pct >= 70) return "yellow";
  return "green";
}

function remainingTint(remaining) {
  if (remaining === null) return "white";
  if (remaining > 50) return "green";
  if (remaining > 20) return "yellow";
  return "red";
}

function activeRemaining(rows) {
  const active = rows.find((r) => r.active);
  if (!active?.fiveHour) return null;
  const used = Math.max(0, Math.min(100, utilization(active.fiveHour)));
  return Math.round(100 - used);
}

function usageLabel(limit) {
  const pct = utilization(limit);
  if (pct < 0) return "n/a";
  if (pct >= 100) return "full";
  if (pct >= 85) return "nearly full";
  if (pct >= 60) return "busy";
  if (pct > 0) return "available";
  return "fresh";
}

function AccountsUi({ args, onLogin }) {
  const { exit } = useApp();
  const [view, setView] = useState({ rows: [] });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Loading accounts...");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const rows = view.rows || [];
  const selected = rows[selectedIndex] || null;
  const recommendation = useMemo(() => pickNextAccount(rows), [rows]);

  async function refresh(message = "Accounts refreshed") {
    setBusy(true);
    setErrorMessage("");
    try {
      const nextView = await loadAccountsView(args);
      setView(nextView);
      setSelectedIndex((i) => (nextView.rows.length === 0 ? 0 : Math.min(i, nextView.rows.length - 1)));
      setStatusMessage(message);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  useInput((input, key) => {
    if (confirmRemove) {
      if (input === "y" && selected) {
        setConfirmRemove(false);
        setBusy(true);
        setErrorMessage("");
        Promise.resolve(removeSavedAccount(args, selected.name))
          .then(() => refresh(`Removed ${selected.name}`))
          .catch((error) => { setBusy(false); setErrorMessage(error.message); });
        return;
      }
      if (input === "n" || key.escape) { setConfirmRemove(false); setStatusMessage("Remove cancelled"); }
      return;
    }

    if (key.escape || input === "q") { exit(); return; }
    if (busy) return;

    if (key.upArrow || input === "k") { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow || input === "j") { setSelectedIndex((i) => Math.max(0, Math.min(rows.length - 1, i + 1))); return; }
    if (input === "g") { setSelectedIndex(0); return; }
    if (input === "G") { setSelectedIndex(Math.max(0, rows.length - 1)); return; }
    if (input === "r") { refresh(); return; }

    if ((key.return || input === "u") && selected) {
      setBusy(true);
      setErrorMessage("");
      Promise.resolve(switchToAccount(args, selected.name))
        .then((result) => refresh(`Switched to ${result.accountName}`))
        .catch((error) => { setBusy(false); setErrorMessage(error.message); });
      return;
    }

    if (input === "n") {
      setBusy(true);
      setErrorMessage("");
      Promise.resolve(pickBestAccount(args))
        .then((result) => refresh(`Picked ${result.accountName}: ${result.why}`))
        .catch((error) => { setBusy(false); setErrorMessage(error.message); });
      return;
    }

    if (input === "a") { onLogin(); exit(); return; }

    if (input === "d" && selected) { setConfirmRemove(true); }
  });

  const remaining = activeRemaining(rows);
  const capacityText = busy ? "working..." : remaining !== null ? `5h: ${remaining}% left` : "5h: n/a";

  return html`
    <${Box} flexDirection="column" borderStyle="round" paddingX=${1}>
      <${Box} justifyContent="space-between">
        <${Text} color="cyan">codex-as<//>
        <${Text} color=${busy ? "yellow" : remainingTint(remaining)}>${capacityText}<//>
      <//>
      <${Text} dimColor>ai-account-switch  ·  github.com/adamtash/ai-account-switch<//>
      <${Text} dimColor>switch codex accounts mid-session<//>
      <${Text} dimColor>↑/↓ move  enter use  n best  r refresh  a add  d remove  q quit<//>
      ${statusMessage ? html`<${Text} color="green">${truncate(statusMessage, 80)}<//>` : null}
      ${errorMessage ? html`<${Text} color="red">${truncate(errorMessage, 80)}<//>` : null}
      ${confirmRemove ? html`<${Text} color="yellow">Confirm remove: y delete  n/esc cancel<//>` : null}
      ${rows.length === 0
        ? html`<${Text} dimColor>No saved accounts. Run: codex-as add<//>`
        : rows.map((row, index) => {
            const sel = index === selectedIndex;
            const rec = recommendation?.row.name === row.name;
            return html`
              <${Box} key=${row.name} flexDirection="column" marginTop=${1}>
                <${Box} flexDirection="row">
                  <${Text} color=${sel ? "cyan" : row.active ? "green" : "white"} bold=${sel}>
                    ${`${sel ? ">" : " "} ${row.active ? "*" : "-"} ${row.name}`}
                  <//>
                  ${rec ? html`<${Text} color="magenta" bold>  [recommended]<//>` : null}
                <//>
                <${Text} dimColor>${`    ${truncate(row.email || row.type || "-", 60)}`}<//>
                <${Text} color=${tintForUsage(row.fiveHour)}>
                  ${`    5h ${usageBar(row.fiveHour)}  ${usageLabel(row.fiveHour).padEnd(11)}  reset ${formatDate(row.fiveHour?.resetsAt)}`}
                <//>
                <${Text} color=${tintForUsage(row.weekly)}>
                  ${`    7d ${usageBar(row.weekly)}  ${usageLabel(row.weekly).padEnd(11)}  reset ${formatDate(row.weekly?.resetsAt)}`}
                <//>
                ${row.error ? html`<${Text} color="red">${`    error: ${truncate(row.error, 60)}`}<//>` : null}
              <//>
            `;
          })}
    <//>
  `;
}

export async function runAccountsUi(args) {
  while (true) {
    let doLogin = false;
    const instance = render(
      html`<${AccountsUi} args=${args} onLogin=${() => { doLogin = true; }} />`,
      { exitOnCtrlC: true }
    );
    await instance.waitUntilExit();
    if (!doLogin) break;
    await addAccount(args);
  }
}
