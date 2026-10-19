import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readSharedCredentialsSync } from "./credentials.js";
import { maskEmail, redactSecrets, updateDiagnostics } from "./diagnostics.js";
import { getCurrentClaudeModels, PROVIDER_ID } from "./models.js";
import { BASE_API_URL, defaultUserAgent, OAUTH_BETA } from "./oauth.js";
import type { ClaudeOAuthUsageResponse, ClaudeUsageWindow } from "./types.js";

function formatReset(resetIso: string | null | undefined): string {
  if (!resetIso) return "n/a";
  const ts = Date.parse(resetIso);
  if (!Number.isFinite(ts)) return resetIso;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function progressBar(usedFraction: number, width = 20): string {
  const remaining = Math.max(0, Math.min(1, 1 - usedFraction));
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatWindowLine(label: string, win: ClaudeUsageWindow | null | undefined): string | undefined {
  if (!win || typeof win.utilization !== "number") return undefined;
  const usedPct = Math.round(win.utilization * 1000) / 10;
  const remPct = Math.max(0, Math.round((1 - win.utilization) * 1000) / 10);
  return `  ${progressBar(win.utilization)} ${label}: ${remPct}% left (${usedPct}% used) · resets ${formatReset(win.resets_at)}`;
}

export async function fetchClaudeUsage(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ClaudeOAuthUsageResponse> {
  const res = await fetch(`${BASE_API_URL}/api/oauth/usage`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": defaultUserAgent(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });

  updateDiagnostics({ lastStatus: res.status });

  if (!res.ok) {
    const errText = redactSecrets(await res.text().catch(() => ""));
    throw new Error(`/api/oauth/usage failed (${res.status}): ${errText.slice(0, 240)}`);
  }

  return (await res.json()) as ClaudeOAuthUsageResponse;
}

export function formatClaudeUsageSummary(usage: ClaudeOAuthUsageResponse): string {
  const shared = readSharedCredentialsSync();
  const plan = shared?.subscriptionType ? shared.subscriptionType.toUpperCase() : "PRO";
  const tier = shared?.rateLimitTier ? ` (${shared.rateLimitTier})` : "";
  const email = shared?.emailAddress ? ` · ${maskEmail(shared.emailAddress)}` : "";

  const lines: string[] = [`Claude Subscription: ${plan}${tier}${email}`, ""];

  lines.push("Plan Quota Windows");
  const fiveHourLine = formatWindowLine("5-Hour Session Window", usage.five_hour);
  const sevenDayLine = formatWindowLine("7-Day Weekly Window  ", usage.seven_day);
  const opusLine = formatWindowLine("7-Day Opus Window    ", usage.seven_day_opus);
  const sonnetLine = formatWindowLine("7-Day Sonnet Window  ", usage.seven_day_sonnet);

  if (fiveHourLine) lines.push(fiveHourLine);
  if (sevenDayLine) lines.push(sevenDayLine);
  if (opusLine) lines.push(opusLine);
  if (sonnetLine) lines.push(sonnetLine);

  if (Array.isArray(usage.limits) && usage.limits.length > 0) {
    lines.push("");
    lines.push("Active Limit Buckets");
    for (const lim of usage.limits) {
      const pctUsed = typeof lim.percent === "number" ? lim.percent : 0;
      const pctLeft = Math.max(0, 100 - pctUsed);
      const modelScope = lim.scope?.model?.display_name ? ` (${lim.scope.model.display_name})` : "";
      lines.push(
        `  - ${lim.kind}${modelScope}: ${pctLeft}% left (${pctUsed}% used) · severity=${lim.severity || "normal"} · resets ${formatReset(lim.resets_at)}`,
      );
    }
  }

  if (usage.extra_usage) {
    lines.push("");
    lines.push(
      `Extra Usage Credits: ${usage.extra_usage.is_enabled ? "enabled" : "disabled (using plan limits only)"}`,
    );
  }

  return lines.join("\n");
}

export function formatClaudeModelsAvailability(usage: ClaudeOAuthUsageResponse): string {
  const models = getCurrentClaudeModels();
  const fiveHourUsed = usage.five_hour?.utilization ?? 0;
  const sevenDayUsed = usage.seven_day?.utilization ?? 0;
  const effectiveUsed = Math.max(fiveHourUsed, sevenDayUsed);
  const remPct = Math.max(0, Math.round((1 - effectiveUsed) * 1000) / 10);
  const resetStr = formatReset(usage.five_hour?.resets_at || usage.seven_day?.resets_at);
  const extraEnabled = usage.extra_usage?.is_enabled === true;

  const lines: string[] = [
    `Claude available models (${models.length} total)`,
    `planQuotaRemaining=${remPct}% · nextReset=${resetStr} · extraUsage=${extraEnabled ? "on" : "off"}`,
    "",
  ];

  const maxId = Math.max(...models.map((m) => m.id.length), 20);
  for (const m of models) {
    const isFable = m.id.includes("fable");
    const status = isFable && !extraEnabled ? "requires-credits" : `rem ${String(remPct).padStart(5)}%`;
    const ctxK = `${Math.round((m.contextWindow || 200_000) / 1000)}k`;
    const outK = `${Math.round((m.maxTokens || 64_000) / 1000)}k`;
    const levels = m.thinkingLevelMap
      ? Object.entries(m.thinkingLevelMap)
          .filter(([, v]) => v !== null)
          .map(([k]) => k)
          .join("/")
      : "adaptive";
    lines.push(
      `${m.id.padEnd(maxId)}  ${status.padEnd(16)}  ctx=${ctxK.padEnd(5)} out=${outK.padEnd(4)} [${levels}]  ${m.name}`,
    );
  }

  return lines.join("\n");
}

export async function resolveClaudeTokenFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    if (key) return key;
  } catch {
    // Fallback to shared ~/.claude/.credentials.json if present
  }
  const shared = readSharedCredentialsSync();
  return shared?.accessToken;
}
