import { spawn } from "node:child_process";
import process from "node:process";

export function resolveCodexCommand() {
  return process.env.CODEX_AS_CODEX_BIN || "codex";
}

function normalizeWindow(window) {
  if (!window) {
    return null;
  }

  return {
    utilization: Number(window.usedPercent) || 0,
    resetsAt: Number.isFinite(Number(window.resetsAt))
      ? Number(window.resetsAt) * 1000
      : null,
    windowMinutes:
      window.windowDurationMins == null ? null : Number(window.windowDurationMins)
  };
}

export function normalizeRateLimits(rateLimits) {
  if (!rateLimits) {
    return null;
  }

  return {
    planType: rateLimits.planType || null,
    limitId: rateLimits.limitId || null,
    limitName: rateLimits.limitName || null,
    credits: rateLimits.credits || null,
    primary: normalizeWindow(rateLimits.primary),
    secondary: normalizeWindow(rateLimits.secondary)
  };
}

export async function requestCodexAppServer({
  codexHome,
  requests,
  timeoutMs = 15000
}) {
  const command = resolveCodexCommand();
  const child = spawn(command, ["app-server"], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  return await new Promise((resolve, reject) => {
    const responses = new Map();
    const expectedIds = new Set([1, ...requests.map((request) => request.id)]);
    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    };

    const finish = (handler) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore shutdown races
      }
      handler();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`Timed out waiting for Codex app-server responses.`));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (message.id != null) {
          responses.set(message.id, message);
        }

        const allPresent = [...expectedIds].every((id) => responses.has(id));
        if (allPresent) {
          finish(() => {
            try {
              const result = requests.reduce((memo, request) => {
                const payload = responses.get(request.id);
                if (payload.error) {
                  throw new Error(
                    payload.error.message || `Codex app-server request failed: ${request.method}`
                  );
                }
                memo[request.method] = payload.result;
                return memo;
              }, {});
              resolve(result);
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      finish(() => {
        reject(
          new Error(
            stderr.trim() ||
              `Codex app-server exited before responding (code ${code ?? "-"}, signal ${signal ?? "-"})`
          )
        );
      });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: {
            name: "codex-as",
            version: "0.1.0"
          }
        }
      })}\n`
    );

    for (const request of requests) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          method: request.method,
          params: request.params || {}
        })}\n`
      );
    }
  });
}

export async function getCodexAccountSnapshot({ codexHome, refreshToken = false }) {
  const response = await requestCodexAppServer({
    codexHome,
    requests: [
      {
        id: 2,
        method: "account/read",
        params: {
          refreshToken
        }
      },
      {
        id: 3,
        method: "account/rateLimits/read",
        params: {}
      }
    ]
  });

  return {
    account: response["account/read"]?.account || null,
    requiresOpenaiAuth: Boolean(response["account/read"]?.requiresOpenaiAuth),
    rateLimits: normalizeRateLimits(response["account/rateLimits/read"]?.rateLimits),
    rateLimitsByLimitId: response["account/rateLimits/read"]?.rateLimitsByLimitId || null
  };
}
