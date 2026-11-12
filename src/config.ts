// Settings read once at startup. Only ANTHROPIC_API_KEY is required; everything else has a default.
import { existsSync, readFileSync } from "node:fs";

// Tiny .env loader so `npm run dev` works without extra packages or flags.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d: string) => process.env[k]?.trim() || d;

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  port: Number(env("PORT", "3000")),
  dbPath: env("MINIMI_DB", "data/minimi.db"),
  // Which model writes the answer depends on the kind of turn (chosen by the planner). Picked from eval runs:
  // Haiku streams and is fine for chat; Sonnet ties Opus on search answers at ~35% less time; Opus is the
  // only one that passed every "what changed since" re-check. ANSWER_MODEL forces one model for A/B evals.
  models: {
    chat: env("ANSWER_MODEL", env("CHAT_MODEL", "claude-haiku-5-5")), // smalltalk, memory_only, clarify
    search: env("ANSWER_MODEL", env("SEARCH_MODEL", "claude-sonnet-5-5")),
    recheck: env("ANSWER_MODEL", env("RECHECK_MODEL", "claude-opus-5-5")),
  },
  // Cheap, fast model for routing and for extracting claims after a turn.
  fastModel: env("FAST_MODEL", "claude-haiku-5-5"),
  // Hard caps that keep a turn fast and its cost bounded.
  maxSearchesPerTurn: Number(env("MAX_SEARCHES", "6")),
  maxSearchesCap: Number(env("MAX_SEARCHES_CAP", "10")),
  // Start the search writer while the planner runs (src/fastpath.ts). Off by default: the speculative writer
  // doesn't see the planner's notes, and its effect on answer quality hasn't been measured yet.
  speculativeWriter: env("SPECULATIVE_WRITER", "0") === "1",
  turnDeadlineMs: Number(env("TURN_DEADLINE_MS", "45000")),
};

export const hasKey = () => config.apiKey.length > 0;

// Domains that, in our own research-agent logs, almost always failed or gave thin, unreliable content.
export const BLOCKED_DOMAINS = ["pinterest.com", "quora.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "tiktok.com"];
