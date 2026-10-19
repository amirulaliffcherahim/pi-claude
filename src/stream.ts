import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimpleAnthropic } from "@earendil-works/pi-ai/compat";
import { readSharedCredentialsSync } from "./credentials.js";
import { redactSecrets, updateDiagnostics } from "./diagnostics.js";
import { CLAUDE_CODE_VERSION, defaultUserAgent, OAUTH_BETA } from "./oauth.js";

/**
 * Exact salt `QU` extracted from `claude.exe` v2.1.303 (`src/utils/fingerprint` @ offset 247485564).
 */
export const ATTRIBUTION_SALT = "59cf53e54c78";

/**
 * Exact 3-hex-char attribution fingerprint (`Xm` / `bAs` in `claude.exe` v2.1.303):
 * Takes characters at indices [4, 7, 20] of the first non-meta user text (falling back to `"0"`),
 * concatenates `${ATTRIBUTION_SALT}${chars}${version}`, and returns the first 3 hex chars of SHA-256.
 */
export function computeClaudeFingerprint(
  firstUserText: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const chars = [4, 7, 20].map((index) => firstUserText[index] || "0").join("");
  const input = `${ATTRIBUTION_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Construct the exact leading uncached attribution block (`QPo` in `claude.exe` v2.1.303):
 * `x-anthropic-billing-header: cc_version=2.1.303.<fp>; cc_entrypoint=cli; cch=00000;`
 */
export function buildBillingHeaderBlock(firstUserText: string): {
  fingerprint: string;
  headerText: string;
} {
  const fingerprint = computeClaudeFingerprint(firstUserText, CLAUDE_CODE_VERSION);
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
  const headerText = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${fingerprint}; cc_entrypoint=${entrypoint}; cch=00000;`;
  return { fingerprint, headerText };
}

function extractFirstUserTextFromPayload(payload: Record<string, unknown>): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as { role?: string; content?: unknown };
    if (record.role !== "user") continue;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      for (const block of record.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
      }
    }
    return "";
  }
  return "";
}

const persistentDeviceId = randomBytes(32).toString("hex");
const persistentSessionId = randomUUID();

/**
 * First-party beta flags sent by `claude.exe` v2.1.303 (`HU` table @ offset 242818531).
 */
export function getFirstPartyBetas(modelId: string): string[] {
  const betas: string[] = [];
  if (!modelId.toLowerCase().includes("haiku")) {
    betas.push("claude-code-20250219");
  }
  betas.push(
    OAUTH_BETA,
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
  );
  return betas;
}

export function streamClaude(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const startTime = Date.now();
  const callerOnPayload = options?.onPayload;
  const callerOnResponse = options?.onResponse;
  const sessionId = options?.sessionId || persistentSessionId;
  const sharedCreds = readSharedCredentialsSync();
  const accountUuid = sharedCreds?.accountUuid || "";

  updateDiagnostics({ lastModel: model.id });

  const mergedHeaders: Record<string, string> = {
    ...(options?.headers ?? {}),
    "User-Agent": defaultUserAgent(),
    "x-app": "cli",
    "X-Claude-Code-Session-Id": sessionId,
  };

  return streamSimpleAnthropic(model, context, {
    ...options,
    headers: mergedHeaders,
    onPayload: async (rawPayload, payloadModel) => {
      let payload = (
        callerOnPayload ? (await callerOnPayload(rawPayload, payloadModel)) ?? rawPayload : rawPayload
      ) as Record<string, unknown>;

      const firstUserText = extractFirstUserTextFromPayload(payload);
      const { fingerprint, headerText } = buildBillingHeaderBlock(firstUserText);
      updateDiagnostics({
        lastFingerprint: fingerprint,
        lastBillingHeader: headerText,
      });

      const billingBlock = {
        type: "text",
        text: headerText,
      };

      const existingSystem = Array.isArray(payload.system)
        ? (payload.system as Array<Record<string, unknown>>)
        : typeof payload.system === "string" && payload.system.length > 0
          ? [{ type: "text", text: payload.system }]
          : [];

      // Avoid duplicate billing header if already present
      const filteredSystem = existingSystem.filter(
        (block) =>
          !(
            typeof block?.text === "string" &&
            block.text.startsWith("x-anthropic-billing-header:")
          ),
      );

      // Ensure official CLI identity block follows billing header
      const hasIdentityBlock = filteredSystem.some(
        (block) =>
          typeof block?.text === "string" &&
          block.text.startsWith("You are Claude Code, Anthropic's official CLI for Claude"),
      );
      const identityBlock = hasIdentityBlock
        ? []
        : [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];

      const existingBetas = Array.isArray(payload.betas)
        ? (payload.betas as string[])
        : [];
      const mergedBetas = [...new Set([...getFirstPartyBetas(model.id), ...existingBetas])];

      const existingMetadata =
        payload.metadata && typeof payload.metadata === "object"
          ? (payload.metadata as Record<string, unknown>)
          : {};

      payload = {
        ...payload,
        betas: mergedBetas,
        system: [billingBlock, ...identityBlock, ...filteredSystem],
        metadata: {
          ...existingMetadata,
          user_id: JSON.stringify({
            device_id: persistentDeviceId,
            account_uuid: accountUuid,
            session_id: sessionId,
          }),
        },
      };

      return payload;
    },
    onResponse: async (responseInfo, responseModel) => {
      const headers = responseInfo.headers ?? {};
      const rlStatus =
        headers["anthropic-ratelimit-unified-status"] ||
        headers["Anthropic-Ratelimit-Unified-Status"];
      const rl5h =
        headers["anthropic-ratelimit-unified-5h-utilization"] ||
        headers["Anthropic-Ratelimit-Unified-5h-Utilization"];
      const rl7d =
        headers["anthropic-ratelimit-unified-7d-utilization"] ||
        headers["Anthropic-Ratelimit-Unified-7d-Utilization"];

      updateDiagnostics({
        lastStatus: responseInfo.status,
        lastLatencyMs: Date.now() - startTime,
        ...(rlStatus ? { lastRateLimitStatus: rlStatus } : {}),
        ...(rl5h !== undefined ? { lastRateLimit5h: rl5h } : {}),
        ...(rl7d !== undefined ? { lastRateLimit7d: rl7d } : {}),
      });

      if (callerOnResponse) {
        await callerOnResponse(responseInfo, responseModel);
      }
    },
  });
}

export function recordStreamError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  updateDiagnostics({ lastError: redactSecrets(message) });
}
