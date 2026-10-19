import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeOAuthCredentialRecord } from "./types.js";

export function credentialsPath(): string {
  const override = process.env.PI_CLAUDE_CREDENTIALS_PATH?.trim();
  if (override) return override;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

export function credentialsFileExists(): boolean {
  return existsSync(credentialsPath());
}

export function readSharedCredentialsSync(): ClaudeOAuthCredentialRecord | undefined {
  const path = credentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      claudeAiOauth?: Partial<ClaudeOAuthCredentialRecord>;
    };
    const oauth = raw?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.refreshToken !== "string") {
      return undefined;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0,
      refreshTokenExpiresAt: oauth.refreshTokenExpiresAt,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
      subscriptionType: oauth.subscriptionType ?? null,
      rateLimitTier: oauth.rateLimitTier ?? null,
      accountUuid: oauth.accountUuid,
      emailAddress: oauth.emailAddress,
      organizationUuid: oauth.organizationUuid,
    };
  } catch {
    return undefined;
  }
}

export async function readSharedCredentials(): Promise<ClaudeOAuthCredentialRecord | undefined> {
  return readSharedCredentialsSync();
}

export async function writeSharedCredentials(
  record: ClaudeOAuthCredentialRecord,
): Promise<void> {
  const path = credentialsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  let existingRoot: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingRoot = parsed as Record<string, unknown>;
      }
    } catch {
      existingRoot = {};
    }
  }
  const existingOauth =
    existingRoot.claudeAiOauth &&
    typeof existingRoot.claudeAiOauth === "object" &&
    !Array.isArray(existingRoot.claudeAiOauth)
      ? (existingRoot.claudeAiOauth as Record<string, unknown>)
      : {};

  const nextRoot: Record<string, unknown> = {
    ...existingRoot,
    claudeAiOauth: {
      ...existingOauth,
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      expiresAt: record.expiresAt,
      ...(record.refreshTokenExpiresAt !== undefined
        ? { refreshTokenExpiresAt: record.refreshTokenExpiresAt }
        : {}),
      ...(record.scopes !== undefined ? { scopes: record.scopes } : {}),
      ...(record.subscriptionType !== undefined
        ? { subscriptionType: record.subscriptionType }
        : {}),
      ...(record.rateLimitTier !== undefined ? { rateLimitTier: record.rateLimitTier } : {}),
      ...(record.accountUuid !== undefined ? { accountUuid: record.accountUuid } : {}),
      ...(record.emailAddress !== undefined ? { emailAddress: record.emailAddress } : {}),
      ...(record.organizationUuid !== undefined
        ? { organizationUuid: record.organizationUuid }
        : {}),
    },
  };

  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(nextRoot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Windows ACL fallback
  }
  renameSync(tempPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL fallback
  }
}

export function isAccessTokenValid(
  record: ClaudeOAuthCredentialRecord | undefined,
  skewMs = 5 * 60 * 1000,
): boolean {
  if (!record || !record.accessToken) return false;
  return record.expiresAt > Date.now() + skewMs;
}

export function isRefreshTokenExpired(record: ClaudeOAuthCredentialRecord | undefined): boolean {
  if (!record || !record.refreshToken) return true;
  if (typeof record.refreshTokenExpiresAt === "number" && record.refreshTokenExpiresAt > 0) {
    return Date.now() >= record.refreshTokenExpiresAt;
  }
  return false;
}
