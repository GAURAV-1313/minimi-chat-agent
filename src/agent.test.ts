// End-to-end tests of one turn with a fake Claude client: no network, no API key, no cost.
// The fake mimics the SDK surface the agent uses: messages.parse (planner, claims) and messages.stream
// (the writer: "text" and "contentBlock" events, then finalMessage()).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./answer.ts";
import { config } from "./config.ts";
import { Memory } from "./memory.ts";
import type { Plan } from "./planner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plan = (p: Partial<Plan>): Plan => ({
  intent: "search",
  refers_to_past_conversation: false,
  topic_keywords: [],
  entities: [],
  search_queries: [],
  clarify_question: "",
  ...p,
});

type Call = { kind: "planner" | "claims" | "writer"; at: number; doneAt?: number; model?: string; maxUses?: number; aborted?: boolean };

function fakeClient(opts: { planner: Plan; plannerDelayMs?: number; stepMs?: number; laterWriterStepMs?: number; failFirstWriter?: boolean }) {
  const calls: Call[] = [];
  let writers = 0;
  const t0 = Date.now();
  const client = {
    messages: {
      async parse(params: any) {
        const planner = typeof params.system === "string" && params.system.includes("You route messages");
        const call: Call = { kind: planner ? "planner" : "claims", at: Date.now() - t0 };
        calls.push(call);
        if (planner) {
          await sleep(opts.plannerDelayMs ?? 60);
          call.doneAt = Date.now() - t0;
          return { parsed_output: opts.planner, stop_reason: "end_turn" };
        }
        return { parsed_output: { claims: [] }, stop_reason: "end_turn" };
      },
      stream(params: any, reqOpts: { signal: AbortSignal }) {
        const tools = params.tools?.[0];
        const call: Call = { kind: "writer", at: Date.now() - t0, model: params.model, maxUses: tools?.max_uses, aborted: false };
        calls.push(call);
        const handlers: Record<string, ((x: any) => void)[]> = { text: [], contentBlock: [] };
        const fire = (ev: string, x: any) => handlers[ev].forEach((f) => f(x));
        const step = async () => {
          await sleep(stepMs);
          if (reqOpts.signal.aborted) {
            call.aborted = true;
            throw new Error("Request was aborted.");
          }
        };
        const searching = Boolean(tools);
        const index = writers++;
        const failThis = opts.failFirstWriter && index === 0;
        const stepMs = index > 0 && opts.laterWriterStepMs !== undefined ? opts.laterWriterStepMs : (opts.stepMs ?? 25);
        return {
          on(ev: string, f: (x: any) => void) {
            handlers[ev]?.push(f);
            return this;
          },
          async finalMessage() {
            const content: any[] = [];
            if (searching) {
              await step();
              const use = { type: "server_tool_use", id: "s1", name: "web_search", input: { query: `${params.model} search` } };
              fire("contentBlock", use);
              if (failThis) throw new Error("529 overloaded");
              await step();
              const res = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://www.notion.com/pricing", title: "Notion pricing", page_age: "3 days ago", encrypted_content: "x" }] };
              fire("contentBlock", res);
              await step();
              const text = "Notion Plus costs $10 per seat per month.";
              fire("text", text);
              const block = { type: "text", text, citations: [{ type: "web_search_result_location", url: "https://www.notion.com/pricing", title: "Notion pricing", cited_text: "Plus $10 per seat/month billed annually", encrypted_index: "x" }] };
              fire("contentBlock", block);
              content.push(use, res, block);
            } else {
              await step();
              const text = `Hi! I'm Pip (${params.model}).`;
              fire("text", text);
              const block = { type: "text", text, citations: null };
              fire("contentBlock", block);
              content.push(block);
            }
            return { content, stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: searching ? 1 : 0 } } };
          },
        };
      },
    },
  };
  return { client: client as any, calls };
}

async function turn(message: string, fake: ReturnType<typeof fakeClient>) {
  const agent = new Agent(fake.client, new Memory(":memory:"));
  const events: AgentEvent[] = [];
  const { background } = await agent.runTurn({ threadId: "t1", message, tz: "Asia/Kolkata", now: new Date("2026-11-11T06:00:00Z") }, (e) => events.push(e));
  await background;
  const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  const text = events.filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("");
  return { events, meta: done.meta, text };
}

