import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  credentialsPath,
  isAccessTokenValid,
  isRefreshTokenExpired,
  readSharedCredentials,
  readSharedCredentialsSync,
  writeSharedCredentials,
} from "./credentials.js";
import { redactSecrets } from "./diagnostics.js";
import { acquireCredentialLock } from "./lock.js";
import type { ClaudeOAuthCredentialRecord, ClaudePiOAuthCredentials } from "./types.js";

export const CLAUDE_CODE_VERSION = "2.1.303";
export const BASE_API_URL =
  process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "") || "https://api.anthropic.com";
export const CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const PROFILE_URL = `${BASE_API_URL}/api/oauth/profile`;
export const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const CLIENT_ID =
  process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA = "oauth-2025-04-20";

export const REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

export const AUTHORIZE_SCOPES = [
  "org:create_api_key",
  ...REFRESH_SCOPES,
];

function base64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function defaultUserAgent(): string {
  return `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
}

const PLAN_TYPE_MAP = new Map<string, string>([
  ["claude_max", "max"],
  ["claude_pro", "pro"],
  ["claude_enterprise", "enterprise"],
  ["claude_team", "team"],
]);

async function fetchOAuthProfile(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
}> {
  try {
    const res = await fetch(PROFILE_URL, {
      method: "GET",
      headers: {
        "User-Agent": defaultUserAgent(),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      account?: { uuid?: string; email?: string; email_address?: string };
      organization?: {
        uuid?: string;
        organization_type?: string;
        rate_limit_tier?: string;
      };
    };
    const orgType = data.organization?.organization_type;
    return {
      subscriptionType: (orgType ? PLAN_TYPE_MAP.get(orgType) ?? orgType : null) ?? null,
      rateLimitTier: data.organization?.rate_limit_tier ?? null,
      accountUuid: data.account?.uuid,
      emailAddress: data.account?.email || data.account?.email_address,
      organizationUuid: data.organization?.uuid,
    };
  } catch {
    return {};
  }
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  signal?: AbortSignal;
}): Promise<ClaudeOAuthCredentialRecord> {
  const body = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
    state: params.state,
  };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": defaultUserAgent(),
    },
    body: JSON.stringify(body),
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = redactSecrets(await res.text().catch(() => ""));
    throw new Error(
      res.status === 401
        ? "Authentication failed: Invalid authorization code"
        : `Token exchange failed (${res.status}): ${errText.slice(0, 240)}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    scope?: string;
    account?: { uuid?: string; email_address?: string };
    organization?: { uuid?: string };
  };

  const profile = await fetchOAuthProfile(data.access_token, params.signal);
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
    refreshTokenExpiresAt:
      typeof data.refresh_token_expires_in === "number"
        ? now + data.refresh_token_expires_in * 1000
        : null,
    scopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : REFRESH_SCOPES,
    subscriptionType: profile.subscriptionType ?? "pro",
    rateLimitTier: profile.rateLimitTier ?? null,
    accountUuid: data.account?.uuid || profile.accountUuid,
    emailAddress: data.account?.email_address || profile.emailAddress,
    organizationUuid: data.organization?.uuid || profile.organizationUuid,
  };
}

