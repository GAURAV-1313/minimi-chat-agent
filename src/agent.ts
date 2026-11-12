// One chat turn, end to end:
//   [0] resolve dates + recall memory (code)  ->  [1] plan (Haiku)  ->  [3] search + write, streamed (Opus + web search)
//   ->  [4] number guard (code)  ->  save turn  ->  [5] extract claims (Haiku, after the reply is done)
import Anthropic from "@anthropic-ai/sdk";
import { answer, type AgentEvent, type AnswerResult } from "./answer.ts";
import { extractClaims } from "./claims.ts";
import { config } from "./config.ts";
import { addDays, localDate, longDate, prettyDay, resolveDates, type DateMention } from "./dates.ts";
import { fastPlan, shouldSpeculate } from "./fastpath.ts";
import { Gate } from "./gate.ts";
import { checkNumbers } from "./guard.ts";
import { Memory, type Turn } from "./memory.ts";
import { fallbackPlan, plan as makePlan, type Plan } from "./planner.ts";
import { contextBlock } from "./prompts.ts";

export type TurnRequest = { threadId: string; message: string; tz: string; now?: Date };

// USD per million tokens, and per search. Used only for the per-turn cost shown in the UI and the eval.
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};
const SEARCH_USD = 0.01;

type WriteOptions = {
  model: string;
  search: boolean;
  budget: number;
  effort: "low" | "medium";
  memory: string;
  planNote: string;
  cancel?: AbortSignal;
  emit: (e: AgentEvent) => void;
};

/** A search writer started before the planner answered; kept or discarded once it does. */
type Speculation = {
  gate: Gate;
  budget: number;
  accepted: boolean; // the planner agreed; its events are now the user's
  failed: boolean; // it errored before the planner answered; never replayed
  promise: Promise<AnswerResult | null>;
  cancel: () => void; // drop its events and abort it
};

/** What the speculative writer assumes until the planner answers: a fresh search, nothing from memory. */
const SPECULATIVE_PLAN: Plan = { intent: "search", refers_to_past_conversation: false, topic_keywords: [], entities: [], search_queries: [], clarify_question: "" };

export class Agent {
  constructor(
    private client: Anthropic,
    readonly memory: Memory,
  ) {}

