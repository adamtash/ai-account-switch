import crypto from "node:crypto";

export const CLAUDE_AI_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload"
];

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );

  return {
    codeVerifier,
    codeChallenge
  };
}

export function createState() {
  return base64Url(crypto.randomBytes(32));
}

export function getRedirectUrl(port = 54545) {
  return `http://localhost:${port}/callback`;
}

export function buildClaudeLoginUrl({
  codeChallenge,
  state,
  port = 54545,
  orgUUID,
  loginHint,
  loginMethod
}) {
  const url = new URL(CLAUDE_AI_AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", getRedirectUrl(port));
  url.searchParams.append("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.append("code_challenge", codeChallenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);

  if (orgUUID) {
    url.searchParams.append("orgUUID", orgUUID);
  }

  if (loginHint) {
    url.searchParams.append("login_hint", loginHint);
  }

  if (loginMethod) {
    url.searchParams.append("login_method", loginMethod);
  }

  return url.toString();
}

export function parseRedirectUrl(input, expectedState) {
  const url = new URL(input.trim());
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    throw new Error(errorDescription || error);
  }

  if (!code) {
    throw new Error("Authorization code not found in pasted URL.");
  }

  if (expectedState && state !== expectedState) {
    throw new Error("State mismatch in pasted URL.");
  }

  return {
    code,
    state
  };
}

export async function exchangeCodeForTokens({
  code,
  state,
  codeVerifier,
  port = 54545
}) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUrl(port),
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token exchange failed (${response.status}): ${body || response.statusText}`
    );
  }

  return response.json();
}

export async function fetchProfile(accessToken) {
  const response = await fetch(PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Profile fetch failed (${response.status}): ${body || response.statusText}`
    );
  }

  return response.json();
}

export async function refreshTokens({ refreshToken, scopes = OAUTH_SCOPES }) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: scopes.join(" ")
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Token refresh failed (${response.status}): ${body || response.statusText}`
    );
  }

  return response.json();
}

export async function fetchUsage(accessToken) {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "claude-code/2.1.76",
      "anthropic-beta": OAUTH_BETA_HEADER
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Usage fetch failed (${response.status}): ${body || response.statusText}`
    );
  }

  return response.json();
}

export function normalizeOauthTokens(tokenResponse, profile) {
  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    scopes: (tokenResponse.scope || "")
      .split(" ")
      .map((scope) => scope.trim())
      .filter(Boolean),
    subscriptionType: profile?.subscriptionType ?? null,
    rateLimitTier: profile?.rateLimitTier ?? null
  };
}

export function extractProfileMetadata(profile, tokenResponse) {
  return {
    profile: profile
      ? {
          rawProfile: profile,
          emailAddress:
            profile.account?.email ||
            tokenResponse.account?.email_address ||
            null,
          displayName: profile.account?.display_name || null,
          accountUuid: profile.account?.uuid || tokenResponse.account?.uuid || null,
          organizationUuid:
            profile.organization?.uuid ||
            tokenResponse.organization?.uuid ||
            null,
          organizationName: profile.organization?.name || null,
          subscriptionType: profile.subscriptionType ?? null,
          rateLimitTier: profile.rateLimitTier ?? null
        }
      : null,
    tokenAccount: tokenResponse.account
      ? {
          uuid: tokenResponse.account.uuid,
          emailAddress: tokenResponse.account.email_address,
          organizationUuid: tokenResponse.organization?.uuid || null
        }
      : null
  };
}

export function suggestAccountName(profile, tokenResponse) {
  return (
    profile?.account?.email ||
    tokenResponse.account?.email_address ||
    profile?.account?.display_name ||
    tokenResponse.account?.uuid ||
    `account-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
}

export function normalizeUsageLimit(limit) {
  if (!limit) {
    return null;
  }

  return {
    utilization: limit.utilization ?? null,
    resetsAt: limit.resets_at ?? null
  };
}
