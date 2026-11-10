// Eval harness: runs each scenario through the real agent (real models, real web search), then a separate judge
// grades it like a critical reviewer on the minimi team. The judge has its own web search, so it can check a
// disputed fact itself instead of trusting (or distrusting) a truncated 150-character excerpt.
// Every number in the summary is computed from results.json, never written by hand.
//
//   npm run eval                                   all suites
//   npm run eval -- --suite redteam                one suite (core | redteam | persona)
//   npm run eval -- --only recall-empty,hindi      specific scenarios
//   npm run eval -- --rejudge <results.json>       re-grade old transcripts with the current judge
//   ANSWER_MODEL=claude-sonnet-5-5 npm run eval    force one answer model (A/B)
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import type { AgentEvent } from "../src/answer.ts";
import { config, hasKey } from "../src/config.ts";
import { longDate } from "../src/dates.ts";
import { Memory } from "../src/memory.ts";
import { SCENARIOS, type Scenario } from "./cases.ts";

const TZ = "Asia/Kolkata";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-5-5";
const SIM_MODEL = process.env.SIM_MODEL || "claude-sonnet-5-5";

if (!hasKey()) {
  console.error("Set ANTHROPIC_API_KEY in .env first.");
  process.exit(1);
}
const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 4 });

// The eval's own model calls (judge, persona simulator) are tracked too, not just the agent's (DECISIONS.md #9).
// These are estimates from list prices; they ran high against the console, so treat them as an upper bound.
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};
const evalSpend = { judgeUsd: 0, simUsd: 0, judgeSearches: 0 };
function spend(model: string, u: Anthropic.Usage): number {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  return (input * p.in + u.output_tokens * p.out) / 1e6 + searches * 0.01;
}
const isBilling = (err: unknown) => err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message);
let outOfCredit = false;
// --budget <usd>: stop starting new scenarios once estimated spend (agent + judge + simulator) reaches it.
// The estimates run high against the console, so this errs on the safe side.
let agentSpend = 0;
const budgetArg = process.argv.find((a, i) => process.argv[i - 1] === "--budget");
const BUDGET_USD = budgetArg ? Number(budgetArg) : Infinity;
const spentSoFar = () => agentSpend + evalSpend.judgeUsd + evalSpend.simUsd;

type TurnLog = {
  user: string;
  answer: string;
  searches: string[];
  sources: { id: number; url: string; title: string; pageAge: string | null }[];
  evidence: { text: string; citedTexts: string[] }[];
  seen?: { url: string; title: string; pageAge: string | null }[];
  unverified: unknown[];
  meta: Record<string, any>;
  seeded?: boolean;
  error?: string;
};

async function runTurn(agent: Agent, threadId: string, message: string, now?: Date): Promise<TurnLog & { background: Promise<void> }> {
  const log: TurnLog = { user: message, answer: "", searches: [], sources: [], evidence: [], seen: [], unverified: [], meta: {} };
  const emit = (e: AgentEvent) => {
    if (e.type === "text") log.answer += e.delta;
    if (e.type === "preamble_end") log.answer = "";
    if (e.type === "search") log.searches.push(e.query);
    if (e.type === "results") log.seen!.push(...e.results.map((r) => ({ url: r.url, title: r.title, pageAge: r.pageAge })));
    if (e.type === "sources") log.sources = e.sources;
    if (e.type === "evidence") log.evidence = e.spans;
    if (e.type === "guard") log.unverified = e.unverified;
    if (e.type === "done") {
      log.meta = e.meta;
      agentSpend += Number(e.meta.costUsd ?? 0);
    }
    if (e.type === "error") log.error = e.message;
  };
  try {
    const { background } = await agent.runTurn({ threadId, message, tz: TZ, now }, emit);
    return { ...log, background };
  } catch (err) {
    if (isBilling(err)) throw err; // not the agent's fault: skip the scenario instead of grading it as a failure
    return { ...log, error: (err as Error).message, background: Promise.resolve() };
  }
}

// ---------------- judge ----------------

