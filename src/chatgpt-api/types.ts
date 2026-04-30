import type { BrowserAttachment } from "../browser/types.js";

export interface ChatGptApiAuthState {
  accessToken: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
  /** Serialized "name=value; name=value" cookie header for chatgpt.com. */
  cookieHeader: string;
  /** Captured once during bootstrap so request fingerprint matches Chrome. */
  userAgent: string;
  /** Value of the `oai-did` cookie, sent as `OAI-Device-Id` header. */
  deviceId: string;
  /** Unix ms when the auth state was acquired. */
  acquiredAt: number;
}

export interface ChatGptApiRunInput {
  prompt: string;
  /** ChatGPT server-side slug, e.g. "gpt-5-pro" — see modelSlugs.ts. */
  model: string;
  auth: ChatGptApiAuthState;
  /** Existing conversation_id to continue; omit on first turn. */
  conversationId?: string;
  /** parent_message_id for multi-turn; falls back to a fresh UUID for the first turn. */
  parentMessageId?: string;
  /** Optional file attachments via /backend-api/files (Phase B). */
  attachments?: BrowserAttachment[];
  /** AbortSignal so the harness can cancel runs. */
  signal?: AbortSignal;
  /** Sentinel/Arkose-required token from probeChatRequirements. */
  sentinelToken?: string;
}

export interface ChatGptApiRunResult {
  text: string;
  conversationId: string;
  messageId: string;
  /** Server-reported model slug (may differ from input.model when ChatGPT downgrades). */
  modelSlug?: string;
  finishReason?: string;
  tookMs: number;
  /** Raw aggregated event count, for debugging. */
  eventCount: number;
}

/** Discriminated union of relevant SSE event payloads. */
export type SseEvent =
  | { kind: "message"; payload: SseMessageFrame }
  | { kind: "patch"; payload: SsePatchFrame }
  | { kind: "moderation"; payload: unknown }
  | { kind: "tool"; payload: unknown }
  | { kind: "unknown"; raw: unknown };

export interface SseMessageFrame {
  message?: {
    id?: string;
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    metadata?: {
      model_slug?: string;
      finish_details?: { type?: string; stop_tokens?: unknown[] };
      [key: string]: unknown;
    };
    status?: string;
    end_turn?: boolean;
  };
  conversation_id?: string;
  error?: unknown;
}

export interface SsePatchFrame {
  v?: unknown;
  o?: string;
  p?: string;
  /** Newer `data: {"v":"..."}` raw-string deltas. */
  c?: string;
}

export interface ChatRequirementsResponse {
  /** Token to forward as `OpenAI-Sentinel-Chat-Requirements-Token` header. */
  token?: string;
  arkose?: { required?: boolean; dx?: string };
  turnstile?: { required?: boolean; dx?: string };
  proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
  persona?: string;
  [key: string]: unknown;
}

export interface ModelsResponse {
  models?: Array<{
    slug: string;
    title?: string;
    description?: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
  }>;
  categories?: unknown;
}
