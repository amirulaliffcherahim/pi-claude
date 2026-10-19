export interface ClaudeOAuthCredentialRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
}

export interface ClaudePiOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  [key: string]: unknown;
}

export interface ClaudeModelCapability {
  supported?: boolean;
}

export interface ClaudeApiModelItem {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  line?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: {
    effort?: {
      supported?: boolean;
      low?: ClaudeModelCapability;
      medium?: ClaudeModelCapability;
      high?: ClaudeModelCapability;
      xhigh?: ClaudeModelCapability;
      max?: ClaudeModelCapability;
    };
    image_input?: ClaudeModelCapability;
    thinking?: {
      supported?: boolean;
      types?: {
        enabled?: ClaudeModelCapability;
        adaptive?: ClaudeModelCapability;
        disabled?: ClaudeModelCapability;
        between_tools?: ClaudeModelCapability;
      };
    };
  };
  lifecycle?: string;
  deprecated_at?: string | null;
  retires_at?: string | null;
}

export interface ClaudeApiModelsResponse {
  data?: ClaudeApiModelItem[];
  has_more?: boolean;
}

export interface ClaudeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
  locked_reason?: string | null;
}

export interface ClaudeUsageLimitRow {
  kind: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: {
    model?: {
      display_name?: string;
    };
  } | null;
  is_active?: boolean;
}

export interface ClaudeOAuthUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_opus?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
    spend_limit_reached?: boolean;
  } | null;
  limits?: ClaudeUsageLimitRow[] | null;
  spend?: {
    used?: {
      amount_minor?: number;
      currency?: string;
      exponent?: number;
    } | null;
    limit?: number | null;
    percent?: number;
    enabled?: boolean;
  } | null;
}

export interface ClaudeDiagnostics {
  lastModel?: string;
  lastResponseModel?: string;
  lastFingerprint?: string;
  lastBillingHeader?: string;
  lastStatus?: number;
  lastLatencyMs?: number;
  lastRateLimitStatus?: string;
  lastRateLimit5h?: string;
  lastRateLimit7d?: string;
  lastError?: string;
  catalogCount?: number;
  catalogRefreshedAt?: number;
}
