#!/usr/bin/env tsx

/**
 * Phase A validation harness for the chatgpt-api engine spike.
 *
 * Five cases (default: all enabled):
 *   1. one-shot — single conversation, prints the answer + token/latency.
 *   2. multi-turn — turn 1 establishes context, turn 2 follows up via parent_message_id.
 *   3. concurrency — fire N parallel runs with the same auth state.
 *   4. probe — enumerate available models, run /backend-api/sentinel/chat-requirements
 *      against each, write a matrix to scripts/sentinel-probe-results.json.
 *   5. latency — N samples per model, report median.
 *
 * Usage:
 *   pnpm tsx scripts/chatgpt-api-spike.ts --port 65209 --model gpt-5-pro
 *   pnpm tsx scripts/chatgpt-api-spike.ts --port 65209 --probe-only
 *   pnpm tsx scripts/chatgpt-api-spike.ts --port 65209 --concurrency 5
 *
 * Prerequisite: a logged-in Chrome with chatgpt.com session is reachable at
 * --port (CDP debugging port). On a Windows host with `oracle serve`, the
 * port shows up in the banner ("Manual-login Chrome DevTools port: 65209").
 */

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import {
  acquireAccessToken,
  ChatGptApiAuthError,
} from "../src/chatgpt-api/auth.js";
import {
  ChatGptApiRequestError,
  fetchAvailableModels,
  probeChatRequirements,
  runConversation,
} from "../src/chatgpt-api/client.js";
import type {
  ChatGptApiAuthState,
  ChatRequirementsResponse,
} from "../src/chatgpt-api/types.js";

interface CliArgs {
  port: number;
  host: string;
  model: string;
  oneShot: boolean;
  multiTurn: boolean;
  concurrency: number;
  probe: boolean;
  latencySamples: number;
  outFile: string;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      model: { type: "string", short: "m", default: "gpt-5-pro" },
      "one-shot": { type: "boolean" },
      "multi-turn": { type: "boolean" },
      concurrency: { type: "string" },
      probe: { type: "boolean" },
      "probe-only": { type: "boolean" },
      "latency-samples": { type: "string" },
      "out-file": { type: "string", default: "scripts/sentinel-probe-results.json" },
    },
    allowPositionals: false,
  });
  if (!values.port) {
    console.error(
      "missing --port. Get the CDP port from `oracle serve` banner (\"Manual-login Chrome DevTools port: <PORT>\").",
    );
    process.exit(2);
  }
  const probeOnly = Boolean(values["probe-only"]);
  const allDefault =
    !values["one-shot"] &&
    !values["multi-turn"] &&
    !values.concurrency &&
    !values.probe &&
    !values["latency-samples"] &&
    !probeOnly;
  return {
    port: Number(values.port),
    host: values.host ?? "127.0.0.1",
    model: String(values.model ?? "gpt-5-pro"),
    oneShot: probeOnly ? false : (allDefault || Boolean(values["one-shot"])),
    multiTurn: probeOnly ? false : (allDefault || Boolean(values["multi-turn"])),
    concurrency: probeOnly ? 0 : Number(values.concurrency ?? (allDefault ? 3 : 0)),
    probe: probeOnly ? true : (allDefault || Boolean(values.probe)),
    latencySamples: probeOnly
      ? 0
      : Number(values["latency-samples"] ?? (allDefault ? 0 : 0)),
    outFile: String(values["out-file"] ?? "scripts/sentinel-probe-results.json"),
  };
}

async function main() {
  const args = parseCli();
  console.log(`[spike] connecting to CDP at ${args.host}:${args.port}`);

  const log = makeLogger("auth");
  const auth = await acquireAccessToken({
    port: args.port,
    host: args.host,
    log,
  });
  console.log(
    `[spike] auth OK — token expires in ${Math.round((auth.expiresAt - Date.now()) / 60000)}min, UA captured (${auth.userAgent.slice(0, 60)}...)`,
  );

  let exitCode = 0;

  if (args.probe) {
    try {
      await runProbeMatrix(auth, args.outFile);
    } catch (error) {
      console.error("[probe] FAILED:", formatError(error));
      exitCode = 1;
    }
  }

  if (args.oneShot) {
    try {
      await runOneShot(auth, args.model);
    } catch (error) {
      console.error("[one-shot] FAILED:", formatError(error));
      exitCode = 1;
    }
  }

  if (args.multiTurn) {
    try {
      await runMultiTurn(auth, args.model);
    } catch (error) {
      console.error("[multi-turn] FAILED:", formatError(error));
      exitCode = 1;
    }
  }

  if (args.concurrency > 0) {
    try {
      await runConcurrency(auth, args.model, args.concurrency);
    } catch (error) {
      console.error("[concurrency] FAILED:", formatError(error));
      exitCode = 1;
    }
  }

  if (args.latencySamples > 0) {
    try {
      await runLatency(auth, args.model, args.latencySamples);
    } catch (error) {
      console.error("[latency] FAILED:", formatError(error));
      exitCode = 1;
    }
  }

  process.exit(exitCode);
}