  /** Resolves when the reply is fully streamed. `background` resolves when post-turn memory work is saved. */
  async runTurn(req: TurnRequest, emit: (e: AgentEvent) => void): Promise<{ background: Promise<void> }> {
    const t0 = Date.now();
    const now = req.now ?? new Date();
    const clock = { now, tz: req.tz };
    const today = longDate(now, req.tz);
    let firstTokenMs: number | null = null;
    const send = (e: AgentEvent) => {
      if (e.type === "text" && firstTokenMs === null) firstTokenMs = Date.now() - t0;
      emit(e);
    };

    // [0] Deterministic prep: dates and memory, no model call.
    const mentions = resolveDates(req.message, clock);
    const history = this.memory.threadTurns(req.threadId);
    const historyIds = new Set(history.map((t) => t.id));
    let recalled = recallByDate(this.memory, mentions).filter((t) => !historyIds.has(t.id));

    const historyMessages: Anthropic.MessageParam[] = [
      ...history.flatMap((t): Anthropic.MessageParam[] => [
        { role: "user", content: t.userText },
        // Earlier answers carry their sources, so "where did you get that?" is answerable without guessing.
        { role: "assistant", content: (t.answerText || "(no answer)") + sourcesNote(t) },
      ]),
      { role: "user", content: req.message },
    ];
    // Each writer gets its own deadline, counted from when that writer starts, so a slow planner never eats the
    // writer's time. `cancel` lets a speculative writer be stopped early.
    const write = (o: WriteOptions) => {
      const c = new AbortController();
      o.cancel?.addEventListener("abort", () => c.abort(), { once: true });
      const timer = setTimeout(() => c.abort(), config.turnDeadlineMs);
      return answer(this.client, {
        model: o.model,
        history: historyMessages,
        context: contextBlock({ today, timezone: req.tz, memory: o.memory, planNote: o.planNote, maxSearches: o.budget, searchAllowed: o.search }),
        search: o.search,
        maxSearches: o.budget,
        effort: o.effort,
        timezone: req.tz,
        signal: c.signal,
        emit: o.emit,
      }).finally(() => clearTimeout(timer));
    };

    // [1] Plan. Obvious small talk skips the planner (src/fastpath.ts). A fresh research question can start the search
    // writer at the same time as the planner; its output is held back until the planner agrees (src/gate.ts).
    const fast = fastPlan(req.message, history.at(-1));
    let spec: Speculation | null = null;
    if (!fast && config.speculativeWriter && shouldSpeculate(req.message, mentions)) {
      const gate = new Gate(send);
      const sc = new AbortController();
      const s: Speculation = {
        gate,
        budget: config.maxSearchesPerTurn,
        accepted: false,
        failed: false,
        promise: Promise.resolve(null),
        cancel: () => {
          gate.discard();
          sc.abort();
        },
      };
      s.promise = write({
        model: config.models.search,
        search: true,
        budget: s.budget,
        effort: "low",
        memory: this.memoryText(recalled, SPECULATIVE_PLAN, mentions, req.threadId),
        planNote: "",
        cancel: sc.signal,
        emit: gate.emit,
      }).catch((err) => {
        if (s.accepted) throw err; // once kept, its errors are the turn's errors
        // It died before being kept: drop everything it streamed so it can never be replayed, and let the
        // normal path answer.
        s.failed = true;
        gate.discard();
        return null;
      });
      spec = s;
    }

    let plan: Plan;
    let planMs = 0;
    try {
      const tPlan = Date.now();
      if (fast) plan = fast;
      else {
        try {
          plan = await makePlan(this.client, {
            message: req.message,
            today,
            dates: mentions.map(describeMention).join("; "),
            history: history.map((t) => `User: ${t.userText}\nAssistant: ${clip(t.answerText, 400)}`).join("\n\n"),
            memory: recalled.map((t) => `${prettyDay(t.localDate)}: "${clip(t.userText, 160)}"`).join("; "),
          });
        } catch (err) {
          if (isAuthError(err) || isBillingError(err)) throw err; // no point answering if the account can't
          console.warn("planner failed, defaulting to search:", (err as Error).message);
          plan = fallbackPlan(req.message);
        }
      }
      planMs = Date.now() - tPlan;

      // Topic recall when the user points at an earlier chat without a date we could match ("the Postgres question").
      if (plan.refers_to_past_conversation && plan.topic_keywords.length) {
        const byTopic = this.memory.searchTurns(plan.topic_keywords).filter((t) => !historyIds.has(t.id));
        const seen = new Set(recalled.map((t) => t.id));
        // Dated hits come first; topic hits fill in when the date matched nothing or matched other chats.
        recalled = [...recalled, ...byTopic.filter((t) => !seen.has(t.id))].slice(0, 6);
      }
    } catch (err) {
      spec?.cancel(); // never leave a speculative writer running (and billing) behind a failed turn
      throw err;
    }

    const search = plan.intent === "search" || plan.intent === "recheck";
    const model = plan.intent === "recheck" ? config.models.recheck : search ? config.models.search : config.models.chat;
    const effort = plan.intent === "recheck" ? "medium" : "low";
    // The search budget scales with the number of things to check: eight products got two of them skipped
    // under a flat cap of 6 (DECISIONS.md #8). Capped so a turn stays fast and its cost bounded.
    const budget = Math.min(config.maxSearchesCap, Math.max(config.maxSearchesPerTurn, plan.entities.length + 2));
    // Keep the speculative writer only if the planner chose exactly what it was already doing: a plain search turn
    // (not a re-check, not about an earlier chat) with the default search budget. Anything else is discarded unseen.
    const keep = spec !== null && !spec.failed && plan.intent === "search" && !plan.refers_to_past_conversation && budget === spec.budget;
    let speculative: "off" | "kept" | "discarded" | "failed" = !spec ? "off" : spec.failed ? "failed" : keep ? "kept" : "discarded";

    if (search) {
      const what = plan.entities.length ? plan.entities.slice(0, 6).join(", ") : "the web";
      send({ type: "status", text: plan.intent === "recheck" ? `Re-checking ${what}…` : `Searching ${what}…` });
    }

    // [3] Search + write, streamed.
    let result: AnswerResult | null = null;
    if (spec && keep) {
      spec.accepted = true;
      spec.gate.release(); // replay what it already did (in order, after the status line), then stream live
      result = await spec.promise;
    } else {
      spec?.cancel();
    }
    if (!result) {
      result = await write({
        model,
        search,
        budget,
        effort,
        memory: this.memoryText(recalled, plan, mentions, req.threadId),
        planNote: planNote(plan) + dateWindowNote(mentions, localDate(now, req.tz)),
        emit: send,
      });
    }

    let text = result.text;
    if (result.aborted) {
      const note = "\n\n_I hit my time limit for this answer, so this is what I had so far._";
      send({ type: "text", delta: note });
      text += note;
    }
    if (!text) {
      text = "Sorry, I couldn't put an answer together for that. Could you try rephrasing it?";
      send({ type: "text", delta: text });
    }

    // [4] Guard.
    const guard = checkNumbers(result.spans);
    const cited = result.sources.filter((s) => result.cited.includes(s.id));
    send({ type: "sources", sources: cited });
    send({ type: "evidence", spans: result.spans });
    if (guard.flagged.length) send({ type: "guard", unverified: guard.flagged });

    // A discarded speculative call is billed for whatever it produced before the abort; that isn't reported back
    // to us, so it isn't in this estimate. One more reason speculation stays off until it's measured.
    const cost =
      (fast ? 0 : cost$(config.fastModel, 600, 150)) +
      cost$(model, result.usage.input - result.usage.cacheRead * 0.9, result.usage.output) +
      result.usage.searches * SEARCH_USD;
    send({
      type: "done",
      meta: {
        intent: plan.intent,
        model,
        fastPath: Boolean(fast),
        speculative,
        planMs,
        firstTokenMs,
        totalMs: Date.now() - t0,
        searches: result.searches,
        sourcesSeen: result.sources.length,
        recalledTurns: recalled.length,
        numbersVerified: guard.verified,
        numbersFlagged: guard.flagged.length,
        numbersUnverifiable: guard.unverifiable,
        costUsd: Math.round(cost * 10000) / 10000,
      },
    });

    // Save, then extract claims without making the user wait.
    const dayLocal = localDate(now, req.tz);
    this.memory.createThread(req.threadId, clip(req.message, 60), now.toISOString());
    const turnId = this.memory.saveTurn({
      threadId: req.threadId,
      createdAt: now.toISOString(),
      localDate: dayLocal,
      userText: req.message,
      answerText: text,
      intent: plan.intent,
      sources: cited,
      evidence: result.spans,
    });
    const background =
      search && cited.length
        ? extractClaims(this.client, req.message, text, cited)
            .then((claims) => this.memory.saveClaims(turnId, dayLocal, claims))
            .catch((err) => console.warn("claim extraction failed:", (err as Error).message))
        : Promise.resolve();
    return { background };
  }