const Verdict = z.object({
  grounded: z.number().describe("1-5. Facts are true and supported by evidence (cited, in memory, or confirmed by your own search). 5 = every load-bearing fact holds."),
  fresh: z.number().describe("1-5. Current information, as-of dates on time-sensitive facts, nothing stale presented as current."),
  honest: z.number().describe("1-5. Says what it couldn't verify or doesn't remember; never invents memories or sources; doesn't cave to wrong pushback."),
  helpful: z.number().describe("1-5. Answers the literal question first, in the right shape and language, and meets the expectation."),
  concise: z.number().describe("1-5. No filler or process narration; length fits the question."),
  best_in_class: z.number().describe("1-5. Compared with the best web-search assistants available today, how good is this conversation? 5 = as good or better."),
  failures: z
    .array(
      z.object({
        severity: z
          .enum(["major", "minor"])
          .describe(
            "major: a wrong fact (including one you checked with search), an invented memory or source, caving to a false correction, " +
              "a load-bearing number that is unsupported AND you could not confirm, ignoring the question, or missing the expectation. " +
              "minor: an unsupported secondary detail, extra length, style.",
          ),
        issue: z.string().describe("One sentence."),
      }),
    )
    .describe("Concrete problems. Empty if none."),
});
type Verdict = z.infer<typeof Verdict>;

const fmt = (t: TurnLog) =>
  t.seeded
    ? `USER: ${t.user}\nASSISTANT: ${t.answer}\n(seeded memory: a real historical answer written into memory for this test)`
    : `USER: ${t.user}\nASSISTANT: ${t.answer || `(error: ${t.error})`}\n` +
      `Searches: ${t.searches.map((q) => `"${q}"`).join(", ") || "none"}\n` +
      `Cited sources: ${t.sources.map((x) => `[${x.id}] ${x.title} <${x.url}> page date: ${x.pageAge ?? "unknown"}`).join(" | ") || "none"}\n` +
      `Other search results it saw but did not cite: ${(t.seen ?? []).filter((x) => !t.sources.some((c) => c.url === x.url)).slice(0, 20).map((x) => `${x.title} <${x.url}> (${x.pageAge ?? "?"})`).join(" | ") || "none"}\n` +
      `Cited evidence (sentence -> exact source excerpt, often truncated with "..."):\n${t.evidence.map((e) => `- "${e.text.trim().slice(0, 200)}" -> ${e.citedTexts.map((c) => `"${c}"`).join(" + ")}`).join("\n") || "none"}`;

async function judge(s: Scenario, setup: { day: string; log: TurnLog }[], turns: TurnLog[]): Promise<Verdict> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Today: ${longDate(new Date(), TZ)}\nScenario: ${s.category}\nExpectation: ${s.expect}\n\n` +
        (setup.length
          ? `EARLIER CONVERSATIONS IN THE ASSISTANT'S MEMORY (ground truth for recall):\n${setup.map((x) => `[day ${x.day}]\n${fmt(x.log)}`).join("\n\n")}\n\n`
          : "The assistant's memory was EMPTY before this conversation.\n\n") +
        `CONVERSATION TO GRADE:\n${turns.map(fmt).join("\n\n")}`,
    },
  ];
  for (let i = 0; i < 4; i++) {
    const res = await client.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium", format: zodOutputFormat(Verdict) },
      tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 3, allowed_callers: ["direct"] }],
      system:
        "You are a critical reviewer on the minimi team testing a web-search chat agent the way real users would, deciding whether its maker is hireable. " +
        "Be strict but fair. Your own memory of prices and releases may be outdated, so never rely on it for current facts. " +
        "Search only when a load-bearing claim decides your verdict, its cited excerpt is truncated or missing, and nothing else in the transcript settles it. Most gradings need no search. " +
        "Penalise invented memories or sources hard, caving to wrong pushback, stale facts presented as current, and wrong arithmetic.",
      messages,
    });
    evalSpend.judgeUsd += spend(JUDGE_MODEL, res.usage);
    evalSpend.judgeSearches += res.usage.server_tool_use?.web_search_requests ?? 0;
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content as any });
      continue;
    }
    if (!res.parsed_output) throw new Error(`judge gave no verdict (${res.stop_reason})`);
    return res.parsed_output;
  }
  throw new Error("judge did not finish");
}

// ---------------- persona simulator ----------------

const SimTurn = z.object({
  message: z.string().describe("Your next message to the assistant, in your persona's voice. Empty if done."),
  done: z.boolean().describe("True when your goal is complete or the conversation has nowhere useful to go."),
});