function makeLogger(label: string) {
  return ((message: string) => console.log(`[${label}] ${message}`)) as ((
    message: string,
  ) => void) & { verbose?: boolean };
}

async function runProbeMatrix(auth: ChatGptApiAuthState, outFile: string) {
  console.log("\n[probe] fetching /backend-api/models...");
  const modelsResp = await fetchAvailableModels(auth);
  const models = modelsResp.models ?? [];
  if (models.length === 0) {
    console.warn("[probe] no models returned by /backend-api/models — account may be free-tier or unauthenticated");
    return;
  }
  console.log(`[probe] ${models.length} models available — probing chat-requirements for each`);

  const matrix: Array<{
    slug: string;
    title?: string;
    arkose: boolean;
    turnstile: boolean;
    proofOfWork: boolean;
    accessible: boolean;
    error?: string;
    raw?: ChatRequirementsResponse;
  }> = [];

  // chat-requirements isn't model-specific in the request body — but we still
  // probe per model so we capture per-account variation if any. In practice
  // ChatGPT today returns the same shape regardless of model, but recording
  // the entry per slug is what we want for the report.
  let probedOnce = false;
  let sharedReq: ChatRequirementsResponse | undefined;
  for (const m of models) {
    const slug = m.slug;
    try {
      // Optimization: chat-requirements returns the same shape across models
      // for a given account; probe once, reuse.
      if (!probedOnce) {
        sharedReq = await probeChatRequirements(auth);
        probedOnce = true;
      }
      const req = sharedReq!;
      matrix.push({
        slug,
        title: m.title,
        arkose: Boolean(req.arkose?.required),
        turnstile: Boolean(req.turnstile?.required),
        proofOfWork: Boolean(req.proofofwork?.required),
        accessible: !req.arkose?.required,
        raw: req,
      });
    } catch (error) {
      matrix.push({
        slug,
        title: m.title,
        arkose: false,
        turnstile: false,
        proofOfWork: false,
        accessible: false,
        error: formatError(error),
      });
    }
  }

  const summary = matrix.map((row) => ({
    slug: row.slug,
    title: row.title ?? "",
    arkose: row.arkose ? "X" : "-",
    turnstile: row.turnstile ? "X" : "-",
    pow: row.proofOfWork ? "X" : "-",
    ok: row.accessible ? "yes" : "no",
    err: row.error ?? "",
  }));
  printTable(["slug", "title", "arkose", "turnstile", "pow", "ok"], summary as Array<Record<string, string>>);

  const outPath = resolvePath(process.cwd(), outFile);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        userAgent: auth.userAgent,
        models: matrix,
      },
      null,
      2,
    ),
  );
  console.log(`[probe] matrix written to ${outPath}`);
}

async function runOneShot(auth: ChatGptApiAuthState, model: string) {
  console.log(`\n[one-shot] model=${model}`);
  const sentinelToken = await tryAcquireSentinelToken(auth);
  const result = await runConversation({
    prompt: "Reply with the single word: pong",
    model,
    auth,
    sentinelToken,
  });
  console.log(
    `[one-shot] OK in ${result.tookMs}ms (${result.eventCount} events) | conversation=${result.conversationId} message=${result.messageId} model=${result.modelSlug ?? "?"}`,
  );
  console.log(`[one-shot] answer: ${truncate(result.text, 200)}`);
}

