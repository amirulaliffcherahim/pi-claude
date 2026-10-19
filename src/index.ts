import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  credentialsFileExists,
  credentialsPath,
  isAccessTokenValid,
  readSharedCredentialsSync,
} from "./credentials.js";
import { getDiagnostics, maskEmail, redactSecrets } from "./diagnostics.js";
import {
  CLAUDE_API,
  discoverClaudeModels,
  getCurrentClaudeModels,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshClaudeModels,
} from "./models.js";
import {
  BASE_API_URL,
  CLAUDE_CODE_VERSION,
  defaultUserAgent,
  getClaudeApiKey,
  loginClaude,
  refreshClaudeToken,
} from "./oauth.js";
import { ATTRIBUTION_SALT, streamClaude } from "./stream.js";
import {
  fetchClaudeUsage,
  formatClaudeModelsAvailability,
  formatClaudeUsageSummary,
  resolveClaudeTokenFromContext,
} from "./usage.js";

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

type CompatApiProviderRegistrar = (provider: {
  api: typeof CLAUDE_API;
  stream: typeof streamClaude;
  streamSimple: typeof streamClaude;
}) => void;

function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register === "function") {
    register({
      api: CLAUDE_API,
      stream: streamClaude,
      streamSimple: streamClaude,
    });
  }
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  // Refresh dynamic model catalog from /v1/models on session start
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) return;
    if (typeof ctx.modelRegistry?.refresh !== "function") return;
    try {
      await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
    } catch {
      // Keep initial fallback catalog on error
    }
  });

  const providerConfig = {
    name: PROVIDER_NAME,
    baseUrl: BASE_API_URL,
    api: CLAUDE_API,
    models: getCurrentClaudeModels(),
    refreshModels: refreshClaudeModels,
    oauth: {
      name: PROVIDER_NAME,
      // Single-account OAuth stored in ~/.pi/agent/auth.json under "claude"
      // (and synced with ~/.claude/.credentials.json), enabling `/login claude` and `/logout`.
      isSubscription: true,
      login: loginClaude,
      refreshToken: refreshClaudeToken,
      getApiKey: getClaudeApiKey,
    },
    streamSimple: streamClaude,
  };

  pi.registerProvider(
    PROVIDER_ID,
    providerConfig as unknown as Parameters<typeof pi.registerProvider>[1],
  );

  // /claude-usage
  pi.registerCommand("claude-usage", {
    description: "Show Claude subscription quota windows (5-hour, 7-day, model limits)",
    handler: async (_args, ctx) => {
      const token = await resolveClaudeTokenFromContext(ctx);
      if (!token) {
        emitCommandOutput(
          ctx,
          "No Claude credentials. Run /login claude first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Fetching Claude subscription usage…", "info");
      try {
        const usage = await fetchClaudeUsage(token, ctx.signal);
        emitCommandOutput(ctx, formatClaudeUsageSummary(usage));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Claude usage failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  // /claude-models
  pi.registerCommand("claude-models", {
    description: "List Claude models + live quota availability and capabilities",
    handler: async (_args, ctx) => {
      const token = await resolveClaudeTokenFromContext(ctx);
      if (!token) {
        emitCommandOutput(
          ctx,
          "No Claude credentials. Run /login claude first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Fetching Claude models and availability…", "info");
      try {
        const [ , usage] = await Promise.all([
          discoverClaudeModels(token, ctx.signal).catch(() => getCurrentClaudeModels()),
          fetchClaudeUsage(token, ctx.signal),
        ]);
        emitCommandOutput(ctx, formatClaudeModelsAvailability(usage));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Claude models check failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  // /claude-refresh
  pi.registerCommand("claude-refresh", {
    description: "Force refresh Claude dynamic model catalog from /v1/models",
    handler: async (_args, ctx) => {
      const token = await resolveClaudeTokenFromContext(ctx);
      if (!token) {
        emitCommandOutput(
          ctx,
          "No Claude credentials. Run /login claude first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Refreshing Claude model catalog…", "info");
      try {
        if (typeof ctx.modelRegistry?.refresh === "function") {
          const result = await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
          if (result?.errors?.has(PROVIDER_ID)) {
            throw result.errors.get(PROVIDER_ID)!;
          }
        } else {
          await discoverClaudeModels(token, ctx.signal);
        }
        const models = getCurrentClaudeModels();
        const sample = models
          .slice(0, 5)
          .map((m) => m.id)
          .join(", ");
        emitCommandOutput(
          ctx,
          `Claude models refreshed (${models.length} available: ${sample}${models.length > 5 ? ", …" : ""})`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Claude model refresh failed: ${redactSecrets(msg)}`, "error");
      }
    },
  });

  // /claude-doctor
  pi.registerCommand("claude-doctor", {
    description: "Show sanitized Claude (pi-claude) provider diagnostics and health",
    handler: async (_args, ctx) => {
      const d = getDiagnostics();
      const token = await resolveClaudeTokenFromContext(ctx);
      const shared = readSharedCredentialsSync();
      const hasSharedFile = credentialsFileExists();

      let authStatus = "missing (run /login claude)";
      if (token) {
        const validShared = isAccessTokenValid(shared);
        authStatus = `authenticated (plan=${shared?.subscriptionType || "pro"}, sharedFile=${hasSharedFile ? (validShared ? "valid" : "expired/refreshable") : "none"})`;
      }

      const models = getCurrentClaudeModels();
      const lines = [
        `provider=${PROVIDER_ID}`,
        `auth=${authStatus}`,
        ...(shared?.emailAddress ? [`account=${maskEmail(shared.emailAddress)}`] : []),
        `sharedCredentialsPath=${credentialsPath()}`,
        `wireVersion=${CLAUDE_CODE_VERSION}`,
        `wireUserAgent=${defaultUserAgent()}`,
        `attributionSalt=${ATTRIBUTION_SALT} (SHA-256 [4,7,20] 3-hex)`,
        `lastBillingHeader=${d.lastBillingHeader || "none"}`,
        `catalogCount=${models.length}`,
        `catalogModels=${models.slice(0, 8).map((m) => m.id).join(", ")}${models.length > 8 ? ", …" : ""}`,
        `lastModel=${d.lastModel || "none"}`,
        `lastStatus=${d.lastStatus ?? "none"}`,
        ...(d.lastLatencyMs !== undefined ? [`lastLatencyMs=${d.lastLatencyMs}`] : []),
        ...(d.lastRateLimitStatus ? [`lastRateLimitStatus=${d.lastRateLimitStatus}`] : []),
        ...(d.lastRateLimit5h !== undefined ? [`lastRateLimit5h=${d.lastRateLimit5h}`] : []),
        ...(d.lastRateLimit7d !== undefined ? [`lastRateLimit7d=${d.lastRateLimit7d}`] : []),
        `lastError=${d.lastError ? redactSecrets(d.lastError) : "none"}`,
        "transport=native-streamSimpleAnthropic (standalone, no claude.exe required)",
        "accountMode=single-account (/login claude, /logout)",
        "commands=/claude-doctor /claude-usage /claude-models /claude-refresh",
      ];
      emitCommandOutput(ctx, `pi-claude doctor\n${lines.join("\n")}`);
    },
  });
}
