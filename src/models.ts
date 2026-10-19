import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { updateDiagnostics } from "./diagnostics.js";
import { BASE_API_URL, CLAUDE_CODE_VERSION, defaultUserAgent, OAUTH_BETA } from "./oauth.js";
import type { ClaudeApiModelItem, ClaudeApiModelsResponse } from "./types.js";

export const PROVIDER_ID = "claude";
export const PROVIDER_NAME = "claude";
export const CLAUDE_API = "claude-code-messages";

/**
 * Curated static fallback catalog built from Pi's official Anthropic model definitions,
 * rebound to provider `"claude"` and custom API `"claude-code-messages"`.
 */
export function buildInitialClaudeModels(): ProviderModelConfig[] {
  const preferredOrder = [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-haiku-4-5",
  ];

  let allEntries: ProviderModelConfig[] = [];
  try {
    allEntries = (getBuiltinModels("anthropic") ?? []) as unknown as ProviderModelConfig[];
  } catch {
    allEntries = [];
  }
  const byId = new Map<string, ProviderModelConfig>();
  for (const entry of allEntries) {
    byId.set(entry.id, {
      ...entry,
      name: `${entry.name.replace(/\s*\(latest\)\s*/i, "")} (claude)`,
      api: CLAUDE_API,
    });
  }

  const ordered: ProviderModelConfig[] = [];
  for (const id of preferredOrder) {
    const found = byId.get(id);
    if (found) {
      ordered.push(found);
      byId.delete(id);
    }
  }
  for (const remaining of byId.values()) {
    ordered.push(remaining);
  }
  return ordered;
}

let currentModels: ProviderModelConfig[] = buildInitialClaudeModels();

export function getCurrentClaudeModels(): ProviderModelConfig[] {
  return currentModels;
}

export function setCurrentClaudeModels(models: ProviderModelConfig[]): void {
  if (models.length > 0) {
    currentModels = models;
    updateDiagnostics({
      catalogCount: models.length,
      catalogRefreshedAt: Date.now(),
    });
  }
}

function defaultCostForLine(line?: string, id?: string): ProviderModelConfig["cost"] {
  const key = (line || id || "").toLowerCase();
  if (key.includes("fable")) {
    return { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
  }
  if (key.includes("opus-5-5")) {
    return { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
  }
  if (key.includes("opus")) {
    return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  }
  if (key.includes("sonnet-5")) {
    return { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  }
  if (key.includes("haiku-5-5")) {
    return { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
  }
  if (key.includes("haiku")) {
    return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  }
  return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
}

function mapApiModelToProviderConfig(
  item: ClaudeApiModelItem,
  fallbackMap: Map<string, ProviderModelConfig>,
): ProviderModelConfig {
  const existing = fallbackMap.get(item.id);
  const effortCap = item.capabilities?.effort;
  const thinkingTypes = item.capabilities?.thinking?.types;
  const adaptiveSupported = thinkingTypes?.adaptive?.supported === true;
  const disabledSupported = thinkingTypes?.disabled?.supported !== false;

  let thinkingLevelMap = existing?.thinkingLevelMap;
  if (!thinkingLevelMap && effortCap?.supported) {
    thinkingLevelMap = {
      off: disabledSupported ? undefined : null,
      minimal: null,
      low: effortCap.low?.supported ? "low" : null,
      medium: effortCap.medium?.supported ? "medium" : null,
      high: effortCap.high?.supported ? "high" : null,
      xhigh: effortCap.xhigh?.supported ? "xhigh" : null,
      max: effortCap.max?.supported ? "max" : null,
    };
  }

  return {
    ...(existing ?? {}),
    id: item.id,
    name: `${item.display_name || item.id} (claude)`,
    api: CLAUDE_API,
    reasoning: item.capabilities?.thinking?.supported ?? existing?.reasoning ?? true,
    input:
      item.capabilities?.image_input?.supported !== false
        ? ["text", "image"]
        : ["text"],
    cost: existing?.cost ?? defaultCostForLine(item.line, item.id),
    contextWindow: item.max_input_tokens ?? existing?.contextWindow ?? 200_000,
    maxTokens: item.max_tokens ?? existing?.maxTokens ?? 64_000,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: existing?.compat ?? {
      ...(adaptiveSupported ? { forceAdaptiveThinking: true } : {}),
      supportsStrictTools: true,
    },
  };
}

/**
 * Fetch live model catalog from `GET https://api.anthropic.com/v1/models`
 * using the signed-in Claude OAuth token and first-party CLI headers.
 */
export async function discoverClaudeModels(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ProviderModelConfig[]> {
  const res = await fetch(`${BASE_API_URL}/v1/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": `claude-code-20250219,${OAUTH_BETA}`,
      "User-Agent": defaultUserAgent(),
      "x-app": "cli",
      Accept: "application/json",
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`/v1/models failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as ClaudeApiModelsResponse;
  const items = Array.isArray(body.data) ? body.data : [];
  if (items.length === 0) {
    return getCurrentClaudeModels();
  }

  const fallbackList = buildInitialClaudeModels();
  const fallbackMap = new Map(fallbackList.map((m) => [m.id, m]));
  const discovered: ProviderModelConfig[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    seen.add(item.id);
    discovered.push(mapApiModelToProviderConfig(item, fallbackMap));
  }

  // Retain aliases (like claude-sonnet-4-5, claude-opus-4-5, claude-haiku-4-5) if not in raw list
  for (const fb of fallbackList) {
    if (!seen.has(fb.id)) {
      discovered.push(fb);
    }
  }

  setCurrentClaudeModels(discovered);
  return discovered;
}

export async function refreshClaudeModels(
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  const current = getCurrentClaudeModels();

  // If cached state exists from a previous session, restore it synchronously
  if (context.stored && isRecord(context.stored)) {
    const persisted = context.stored.models;
    if (Array.isArray(persisted) && persisted.length > 0) {
      setCurrentClaudeModels(persisted as unknown as ProviderModelConfig[]);
    }
  }

  // Publish baseline catalog to modelsStore so models survive across restarts and offline
  if (typeof context.publish === "function") {
    try {
      await context.publish({
        persist: {
          models: getCurrentClaudeModels() as unknown as StoredModelConfig[],
          checkedAt: Date.now(),
        } as unknown as ModelsStoreEntry,
        update: () => {
          // Model catalog synced
        },
      });
    } catch {
      // Best-effort publication
    }
  }

  if (!context.allowNetwork || context.signal.aborted) {
    return getCurrentClaudeModels();
  }
  const token =
    context.credential?.type === "oauth"
      ? context.credential.access
      : context.credential?.type === "api_key"
        ? context.credential.key
        : undefined;
  if (!token) {
    return getCurrentClaudeModels();
  }
  try {
    const discovered = await discoverClaudeModels(token, context.signal);
    if (typeof context.publish === "function" && discovered.length > 0) {
      await context.publish({
        persist: {
          models: discovered as unknown as StoredModelConfig[],
          checkedAt: Date.now(),
        } as unknown as ModelsStoreEntry,
      });
    }
    return discovered;
  } catch (error) {
    if (context.force) throw error;
    return getCurrentClaudeModels();
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

type StoredModelConfig = Record<string, unknown>;