export async function refreshWithGrantLock(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<ClaudeOAuthCredentialRecord> {
  const lock = await acquireCredentialLock(`${credentialsPath()}.lock`);
  try {
    // Check if another process already rotated the single-use refresh token while we waited
    const shared = await readSharedCredentials();
    if (shared && isAccessTokenValid(shared) && shared.refreshToken !== refreshToken) {
      return shared;
    }

    const tokenToUse = shared?.refreshToken || refreshToken;
    const scopes =
      Array.isArray(shared?.scopes) && shared.scopes.length > 0 ? shared.scopes : REFRESH_SCOPES;

    const body = {
      grant_type: "refresh_token",
      refresh_token: tokenToUse,
      client_id: CLIENT_ID,
      scope: scopes.join(" "),
    };

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": defaultUserAgent(),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = redactSecrets(await res.text().catch(() => ""));
      throw new Error(`Claude OAuth token refresh failed (${res.status}): ${errText.slice(0, 240)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      refresh_token_expires_in?: number;
      scope?: string;
      account?: { uuid?: string; email_address?: string };
      organization?: { uuid?: string };
    };

    const now = Date.now();
    const updated: ClaudeOAuthCredentialRecord = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || tokenToUse,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      refreshTokenExpiresAt:
        typeof data.refresh_token_expires_in === "number"
          ? now + data.refresh_token_expires_in * 1000
          : shared?.refreshTokenExpiresAt,
      scopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : scopes,
      subscriptionType: shared?.subscriptionType ?? "pro",
      rateLimitTier: shared?.rateLimitTier ?? null,
      accountUuid: data.account?.uuid || shared?.accountUuid,
      emailAddress: data.account?.email_address || shared?.emailAddress,
      organizationUuid: data.organization?.uuid || shared?.organizationUuid,
    };

    try {
      await writeSharedCredentials(updated);
    } catch {
      // Non-fatal if ~/.claude is read-only
    }
    return updated;
  } finally {
    await lock.release();
  }
}

function toPiCredentials(record: ClaudeOAuthCredentialRecord): ClaudePiOAuthCredentials {
  return {
    refresh: record.refreshToken,
    access: record.accessToken,
    expires: record.expiresAt - 5 * 60 * 1000,
    subscriptionType: record.subscriptionType,
    rateLimitTier: record.rateLimitTier,
    accountUuid: record.accountUuid,
    emailAddress: record.emailAddress,
    organizationUuid: record.organizationUuid,
  };
}

function parseCallbackInput(
  rawInput: string,
  expectedState: string,
): { code: string; state: string } {
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error("Empty authorization input");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    const error = parsed.searchParams.get("error");
    if (error) {
      throw new Error(
        `OAuth error: ${error} ${parsed.searchParams.get("error_description") || ""}`.trim(),
      );
    }
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state") || expectedState;
    if (!code) throw new Error("Missing 'code' parameter in callback URL");
    return { code, state };
  }
  // Support "code#state" format shown on platform.claude.com/oauth/code/callback
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    if (!code) throw new Error("Missing authorization code");
    return { code: code.trim(), state: state?.trim() || expectedState };
  }
  return { code: trimmed, state: expectedState };
}

function startLocalCallbackListener(expectedState: string): Promise<{
  port: number;
  redirectUri: string;
  waitForCallback: Promise<{ code: string; state: string }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveCallback!: (val: { code: string; state: string }) => void;
    let rejectCallback!: (err: Error) => void;
    const waitForCallback = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    const server: Server = createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h3>Claude authentication failed.</h3>You may close this tab.</body></html>");
        if (!settled) {
          settled = true;
          rejectCallback(
            new Error(
              `OAuth authorization failed: ${error} ${reqUrl.searchParams.get("error_description") || ""}`.trim(),
            ),
          );
        }
        return;
      }
      if (!code || !state || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h3>Invalid OAuth callback state.</h3>You may close this tab.</body></html>");
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth state mismatch or missing code in callback"));
        }
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body style='font-family:sans-serif;padding:2rem'><h2>Signed in to Claude (pi-claude)</h2><p>You can close this window and return to Pi.</p></body></html>",
      );
      if (!settled) {
        settled = true;
        resolveCallback({ code, state });
      }
    });

    server.once("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine local OAuth callback port"));
        return;
      }
      const port = address.port;
      const redirectUri = `http://localhost:${port}/callback`;
      const close = () => {
        try {
          if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          server.close();
        } catch {
          // Ignore
        }
      };
      resolve({ port, redirectUri, waitForCallback, close });
    });
  });
}

/**
 * Perform fresh browser OAuth PKCE login with Claude.ai.
 */