  /** What the answer model is told about earlier conversations. Explicit about gaps so it never fills them in. */
  private memoryText(recalled: Turn[], plan: Plan, mentions: DateMention[], threadId: string): string {
    const lines: string[] = [];
    // Coverage excludes the current conversation, which the model already sees as chat history. Counting it made
    // the agent tell a user with no past chats that it "has conversations from today" (DECISIONS.md #5).
    const total = this.memory.turnCount(threadId);
    const days = this.memory.activeDays(14, threadId);
    if (!total) lines.push("No earlier conversations: apart from this chat, memory is empty.");
    else lines.push(`Earlier conversations (other than this chat) exist on these days, newest first: ${days.map(prettyDay).join(", ")}.`);

    const asked = mentions.map(describeMention);
    if (asked.length && plan.refers_to_past_conversation) {
      const hitDays = new Set(recalled.map((t) => t.localDate));
      const missing = mentions.filter((m) => !mentionDays(m).some((d) => hitDays.has(d)));
      if (missing.length) lines.push(`No conversation found on: ${missing.map(describeMention).join("; ")}.`);
      for (const m of mentions) {
        const alt = m.alternatives?.find((d) => hitDays.has(d));
        if (alt && !hitDays.has(m.date))
          lines.push(`"${m.text}" was matched to ${prettyDay(alt)}, because there was no conversation on ${prettyDay(m.date)}.`);
      }
    } else if (plan.refers_to_past_conversation && !recalled.length && total) {
      lines.push("No earlier conversation matched what the user is referring to.");
    }

    const claims = this.memory.claimsForTurns(recalled.map((t) => t.id));
    for (const t of recalled) {
      lines.push(
        `\n--- ${prettyDay(t.localDate)} ---\nUser asked: ${t.userText}\nYou answered: ${clip(t.answerText, 2500)}`,
      );
      const mine = claims.filter((c) => c.turnId === t.id);
      if (mine.length) {
        lines.push(
          "Claims recorded from that answer:\n" +
            mine
              .map((c) => `- ${c.entity} | ${c.attribute}: ${c.value}${c.sourceUrl ? ` (source: ${c.sourceUrl}${c.sourceDate ? `, page dated ${c.sourceDate}` : ""})` : ""}`)
              .join("\n"),
        );
      }
    }
    return lines.join("\n");
  }
}

