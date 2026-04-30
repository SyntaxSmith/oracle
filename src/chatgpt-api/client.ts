import { randomUUID } from "node:crypto";
import {
  aggregateAssistantMessage,
  parseConversationSse,
} from "./sse.js";
import type {
  ChatGptApiAuthState,
  ChatGptApiRunInput,
  ChatGptApiRunResult,
  ChatRequirementsResponse,
  ModelsResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://chatgpt.com";

export class ChatGptApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodySnippet?: string,
    public readonly code:
      | "auth"
      | "arkose"
      | "proof-of-work"
      | "rate-limit"
      | "cloudflare"
      | "server"
      | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "ChatGptApiRequestError";
  }
}

export interface RunConversationOptions {
  baseUrl?: string;
  /** Optional refresh callback invoked once on 401 before retrying. */
  refreshAuth?: () => Promise<ChatGptApiAuthState>;
}

/**
 * Posts a single message to ChatGPT's `/backend-api/conversation` and
 * returns the aggregated assistant reply.
 *
 * Auth flow:
 *   - On 401: invokes `options.refreshAuth` once (if provided) and retries.
 *   - On 403 with arkose hints: throws ChatGptApiRequestError(code:"arkose").
 *   - On HTML response (Cloudflare bot challenge): throws code:"cloudflare".
 *
 * The caller is responsible for providing `input.sentinelToken` from a prior
 * `probeChatRequirements` call. Phase A treats the sentinel response as
 * advisory; Phase B will compute proof-of-work when required.
 */
export async function runConversation(
  input: ChatGptApiRunInput,
  options: RunConversationOptions = {},
): Promise<ChatGptApiRunResult> {
  let auth = input.auth;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const startedAt = Date.now();
    const response = await postConversation(auth, input, options.baseUrl, input.signal);
    if (response.status === 401 && attempt === 1 && options.refreshAuth) {
      auth = await options.refreshAuth();
      continue;
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw classifyError(response.status, text, response.headers);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const text = await safeReadText(response);
      throw new ChatGptApiRequestError(
        `Expected text/event-stream, got ${contentType || "unknown"}`,
        response.status,
        text.slice(0, 400),
        contentType.includes("text/html") ? "cloudflare" : "server",
      );
    }
    if (!response.body) {
      throw new ChatGptApiRequestError(
        "Empty response body from /backend-api/conversation",
        response.status,
        undefined,
        "server",
      );
    }
    return aggregateAssistantMessage(parseConversationSse(response.body), startedAt);
  }
}

/**
 * Calls /backend-api/sentinel/chat-requirements to discover which anti-bot
 * checks ChatGPT wants for the next conversation request. The returned
 * `token` is forwarded as the `OpenAI-Sentinel-Chat-Requirements-Token`
 * header in the actual conversation POST.
 */
