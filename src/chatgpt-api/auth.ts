import CDP from "chrome-remote-interface";
import type { BrowserLogger, ChromeClient } from "../browser/types.js";
import type { ChatGptApiAuthState } from "./types.js";

/**
 * Captures the accessToken, cookies, deviceId, and User-Agent from a Chrome
 * instance that is already (or about to be) signed into chatgpt.com.
 *
 * The Chrome instance is the auth holder — this module never owns its
 * lifecycle. Caller decides whether to launch a fresh Chrome via
 * `src/browser/chromeLifecycle.ts:launchChrome` or to attach to an existing
 * `oracle serve` / manual-login Chrome by passing its CDP `port` (+ optional
 * `host`).
 *
 * Phase A scope: best-effort on a logged-in profile. If the page is on the
 * /auth/login route we surface a clear error so the spike harness can prompt
 * the user to sign in once before retrying.
 */
export interface AcquireAccessTokenInput {
  /** CDP debugging port (e.g. read from `~/.oracle/sessions/<id>/meta.json`). */
  port: number;
  /** CDP debugging host. Defaults to 127.0.0.1. */
  host?: string;
  /** If provided, uses this CDP target id instead of the first available page. */
  targetId?: string;
  log?: BrowserLogger;
  /** Override for testing; defaults to https://chatgpt.com. */
  baseUrl?: string;
  /** Total time we wait for cookie + token retrieval. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://chatgpt.com";
const DEFAULT_TIMEOUT_MS = 30_000;

const COOKIE_URLS = [
  "https://chatgpt.com",
  "https://auth.openai.com",
  "https://chat.openai.com",
];

const COOKIE_NAME_ALLOWLIST = new Set([
  "__Secure-next-auth.session-token",
  "__Secure-next-auth.session-token.0",
  "__Secure-next-auth.session-token.1",
  "__Secure-next-auth.callback-url",
  "__Secure-next-auth.csrf-token",
  "oai-did",
  "oai-sc",
  "oai-hm",
  "__cf_bm",
  "_cfuvid",
  "ajs_anonymous_id",
  "ajs_user_id",
  "intercom-id-dgkjq2bp",
  "intercom-session-dgkjq2bp",
]);

export class ChatGptApiAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-logged-in"
      | "no-page-target"
      | "cdp-eval-failed"
      | "fetch-failed"
      | "no-access-token"
      | "missing-cookies",
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ChatGptApiAuthError";
  }
}

export async function acquireAccessToken(
  input: AcquireAccessTokenInput,
): Promise<ChatGptApiAuthState> {
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = input.log;

  const client = await connect(input);
  const t0 = Date.now();
  try {
    await ensureChatgptOrigin(client, baseUrl, log);

    const sessionJson = await withTimeout(
      timeoutMs - (Date.now() - t0),
      evalSessionEndpoint(client, baseUrl),
      "fetch /api/auth/session",
    );
    if (typeof sessionJson !== "object" || sessionJson === null) {
      throw new ChatGptApiAuthError(
        "/api/auth/session returned a non-object response",
        "fetch-failed",
        "Confirm the Chrome page is on chatgpt.com (not /auth/login).",
      );
    }
    const accessToken = (sessionJson as Record<string, unknown>).accessToken;
    const expiresIso = (sessionJson as Record<string, unknown>).expires;
    if (typeof accessToken !== "string" || accessToken.length < 20) {
      throw new ChatGptApiAuthError(
        "No accessToken in /api/auth/session response — the Chrome profile is not logged in.",
        "not-logged-in",
        "Open chatgpt.com in this Chrome and sign in, then re-run.",
      );
    }
    const expiresAt = parseExpiry(expiresIso);

    const cookies = await readCookies(client);
    if (!cookies.cookieHeader.includes("__Secure-next-auth.session-token")) {
      throw new ChatGptApiAuthError(
        "Required cookies missing from chatgpt.com — Chrome is not signed in.",
        "missing-cookies",
        "Sign into chatgpt.com in the auth-holder Chrome.",
      );
    }

    const userAgent = await readUserAgent(client);

    const state: ChatGptApiAuthState = {
      accessToken,
      expiresAt,
      cookieHeader: cookies.cookieHeader,
      userAgent,
      deviceId: cookies.deviceId,
      acquiredAt: Date.now(),
    };
    log?.(
      `chatgpt-api auth acquired (token expires in ${Math.round((expiresAt - Date.now()) / 60000)}min, ${cookies.count} cookies)`,
    );
    return state;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Refreshes the accessToken without re-opening Chrome. Cheap CDP roundtrip,
 * relies on the same cookie jar that's already present.
 */
export async function refreshAccessToken(
  state: ChatGptApiAuthState,
  input: AcquireAccessTokenInput,
): Promise<ChatGptApiAuthState> {
  // For Phase A we just re-run the full bootstrap; the auth module's caller
  // already holds the CDP port. (Phase B authCache will short-circuit when
  // Chrome is still alive.)
  return acquireAccessToken(input).then((next) => ({
    ...next,
    // Preserve original acquisition time so callers can reason about identity.
    acquiredAt: state.acquiredAt,
  }));
}

async function connect(input: AcquireAccessTokenInput): Promise<ChromeClient> {
  const opts: CDP.Options = {
    port: input.port,
    host: input.host ?? "127.0.0.1",
  };
  if (input.targetId) {
    opts.target = input.targetId;
  }
  return CDP(opts);
}

async function ensureChatgptOrigin(
  client: ChromeClient,
  baseUrl: string,
  log?: BrowserLogger,
): Promise<void> {
  const { Page, Runtime, Network } = client;
  await Network.enable({});
  await Page.enable();
  await Runtime.enable();

  const currentUrl = (
    await Runtime.evaluate({ expression: "location.href", returnByValue: true })
  ).result?.value as string | undefined;
  if (currentUrl && currentUrl.startsWith(baseUrl)) {
    return;
  }
  log?.(`chatgpt-api: navigating Chrome tab to ${baseUrl}`);
  await Page.navigate({ url: `${baseUrl}/` });
  await waitForLoad(client, 15_000);
}

async function waitForLoad(client: ChromeClient, timeoutMs: number): Promise<void> {
  const { Page } = client;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    Page.loadEventFired().then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function evalSessionEndpoint(client: ChromeClient, baseUrl: string): Promise<unknown> {
  const { Runtime } = client;
  const expression = `(async () => {
    const res = await fetch(${JSON.stringify(`${baseUrl}/api/auth/session`)}, {
      credentials: "include",
      cache: "no-store",
      headers: { "accept": "application/json" },
    });
    if (!res.ok) {
      return { __error: true, status: res.status, body: await res.text().catch(() => "") };
    }
    return await res.json();
  })()`;
  const result = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new ChatGptApiAuthError(
      `CDP eval threw: ${result.exceptionDetails.text}`,
      "cdp-eval-failed",
    );
  }
  const value = result.result?.value;
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__error === true
  ) {
    const status = (value as Record<string, unknown>).status;
    throw new ChatGptApiAuthError(
      `/api/auth/session returned HTTP ${status}`,
      "fetch-failed",
      "If 401, the profile is not signed in. If 403, Cloudflare may be challenging — let the page settle and retry.",
    );
  }
  return value;
}