export async function runBrowserOAuthLogin(
  callbacks: OAuthLoginCallbacks,
): Promise<ClaudeOAuthCredentialRecord> {
  const { verifier, challenge } = generatePKCE();
  const state = base64Url(randomBytes(32));
  const listener = await startLocalCallbackListener(state);

  try {
    const authUrl = new URL(CLAUDE_AI_AUTHORIZE_URL);
    authUrl.searchParams.append("code", "true");
    authUrl.searchParams.append("client_id", CLIENT_ID);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("redirect_uri", listener.redirectUri);
    authUrl.searchParams.append("scope", AUTHORIZE_SCOPES.join(" "));
    authUrl.searchParams.append("code_challenge", challenge);
    authUrl.searchParams.append("code_challenge_method", "S256");
    authUrl.searchParams.append("state", state);

    callbacks.onAuth({
      url: authUrl.toString(),
      instructions:
        "Complete Claude sign-in in your browser. Pi captures the localhost callback automatically (or paste the callback URL if prompted).",
    });

    const candidates: Array<Promise<{ code: string; state: string }>> = [listener.waitForCallback];

    if (typeof callbacks.onPrompt === "function") {
      const manualPromise = callbacks
        .onPrompt({
          message:
            "Waiting for browser callback… (Or paste the callback URL / code here if running headless)",
          placeholder: "http://localhost:.../callback?code=...",
          allowEmpty: true,
        })
        .then((input) => {
          if (!input || !input.trim()) {
            return new Promise<{ code: string; state: string }>(() => {});
          }
          return parseCallbackInput(input, state);
        });
      candidates.push(manualPromise);
    }

    if (callbacks.signal) {
      candidates.push(
        new Promise<never>((_res, rej) => {
          if (callbacks.signal?.aborted) {
            rej(new Error("Sign-in cancelled"));
            return;
          }
          callbacks.signal?.addEventListener("abort", () => rej(new Error("Sign-in cancelled")), {
            once: true,
          });
        }),
      );
    }

    for (const c of candidates) c.catch(() => {});
    const { code, state: returnedState } = await Promise.race(candidates);
    if (returnedState !== state) {
      throw new Error("OAuth state mismatch");
    }

    const minted = await exchangeAuthorizationCode({
      code,
      state,
      codeVerifier: verifier,
      redirectUri: listener.redirectUri,
      signal: callbacks.signal,
    });

    const lock = await acquireCredentialLock(`${credentialsPath()}.lock`);
    try {
      await writeSharedCredentials(minted);
    } catch {
      // Non-fatal if ~/.claude is unavailable
    } finally {
      await lock.release();
    }

    return minted;
  } finally {
    listener.close();
  }
}

/**
 * Pi `/login claude` handler:
 * 1. Adopts an existing valid grant from `~/.claude/.credentials.json` if present (to avoid
 *    invalidating single-use refresh tokens shared with the CLI).
 * 2. Otherwise runs a full standalone OAuth 2.0 PKCE browser sign-in (`claude.com/cai/oauth/authorize`)
 *    without requiring `claude.exe` to be installed.
 */
export async function loginClaude(
  callbacks: OAuthLoginCallbacks,
): Promise<ClaudePiOAuthCredentials> {
  const existing = await readSharedCredentials().catch(() => undefined);
  if (existing && !isRefreshTokenExpired(existing)) {
    callbacks.onProgress?.("Adopting existing Claude OAuth credentials…");
    if (isAccessTokenValid(existing)) {
      const profile =
        existing.subscriptionType && existing.accountUuid
          ? {}
          : await fetchOAuthProfile(existing.accessToken, callbacks.signal);
      return toPiCredentials({
        ...existing,
        subscriptionType: existing.subscriptionType ?? profile.subscriptionType ?? "pro",
        rateLimitTier: existing.rateLimitTier ?? profile.rateLimitTier ?? null,
        accountUuid: existing.accountUuid ?? profile.accountUuid,
        emailAddress: existing.emailAddress ?? profile.emailAddress,
        organizationUuid: existing.organizationUuid ?? profile.organizationUuid,
      });
    }
    try {
      callbacks.onProgress?.("Refreshing Claude OAuth token…");
      const refreshed = await refreshWithGrantLock(existing.refreshToken, callbacks.signal);
      return toPiCredentials(refreshed);
    } catch {
      // Fall through to full PKCE browser login if the existing refresh token was revoked
    }
  }

  callbacks.onProgress?.("Starting Claude OAuth PKCE browser sign-in…");
  const minted = await runBrowserOAuthLogin(callbacks);
  return toPiCredentials(minted);
}

export async function refreshClaudeToken(
  credentials: OAuthCredentials,
): Promise<ClaudePiOAuthCredentials> {
  const refreshed = await refreshWithGrantLock(credentials.refresh);
  return toPiCredentials(refreshed);
}

export function getClaudeApiKey(credentials: OAuthCredentials): string {
  // Check if ~/.claude/.credentials.json has a fresher valid access token rotated by another process
  const shared = readSharedCredentialsSync();
  if (shared && isAccessTokenValid(shared, 60_000) && shared.expiresAt > credentials.expires) {
    return shared.accessToken;
  }
  return credentials.access;
}