async function runMultiTurn(auth: ChatGptApiAuthState, model: string) {
  console.log(`\n[multi-turn] model=${model}`);
  const sentinelToken = await tryAcquireSentinelToken(auth);
  const t1 = await runConversation({
    prompt: "Remember this token: BANANA-CIPHER-77. Reply with only the literal word OK.",
    model,
    auth,
    sentinelToken,
  });
  console.log(
    `[multi-turn] turn1 ${t1.tookMs}ms — answer="${truncate(t1.text, 60)}" conv=${t1.conversationId} msg=${t1.messageId}`,
  );
  if (!t1.conversationId || !t1.messageId) {
    throw new Error("turn1 missing conversation_id or message_id — cannot continue");
  }
  const t2 = await runConversation({
    prompt: "What was the token I asked you to remember? Reply with only the token, nothing else.",
    model,
    auth,
    conversationId: t1.conversationId,
    parentMessageId: t1.messageId,
    sentinelToken,
  });
  const ok = t2.text.includes("BANANA-CIPHER-77");
  console.log(
    `[multi-turn] turn2 ${t2.tookMs}ms — answer="${truncate(t2.text, 80)}" — context retained: ${ok ? "YES" : "NO"}`,
  );
  if (!ok) {
    throw new Error("turn2 did not echo the cipher token — multi-turn context is not threading");
  }
}

async function runConcurrency(auth: ChatGptApiAuthState, model: string, n: number) {
  console.log(`\n[concurrency] firing ${n} parallel runs against ${model}`);
  const sentinelToken = await tryAcquireSentinelToken(auth);
  const prompts = Array.from(
    { length: n },
    (_, i) => `Reply with ONLY the number ${i + 1}, nothing else.`,
  );
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    prompts.map((prompt) =>
      runConversation({ prompt, model, auth, sentinelToken }),
    ),
  );
  const wallMs = Date.now() - startedAt;
  let okCount = 0;
  let maxIndividual = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      okCount += 1;
      maxIndividual = Math.max(maxIndividual, r.value.tookMs);
      console.log(`  [c${i}] ${r.value.tookMs}ms — "${truncate(r.value.text, 60)}"`);
    } else {
      console.log(`  [c${i}] FAIL — ${formatError(r.reason)}`);
    }
  }
  console.log(
    `[concurrency] ${okCount}/${n} succeeded — wall ${wallMs}ms, max single ${maxIndividual}ms (parallelism factor ${(maxIndividual / wallMs).toFixed(2)})`,
  );
  if (okCount < n) throw new Error(`Only ${okCount}/${n} parallel runs succeeded`);
  if (wallMs > maxIndividual * 1.5) {
    console.warn(
      `[concurrency] WARNING: wall time (${wallMs}ms) is >1.5× max individual (${maxIndividual}ms) — calls may be serializing`,
    );
  }
}

async function runLatency(auth: ChatGptApiAuthState, model: string, samples: number) {
  console.log(`\n[latency] ${samples} samples against ${model}`);
  const sentinelToken = await tryAcquireSentinelToken(auth);
  const timings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await runConversation({
      prompt: "Reply with: ok",
      model,
      auth,
      sentinelToken,
    });
    timings.push(r.tookMs);
    console.log(`  [s${i}] ${r.tookMs}ms`);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  const min = timings[0];
  const max = timings[timings.length - 1];
  console.log(`[latency] min=${min}ms median=${median}ms max=${max}ms`);
}

async function tryAcquireSentinelToken(auth: ChatGptApiAuthState): Promise<string | undefined> {
  try {
    const req = await probeChatRequirements(auth);
    if (req.arkose?.required) {
      throw new ChatGptApiRequestError(
        "Account requires Arkose challenge for this conversation — Phase A cannot solve. Use --engine browser.",
        403,
        undefined,
        "arkose",
      );
    }
    return req.token;
  } catch (error) {
    if (error instanceof ChatGptApiRequestError && error.code === "arkose") throw error;
    // Non-fatal: some accounts skip the sentinel preamble entirely.
    console.warn(`[sentinel] probe failed (${formatError(error)}) — continuing without token`);
    return undefined;
  }
}

function formatError(error: unknown): string {
  if (error instanceof ChatGptApiRequestError) {
    return `[${error.code}] HTTP ${error.status}: ${error.message}${error.bodySnippet ? ` — body: ${error.bodySnippet.slice(0, 120)}` : ""}`;
  }
  if (error instanceof ChatGptApiAuthError) {
    return `[${error.code}] ${error.message}${error.hint ? ` (${error.hint})` : ""}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

function printTable(columns: string[], rows: Array<Record<string, string>>): void {
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => String(row[col] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(fmt(columns));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    console.log(fmt(columns.map((col) => String(row[col] ?? ""))));
  }
}

main().catch((error) => {
  console.error("[spike] fatal:", formatError(error));
  process.exit(1);
});