function recallByDate(memory: Memory, mentions: DateMention[]): Turn[] {
  const out: Turn[] = [];
  for (const m of mentions) {
    if (m.range) out.push(...memory.turnsBetween(m.range.from, m.range.to));
    else {
      const exact = memory.turnsOnDays([m.date]);
      // "Last Tuesday": use the alternative day only if the obvious one has nothing.
      out.push(...(exact.length ? exact : memory.turnsOnDays(m.alternatives ?? [])));
    }
  }
  const seen = new Set<number>();
  return out.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 6);
}

const mentionDays = (m: DateMention) =>
  m.range ? rangeDays(m.range.from, m.range.to) : [m.date, ...(m.alternatives ?? [])];

function rangeDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

function describeMention(m: DateMention): string {
  if (m.range) return `"${m.text}" = ${prettyDay(m.range.from)} to ${prettyDay(m.range.to)}`;
  const alt = m.alternatives?.length ? ` (or ${m.alternatives.map(prettyDay).join(", ")})` : "";
  return `"${m.text}" = ${prettyDay(m.date)}${alt}`;
}

/**
 * Dates resolved in code also bound the search, not just memory: "this week" becomes an explicit window, so the
 * writer can reject a 13-day-old item as not-this-week (DECISIONS.md #4). Ranges are clipped to today.
 */
function dateWindowNote(mentions: DateMention[], today: string): string {
  if (!mentions.length) return "";
  const parts = mentions.map((m) => {
    if (m.range) {
      const to = m.range.to > today ? today : m.range.to;
      return `"${m.text}" = ${prettyDay(m.range.from)} to ${prettyDay(to)}`;
    }
    return describeMention(m);
  });
  return ` Dates in the question (resolved in the user's timezone): ${parts.join("; ")}. Anything dated outside these is not "${mentions[0].text}".`;
}

function planNote(p: Plan): string {
  const parts = [`Turn type: ${p.intent}.`];
  if (p.entities.length) parts.push(`About: ${p.entities.join(", ")}.`);
  if (p.search_queries.length) parts.push(`Suggested searches (run in parallel, adjust as needed): ${p.search_queries.map((q) => `"${q}"`).join(", ")}.`);
  if (p.intent === "clarify" && p.clarify_question) parts.push(`Ask the user: ${p.clarify_question}`);
  return parts.join(" ");
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
/**
 * The agent's own record of an earlier answer: which pages it cited (with URLs) and what those pages actually said.
 * Without this, a challenged agent can't see its own evidence: in eval it first denied searches it had run,
 * then retracted claims its sources supported (DECISIONS.md #6).
 */
const sourcesNote = (t: Turn) => {
  if (!t.sources.length) return "\n\n[This answer used no web search.]";
  const srcs = t.sources.map((s) => `[${s.id}] ${s.title}, ${s.url}${s.pageAge ? ` (page dated ${s.pageAge})` : ""}`).join("\n");
  const ev = (t.evidence ?? [])
    .slice(0, 10)
    .map((e) => `- "${clip(e.text.trim(), 140)}" was based on [${e.sourceIds.join(",")}]: "${e.citedTexts.map((c) => clip(c, 160)).join(" / ")}"`)
    .join("\n");
  return `\n\n[Record of this answer. It used web search. Sources cited:\n${srcs}${ev ? `\nWhat those sources said:\n${ev}` : ""}]`;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const cost$ = (model: string, inTok: number, outTok: number) => {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  return (Math.max(0, inTok) * p.in + outTok * p.out) / 1e6;
};

export function isBillingError(err: unknown) {
  return err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message);
}

export function isAuthError(err: unknown) {
  return err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError;
}