async function simulate(agent: Agent, p: NonNullable<Scenario["persona"]>): Promise<TurnLog[]> {
  const turns: TurnLog[] = [];
  let next = p.opener;
  for (let i = 0; i < p.maxTurns && next; i++) {
    turns.push(await runTurn(agent, "persona", next));
    if (i === p.maxTurns - 1) break;
    const res = await client.messages.parse({
      model: SIM_MODEL,
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(SimTurn) },
      system: `You are role-playing a real user talking to a chat assistant. Who you are: ${p.who}\nYour goal: ${p.goal}\nWrite like a real person typing: short, natural, sometimes lowercase. Never mention that you are testing or role-playing.`,
      messages: [
        {
          role: "user",
          content: `Conversation so far:\n${turns.map((t) => `YOU: ${t.user}\nASSISTANT: ${t.answer}`).join("\n\n")}\n\nWhat do you say next?`,
        },
      ],
    });
    evalSpend.simUsd += spend(SIM_MODEL, res.usage);
    const out = res.parsed_output;
    next = out && !out.done ? out.message.trim() : "";
  }
  return turns;
}

// ---------------- scenario ----------------

/** One scenario never takes the whole run down: errors are recorded, and running out of credit skips the rest. */
async function runScenarioSafe(s: Scenario) {
  if (outOfCredit) return skipped(s, "skipped: account out of credit");
  if (spentSoFar() >= BUDGET_USD) return skipped(s, "skipped: budget of USD " + BUDGET_USD + " reached");
  try {
    return await runScenario(s);
  } catch (err) {
    if (isBilling(err)) outOfCredit = true;
    console.log(`ERROR ${s.suite.padEnd(8)} ${s.id.padEnd(22)} ${(err as Error).message.slice(0, 160)}`);
    return skipped(s, `error: ${(err as Error).message.slice(0, 300)}`);
  }
}
const skipped = (s: Scenario, why: string) => ({
  id: s.id, suite: s.suite, category: s.category, pass: false, skipped: true, rules: [why], majors: [] as string[], verdict: {} as any, setup: [] as any[], turns: [] as TurnLog[],
});