const original = { speculativeWriter: config.speculativeWriter, turnDeadlineMs: config.turnDeadlineMs };
afterEach(() => {
  config.speculativeWriter = original.speculativeWriter;
  config.turnDeadlineMs = original.turnDeadlineMs;
});

test("speculation really is off by default", () => {
  if (process.env.SPECULATIVE_WRITER === undefined) assert.equal(original.speculativeWriter, false);
});

test("small talk skips the planner and answers on the chat model", async () => {
  const fake = fakeClient({ planner: plan({ intent: "search" }) });
  const r = await turn("hey!", fake);
  assert.equal(fake.calls.filter((c) => c.kind === "planner").length, 0, "planner must not be called");
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers.length, 1);
  assert.equal(writers[0].model, config.models.chat);
  assert.equal(writers[0].maxUses, undefined, "no search tool on small talk");
  assert.equal(r.meta.fastPath, true);
  assert.equal(r.meta.intent, "smalltalk");
});

test("speculation is off by default: the writer starts only after the planner", async () => {
  config.speculativeWriter = false;
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 60 });
  const r = await turn("What does Notion cost per seat?", fake);
  const [p, w] = [fake.calls.find((c) => c.kind === "planner")!, fake.calls.find((c) => c.kind === "writer")!];
  assert.ok(w.at >= p.doneAt!, `writer started at ${w.at} ms, planner returned at ${p.doneAt} ms`);
  assert.equal(fake.calls.filter((c) => c.kind === "writer").length, 1);
  assert.equal(r.meta.speculative, "off");
});

test("kept speculation: one writer, started before the planner finished; nothing lost or reordered", async () => {
  config.speculativeWriter = true;
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 80, stepMs: 20 });
  const r = await turn("What does Notion cost per seat?", fake);
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers.length, 1, "the speculative writer is the only writer");
  const planner = fake.calls.find((c) => c.kind === "planner")!;
  assert.ok(writers[0].at < planner.doneAt!, `writer started at ${writers[0].at} ms, planner returned at ${planner.doneAt} ms`);
  assert.equal(writers[0].model, config.models.search);
  assert.equal(r.meta.speculative, "kept");
  // The user sees the status line first, then the held-back search, then the answer.
  const types = r.events.map((e) => e.type);
  assert.equal(types[0], "status");
  assert.ok(types.indexOf("search") > 0 && types.indexOf("search") < types.indexOf("text"));
  assert.match(r.text, /\$10 per seat/);
  assert.equal(r.events.filter((e) => e.type === "search").length, 1);
});

test("discarded speculation: aborted, nothing it produced reaches the user, normal writer answers", async () => {
  config.speculativeWriter = true;
  const fake = fakeClient({ planner: plan({ intent: "clarify", clarify_question: "Which product?" }), plannerDelayMs: 60, stepMs: 20 });
  const r = await turn("Is the upgrade worth it for my team?", fake);
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers.length, 2, "speculative writer + the real one");
  assert.equal(writers[0].model, config.models.search);
  assert.equal(writers[0].aborted, true, "speculative writer must be aborted");
  assert.equal(writers[1].model, config.models.chat);
  assert.equal(r.events.filter((e) => e.type === "search").length, 0, "no speculative search leaks to the user");
  assert.match(r.text, /^Hi! I'm Pip/);
  assert.equal(r.meta.speculative, "discarded");
});

test("discarded speculation when the planner wants a bigger search budget (many products)", async () => {
  config.speculativeWriter = true;
  const entities = ["Notion", "Linear", "Asana", "ClickUp", "Monday.com", "Trello"];
  const fake = fakeClient({ planner: plan({ intent: "search", entities }), plannerDelayMs: 60, stepMs: 20 });
  const r = await turn("Cheapest paid plan for Notion, Linear, Asana, ClickUp, Monday.com and Trello?", fake);
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers.length, 2);
  assert.equal(writers[0].aborted, true);
  assert.equal(writers[1].maxUses, entities.length + 2, "the real writer gets the scaled budget");
  assert.equal(r.events.filter((e) => e.type === "search").length, 1, "only the real writer's search is shown");
  assert.equal(r.meta.speculative, "discarded");
});