interface CookieResult {
  cookieHeader: string;
  deviceId: string;
  count: number;
}

async function readCookies(client: ChromeClient): Promise<CookieResult> {
  const { Network } = client;
  const { cookies } = await Network.getCookies({ urls: COOKIE_URLS });
  const dedup = new Map<string, string>();
  let deviceId = "";
  for (const cookie of cookies) {
    if (!COOKIE_NAME_ALLOWLIST.has(cookie.name)) continue;
    // Last-write-wins per name; chatgpt.com cookies override auth.openai.com.
    dedup.set(cookie.name, cookie.value);
    if (cookie.name === "oai-did") deviceId = cookie.value;
  }
  const cookieHeader = Array.from(dedup.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return { cookieHeader, deviceId, count: dedup.size };
}

async function readUserAgent(client: ChromeClient): Promise<string> {
  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: "navigator.userAgent",
    returnByValue: true,
  });
  const value = result.result?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new ChatGptApiAuthError(
      "Could not read navigator.userAgent from Chrome.",
      "cdp-eval-failed",
    );
  }
  return value;
}

function parseExpiry(value: unknown): number {
  if (typeof value !== "string") return Date.now() + 50 * 60_000;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return ms;
  return Date.now() + 50 * 60_000;
}

async function withTimeout<T>(
  ms: number,
  promise: Promise<T>,
  label: string,
): Promise<T> {
  if (ms <= 0) {
    throw new ChatGptApiAuthError(`Timeout exhausted before ${label}`, "fetch-failed");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ChatGptApiAuthError(`Timed out (${ms}ms) waiting for ${label}`, "fetch-failed"),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
