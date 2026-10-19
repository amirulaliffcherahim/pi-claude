import type { ClaudeDiagnostics } from "./types.js";

const state: ClaudeDiagnostics = {};

export function getDiagnostics(): Readonly<ClaudeDiagnostics> {
  return { ...state };
}

export function updateDiagnostics(patch: Partial<ClaudeDiagnostics>): void {
  Object.assign(state, patch);
}

export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-***")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer ***");
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}