test("no speculation on questions about earlier chats or with dates", async () => {
  config.speculativeWriter = true;
  const fake = fakeClient({ planner: plan({ intent: "recheck", refers_to_past_conversation: true, topic_keywords: ["linear"] }), plannerDelayMs: 30 });
  const r = await turn("Earlier today I asked you about Linear's Business plan. Is that still correct?", fake);
  assert.equal(fake.calls.filter((c) => c.kind === "writer").length, 1);
  assert.equal(fake.calls.find((c) => c.kind === "writer")!.model, config.models.recheck);
  assert.equal(r.meta.speculative, "off");
});

test("a speculation that fails before the planner answers is never shown; the normal writer answers once", async () => {
  config.speculativeWriter = true;
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 80, stepMs: 15, failFirstWriter: true });
  const r = await turn("What does Notion cost per seat?", fake);
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers.length, 2, "failed speculative writer + the normal one");
  assert.equal(r.events.filter((e) => e.type === "search").length, 1, "only the normal writer's search is shown");
  assert.equal((r.text.match(/\$10 per seat/g) ?? []).length, 1, "the answer appears exactly once");
  assert.equal(r.meta.speculative, "failed");
});

test("the writer that answers after a failed speculation still has a deadline", async () => {
  config.speculativeWriter = true;
  config.turnDeadlineMs = 120;
  // The speculative writer fails at ~20 ms, before the planner returns (60 ms); the fallback is slow (3 x 80 ms).
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 60, stepMs: 20, laterWriterStepMs: 80, failFirstWriter: true });
  const r = await turn("What does Notion cost per seat?", fake);
  const writers = fake.calls.filter((c) => c.kind === "writer");
  assert.equal(writers[1].aborted, true, "the fallback writer must be stopped at the deadline");
  assert.match(r.text, /time limit/);
});

test("the deadline starts when the writer starts, not before the planner", async () => {
  config.speculativeWriter = false;
  config.turnDeadlineMs = 200;
  // The planner alone takes longer than the deadline; the writer then needs ~100 ms and must not be cut off.
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 250, stepMs: 30 });
  const r = await turn("What does Notion cost per seat?", fake);
  assert.doesNotMatch(r.text, /time limit/);
  assert.match(r.text, /\$10 per seat/);
});

test("'ok' right after Pip asked a question goes to the planner, not the small-talk path", async () => {
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Asana", "Trello"] }), plannerDelayMs: 10 });
  const agent = new Agent(fake.client, new Memory(":memory:"));
  agent.memory.createThread("t1", "x", new Date().toISOString());
  agent.memory.saveTurn({ threadId: "t1", createdAt: new Date().toISOString(), localDate: "2026-11-11", userText: "compare notion and linear", answerText: "Notion is cheaper. Want me to check Asana and Trello too?", intent: "search", sources: [] });
  const events: AgentEvent[] = [];
  await agent.runTurn({ threadId: "t1", message: "ok", tz: "Asia/Kolkata", now: new Date("2026-11-11T06:00:00Z") }, (e) => events.push(e));
  assert.equal(fake.calls.filter((c) => c.kind === "planner").length, 1, "the planner must see the conversation");
  const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }>;
  assert.equal(done.meta.fastPath, false);
});

test("a speculation that fails after it was kept fails the turn, like any writer error", async () => {
  config.speculativeWriter = true;
  // Kept at 20 ms (planner), fails at ~60 ms: its partial output is already the user's, so it isn't re-answered.
  const fake = fakeClient({ planner: plan({ intent: "search", entities: ["Notion"] }), plannerDelayMs: 20, stepMs: 60, failFirstWriter: true });
  await assert.rejects(turn("What does Notion cost per seat?", fake), /529 overloaded/);
  assert.equal(fake.calls.filter((c) => c.kind === "writer").length, 1, "no second writer after a kept one fails");
});