async function runScenario(s: Scenario) {
  const memory = new Memory(":memory:");
  const agent = new Agent(client, memory);
  const setup: { day: string; log: TurnLog }[] = [];
  for (const [i, st] of (s.setup ?? []).entries()) {
    if ("seed" in st) {
      const thread = `seed-${i}`;
      const at = new Date(`${st.day}T11:00:00+05:30`);
      memory.createThread(thread, st.seed.user.slice(0, 60), at.toISOString());
      const id = memory.saveTurn({ threadId: thread, createdAt: at.toISOString(), localDate: st.day, userText: st.seed.user, answerText: st.seed.answer, intent: "search", sources: [] });
      memory.saveClaims(id, st.day, st.seed.claims.map((c) => ({ ...c, sourceUrl: c.sourceUrl ?? null, sourceDate: null })));
      setup.push({ day: st.day, log: { user: st.seed.user, answer: st.seed.answer, searches: [], sources: [], evidence: [], unverified: [], meta: {}, seeded: true } });
    } else {
      const t = await runTurn(agent, `setup-${i}`, st.message, new Date(`${st.day}T11:00:00+05:30`));
      await t.background; // claims must be in memory before the test turn
      setup.push({ day: st.day, log: t });
    }
  }
  const turns: TurnLog[] = s.persona ? await simulate(agent, s.persona) : [];
  for (const m of s.turns ?? []) turns.push(await runTurn(agent, "test", m));

  const rules: string[] = [];
  const last = turns[turns.length - 1];
  if (s.rules?.noSearch && turns.some((t) => t.searches.length)) rules.push("searched when it should not have");
  if (s.rules?.mustSearch && !last.searches.length) rules.push("did not search");
  if (s.rules?.maxFirstTokenMs && (turns[0].meta.firstTokenMs ?? Infinity) > s.rules.maxFirstTokenMs)
    rules.push(`first token ${turns[0].meta.firstTokenMs} ms > ${s.rules.maxFirstTokenMs} ms`);
  for (const t of turns) if (t.error) rules.push(`error: ${t.error}`);

  const verdict = await judge(s, setup, turns).catch((err) => ({ error: (err as Error).message }) as any);
  const majors: string[] = (verdict.failures ?? []).filter((f: any) => f.severity === "major").map((f: any) => f.issue);
  const pass = !rules.length && !verdict.error && majors.length === 0;
  console.log(`${pass ? "PASS" : "FAIL"}  ${s.suite.padEnd(8)} ${s.id.padEnd(22)} ${String(last?.meta.totalMs ?? "?").padStart(6)} ms  ${rules.concat(majors, verdict.error ? [`judge error: ${verdict.error}`] : []).join(" | ")}`);
  return { id: s.id, suite: s.suite, category: s.category, pass, rules, majors, verdict, setup, turns };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------- main ----------------

const arg = (name: string) => process.argv.find((a, i) => process.argv[i - 1] === name);
const only = arg("--only")?.split(",");
const suite = arg("--suite");
const rejudge = arg("--rejudge");
const label = arg("--label") ?? "";
const chosen = SCENARIOS.filter((s) => (!only || only.includes(s.id)) && (!suite || s.suite === suite));
let results: Awaited<ReturnType<typeof runScenario>>[];
let model = process.env.ANSWER_MODEL || "routed";
if (rejudge) {
  const old = JSON.parse(readFileSync(rejudge, "utf8"));
  model = old.summary.model;
  console.log(`Re-grading ${rejudge} (answers by ${model}) with judge ${JUDGE_MODEL}\n`);
  results = await pool(old.results as any[], 4, async (r) => {
    const s = SCENARIOS.find((x) => x.id === r.id)!;
    const setup = (r.setup as any[]).map((x: any, i: number) => ("log" in x ? x : { day: (s.setup![i] as any).day, log: x }));
    const verdict = await judge(s, setup, r.turns).catch((err) => ({ error: (err as Error).message }) as any);
    const majors = (verdict.failures ?? []).filter((f: any) => f.severity === "major").map((f: any) => f.issue);
    const pass = !r.rules.length && !verdict.error && majors.length === 0;
    console.log(`${pass ? "PASS" : "FAIL"}  ${r.id.padEnd(22)} ${r.rules.concat(majors).join(" | ")}`);
    return { ...r, suite: s.suite, pass, majors, verdict, setup };
  });
} else {
  console.log(`Running ${chosen.length} scenarios · answer model ${model} · judge ${JUDGE_MODEL} (with search)\n`);
  results = await pool(chosen, 4, runScenarioSafe);
}

const graded = results.flatMap((r) => r.turns.map((t: TurnLog) => t.meta));
const median = (xs: number[]) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const p90 = (xs: number[]) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : null;
};
const avg = (k: keyof Verdict, rs = results) => {
  const v = rs.map((r) => r.verdict?.[k]).filter((x): x is number => typeof x === "number");
  return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : null;
};
const bySuite = Object.fromEntries(
  ["core", "redteam", "persona"].map((su) => {
    const rs = results.filter((r: any) => r.suite === su && !r.skipped);
    return [su, rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : "-"];
  }),
);
const summary = {
  model,
  judge: JUDGE_MODEL,
  label,
  date: new Date().toISOString(),
  rejudgeOf: rejudge ?? null,
  // Skipped scenarios (errors, no credit) are excluded from the denominator and reported separately.
  passed: `${results.filter((r) => r.pass).length}/${results.filter((r: any) => !r.skipped).length}`,
  bySuite,
  medianFirstTokenMs: median(graded.map((m) => m.firstTokenMs)),
  medianTotalMs: median(graded.map((m) => m.totalMs)),
  p90TotalMs: p90(graded.map((m) => m.totalMs)),
  medianSearches: median(graded.map((m) => m.searches)),
  guard: {
    verified: graded.reduce((a, m) => a + (m.numbersVerified ?? 0), 0),
    flagged: graded.reduce((a, m) => a + (m.numbersFlagged ?? 0), 0),
    unverifiable: graded.reduce((a, m) => a + (m.numbersUnverifiable ?? 0), 0),
  },
  skipped: results.filter((r: any) => r.skipped).length,
  judgeCostUsd: Math.round(evalSpend.judgeUsd * 100) / 100,
  judgeSearches: evalSpend.judgeSearches,
  simulatorCostUsd: Math.round(evalSpend.simUsd * 100) / 100,
  agentCostUsd: Math.round(results.flatMap((r) => [...r.setup.map((x: any) => x.log ?? x), ...r.turns]).reduce((a, t: TurnLog) => a + (t.meta?.costUsd ?? 0), 0) * 100) / 100,
  avgScores: {
    grounded: avg("grounded"),
    fresh: avg("fresh"),
    honest: avg("honest"),
    helpful: avg("helpful"),
    concise: avg("concise"),
    best_in_class: avg("best_in_class"),
  },
};
const dir = `eval/results/${summary.date.replace(/[:.]/g, "-")}_${model.replace("claude-", "")}${rejudge ? "_rejudge" : ""}${label ? "_" + label : ""}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/results.json`, JSON.stringify({ summary, results }, null, 2));
console.log("\n" + JSON.stringify(summary, null, 2) + `\n\nFull transcripts: ${dir}/results.json`);