export async function probeChatRequirements(
  auth: ChatGptApiAuthState,
  options: { baseUrl?: string; conversationModeKind?: string } = {},
): Promise<ChatRequirementsResponse> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/backend-api/sentinel/chat-requirements`;
  const body = JSON.stringify({
    conversation_mode_kind: options.conversationModeKind ?? "primary_assistant",
    p: undefined,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(auth),
    body,
  });
  if (!response.ok) {
    const text = await safeReadText(response);
    throw classifyError(response.status, text, response.headers);
  }
  return (await response.json()) as ChatRequirementsResponse;
}

/**
 * Lists the models available to the current ChatGPT account. Used by the
 * spike harness's sentinel-probe matrix.
 */
export async function fetchAvailableModels(
  auth: ChatGptApiAuthState,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<ModelsResponse> {
  const response = await fetch(`${baseUrl}/backend-api/models`, {
    method: "GET",
    headers: buildHeaders(auth),
  });
  if (!response.ok) {
    const text = await safeReadText(response);
    throw classifyError(response.status, text, response.headers);
  }
  return (await response.json()) as ModelsResponse;
}

async function postConversation(
  auth: ChatGptApiAuthState,
  input: ChatGptApiRunInput,
  baseUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const url = `${baseUrl ?? DEFAULT_BASE_URL}/backend-api/conversation`;
  const headers = buildHeaders(auth);
  headers.set("Accept", "text/event-stream");
  if (input.sentinelToken) {
    headers.set("OpenAI-Sentinel-Chat-Requirements-Token", input.sentinelToken);
  }
  const body = JSON.stringify(buildConversationBody(input));
  return fetch(url, { method: "POST", headers, body, signal });
}

function buildConversationBody(input: ChatGptApiRunInput): Record<string, unknown> {
  const messageId = randomUUID();
  return {
    action: "next",
    messages: [
      {
        id: messageId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [input.prompt] },
        metadata: {},
      },
    ],
    parent_message_id: input.parentMessageId ?? randomUUID(),
    conversation_id: input.conversationId,
    model: input.model,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezone_offset_min: -new Date().getTimezoneOffset(),
    history_and_training_disabled: false,
    suggestions: [],
    conversation_mode: { kind: "primary_assistant" },
    websocket_request_id: randomUUID(),
    force_paragen: false,
    force_rate_limit: false,
    reset_rate_limits: false,
  };
}

function buildHeaders(auth: ChatGptApiAuthState): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("Cookie", auth.cookieHeader);
  headers.set("Content-Type", "application/json");
  headers.set("Origin", "https://chatgpt.com");
  headers.set("Referer", "https://chatgpt.com/");
  headers.set("User-Agent", auth.userAgent);
  headers.set("OAI-Language", "en-US");
  if (auth.deviceId) headers.set("OAI-Device-Id", auth.deviceId);
  // sec-ch-ua-* derived from the captured UA — best-effort, ChatGPT mostly cares about User-Agent.
  const platform = derivePlatform(auth.userAgent);
  if (platform) {
    headers.set("sec-ch-ua-platform", `"${platform}"`);
  }
  headers.set("sec-ch-ua-mobile", "?0");
  return headers;
}

function derivePlatform(userAgent: string): string | undefined {
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return undefined;
}

function classifyError(
  status: number,
  text: string,
  headers: Headers,
): ChatGptApiRequestError {
  const snippet = text.slice(0, 400);
  if (status === 401) {
    return new ChatGptApiRequestError(
      "401 Unauthorized — accessToken expired or invalid.",
      status,
      snippet,
      "auth",
    );
  }
  if (status === 403) {
    if (/arkose|funcaptcha/i.test(text)) {
      return new ChatGptApiRequestError(
        "403 Forbidden — model requires solving an Arkose challenge that this engine cannot complete. Re-run with --engine browser.",
        status,
        snippet,
        "arkose",
      );
    }
    if (/proof.?of.?work|pow/i.test(text)) {
      return new ChatGptApiRequestError(
        "403 Forbidden — model requires a proof-of-work token. Phase B will compute these; for now use --engine browser.",
        status,
        snippet,
        "proof-of-work",
      );
    }
    return new ChatGptApiRequestError(
      "403 Forbidden — likely Cloudflare bot challenge. Refresh cookies via Chrome and retry.",
      status,
      snippet,
      "cloudflare",
    );
  }
  if (status === 429) {
    const retryAfter = headers.get("retry-after") ?? headers.get("x-ratelimit-reset-requests");
    return new ChatGptApiRequestError(
      `429 Too Many Requests${retryAfter ? ` (retry-after: ${retryAfter})` : ""}.`,
      status,
      snippet,
      "rate-limit",
    );
  }
  if (status >= 500) {
    return new ChatGptApiRequestError(
      `${status} ${text.slice(0, 80)}`.trim(),
      status,
      snippet,
      "server",
    );
  }
  return new ChatGptApiRequestError(
    `HTTP ${status} from ChatGPT backend: ${snippet || "(empty body)"}`,
    status,
    snippet,
    "unknown",
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
