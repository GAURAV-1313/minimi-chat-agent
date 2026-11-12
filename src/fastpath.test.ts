import { test } from "node:test";
import assert from "node:assert/strict";
import { fastPlan, isSmallTalk, shouldSpeculate } from "./fastpath.ts";
import { Gate } from "./gate.ts";
import { resolveDates } from "./dates.ts";
import type { AgentEvent } from "./answer.ts";

const clock = { now: new Date("2026-11-11T06:00:00Z"), tz: "Asia/Kolkata" };

test("obvious small talk is recognised", () => {
  for (const m of ["hey!", "Hi", "hiii", "hello there", "thanks!", "thank you so much", "ok", "what can you do?", "who are you", "good morning pip", "bye 👋", "cool, thanks", "ok thanks pip", "thanks 👍🏽", "thanks ❤️"])
    assert.equal(isSmallTalk(m), true, m);
  assert.equal(fastPlan("thanks!")?.intent, "smalltalk");
  // ...unless Pip just asked something: then "ok" is an answer and the planner needs the conversation.
  assert.equal(fastPlan("ok", { intent: "search", answerText: "Want me to check Trello too?" }), null);
  assert.equal(fastPlan("ok", { intent: "clarify", answerText: "Which product do you mean." }), null);
  assert.equal(fastPlan("thanks!", { intent: "search", answerText: "Notion Plus is $10 per seat." })?.intent, "smalltalk");
});

test("anything with a real question goes to the planner", () => {
  for (const m of [
    "hey, what does Notion cost?",
    "thanks, and what about Linear?",
    "hello, is GPT-4 still the newest model?",
    "ok so compare HubSpot and Pipedrive",
    "what can you do about my CRM shortlist from Monday?",
    "help me pick a Postgres host",
  ])
    assert.equal(fastPlan(m), null, m);
});

test("speculation only for fresh research questions", () => {
  const yes = ["What does Notion cost per seat?", "Compare Vercel and Netlify free tiers"];
  const no = [
    "What did I ask you on Monday?", // a date pulls in memory
    "Earlier today I asked you about Linear. Is that still correct?",
    "Is your answer still right?",
    "Has anything changed since then?",
    "hey!", // small talk has its own path
    "why?", // too short to be worth a search
  ];
  for (const m of yes) assert.equal(shouldSpeculate(m, resolveDates(m, clock)), true, m);
  for (const m of no) assert.equal(shouldSpeculate(m, resolveDates(m, clock)), false, m);
});

test("gate holds events, replays them in order on release, then passes through", () => {
  const out: AgentEvent[] = [];
  const g = new Gate((e) => out.push(e));
  g.emit({ type: "search", query: "a" });
  g.emit({ type: "text", delta: "x" });
  assert.equal(out.length, 0);
  assert.equal(g.heldCount, 2);
  g.release();
  g.emit({ type: "text", delta: "y" });
  assert.deepEqual(out.map((e) => e.type), ["search", "text", "text"]);
});

test("gate drops everything after discard, including late events", () => {
  const out: AgentEvent[] = [];
  const g = new Gate((e) => out.push(e));
  g.emit({ type: "search", query: "a" });
  g.discard();
  g.emit({ type: "text", delta: "late" });
  g.release(); // a release after discard must not resurrect anything
  assert.equal(out.length, 0);
});
