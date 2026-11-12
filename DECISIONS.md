# Key decisions

The nine decisions that shape this agent, each with the problem behind it, what we chose, the evidence, and what we rejected. Numbers come from the eval runs in `eval/results/` (28 scenarios, graded by a separate judge; see #9). Code comments refer to these numbers.

---

## 1 · Our own loop on the Claude Messages API: no framework, no Managed Agents, strictly one tool

**Context.** The brief: one tool (web search), run with `npm install && npm run dev`, and judges will read the code and need to understand every decision.

**Decision.** Plain Node + TypeScript.
- **Model calls:** the official `@anthropic-ai/sdk`.
- **Search:** Claude's server-side `web_search_20260318`.
- **Server and storage:** `node:http` with Server-Sent Events, and `node:sqlite` (built into Node ≥ 22.13).
- **Page:** plain JS, served without a build step.
- **Keys:** one, `ANTHROPIC_API_KEY`.

**Why.**
- **Everything that matters is in about 1,400 readable lines:** routing, recall, re-checks and the number guard.
- **`node:sqlite` needs no native compile,** so `npm install` can't fail on a judge's machine. I verified this by installing from a clean copy.
- **The search tool runs in direct mode** (`allowed_callers: ["direct"]`) rather than the default mode, which routes every search through code execution first. Direct mode lets the UI show each query the moment it starts.

**Rejected.**
- **Agent frameworks:** more to explain, and nothing we need.
- **Claude Managed Agents:** a hosted loop with a per-session container would move the interesting logic off the judges' machine and add start-up latency, and a one-tool agent needs no sandbox.
- **Web fetch, or a second search API such as Exa or Tavily:** we read "one tool: web search" strictly.

---

## 2 · One planner, one writer, and the writer's model chosen by turn type

**Context.** A chat agent has to be fast on "hi" and careful on "has anything changed since Monday?". In our own past work, research sub-agents took a median of 8.6 minutes, and an earlier chatbot scored 4/28 on small talk until small talk got its own path.

**Decision.**
1. **A Haiku 5.5 planner** (structured output, about 2 s) classifies the turn as `smalltalk`, `memory_only`, `clarify`, `search` or `recheck`. It also picks out the entities and drafts neutral queries.
2. **One writer call per turn,** which runs several searches in parallel inside that call. No sub-agents.
3. **The writer's model depends on the turn type, chosen by measurement.** On the same scenarios with the same judge:

| Writer | Pass | Median time | Notes |
|---|---|---|---|
| Opus 5.5 everywhere | 7/10 | 10.5 s | passed every re-check |
| Sonnet 5.5 everywhere | 7/10 | 6.9 s | missed one re-check |
| Haiku 5.5 everywhere | 6/10 | 5.3 s | failed all 3 re-checks; the only one that truly streams (#3) |
| **Routed** (Haiku chat / Sonnet search / Opus re-check) | **7–8/10** | **6.6–6.9 s** | Opus only where it pays off |

**Cutting the planner's ~2 s** (`src/fastpath.ts`, `src/gate.ts`; tested with a fake Claude client, no API calls):
- **A small-talk fast path is on.** When the *whole* message is greetings, thanks or "what can you do?", the planner is skipped. The pattern is deliberately narrow: "hey, what does Notion cost?" still goes to the planner.
- **A speculative writer is built but off** (`SPECULATIVE_WRITER=1` turns it on). For a fresh research question (no dates, no reference to an earlier chat), the Sonnet search writer starts *alongside* the planner, and its events are held back.
  - **Kept:** if the planner returns a plain search with the default budget, the held events are released in order. That saves the planner's time on the most common turn.
  - **Discarded:** anything else (a re-check, a clarification, a big multi-product search) aborts it unseen, and the normal writer runs.
  - **Why it's off:** it writes without the planner's notes, and a discarded call still costs tokens. Both need a paid eval to judge, and that hasn't run.
  - **The independent review found two real bugs in the first version, both reproduced, fixed and now covered by tests:**
    - A speculation that *failed* before the planner answered was still replayed to the user, then answered again.
    - The fallback writer after it had no deadline.

    Also fixed from the review: each writer's deadline now starts when that writer starts, so a slow planner no longer eats it. And "ok" right after Pip asked a question goes to the planner instead of being treated as small talk.

**Rejected.**
- **Opus everywhere:** no better, and 50% slower.
- **Haiku everywhere:** it marked claims "Held" with no evidence.
- **A judge or best-of-N at runtime:** it costs time, and judges miss wrong numbers (#7).
- **A keyword router instead of the planner:** fine for "hey", too brittle for "is it still correct?". Keywords only take the obvious cases.

---

## 3 · With server-side search, thinking models can't stream the answer

**Context.** "Answers fast" usually means streaming. While building, the first words of research answers arrived at the same moment as the last.

**Finding, from timing probes on raw stream events.** Opus and Sonnet send nothing after a search until the whole answer is written. Opus's entire answer (77 text pieces) arrived within 0.3 s, 8.9 s after the start. These made no difference:
- showing the thinking summary
- Sonnet's no-thinking-before-answering mode
- splitting search and writing into two calls (the second call buffers the same way)

Only **Haiku with thinking off** streamed token by token: first text at 1.0 s.

**Decision.**
- **Make the wait visible.** The UI streams each search query as it starts (about 1.1 s), then the results with their page dates.
- **Chat turns use Haiku,** so they genuinely stream (#2).

**Rejected.** A third-party search API to get real streaming: it adds a second key and breaks the one-tool rule.

---

## 4 · Dates are resolved in code, in the user's timezone

**Context.** All three example questions in the brief hinge on dates ("Monday", "3 November", "last Tuesday"). In our past research agents, 43% of queries that contained a year used a *past* year, and adding prompt rules didn't fix it.

**Decision.**
- **chrono-node** resolves dates with the browser's IANA timezone, and each turn is stored with the user's **local calendar day**, so "on Monday" is an exact SQL lookup.
- **Rules, each with a unit test:**
  - A bare weekday or date that would fall in the future means the past one, unless the user says "next".
  - "In August" and "last month" mean the whole month.
  - "This week" means the last 7 days.
  - A weekday inside a domain name is a product, not a date: "Monday.com" isn't 9 Nov. A latency test caught this. The eight-product pricing scenario had been receiving a meaningless "Monday = 9 Nov" date window.
  - **"Last Tuesday" is ambiguous:** said on a Wednesday, it means yesterday to some people and 8 days ago to others. We try yesterday first, fall back to the week before, and the answer says which day it matched.
- **The resolved dates also bound the answer.** The writer gets an explicit window ("this week" = 5–11 Nov 2026), so a 13-day-old story can't be presented as this week's news. Before this, dates only drove memory lookup, and old news slipped through.

---

## 5 · Memory stores dated claims and evidence, and re-checks are claim by claim

**Context.** *"Is your answer still correct today?"* needs three things: what we said, when, and from which page. A transcript alone can't support a precise "what changed".

**Decision.**
- **Each turn stores** its local day, the sources it cited, the evidence (each sentence → the exact excerpt it cites), and claims extracted after the reply by Haiku: {entity, attribute, value, source, page date}.
- **Recall** works by day, or by topic through SQLite FTS5.
- **A re-check** searches each claim again and labels it:
  - **Held:** a source cited today confirms it.
  - **Changed:** the vendor or the world changed it after that date.
  - **Corrected:** our earlier answer was wrong.
  - **Couldn't verify:** no current source found.

  The bottom line has to count these and match the table.
- **Separating "Corrected" from "Changed"** fixed the brief's own CRM example, which went from 1/3 to 2–3/3. The agent had been saying "no price changes" and then labelling its own earlier mistake "Changed".
- **Empty memory is stated, never filled in.** The agent says it has no conversation on that day and names the days it does have. Coverage excludes the current chat, after a run where the agent told a new user it "had conversations from today".

**Rejected.**
- **A vector DB:** recall here is by date and topic, exact lookups.
- **Re-researching from scratch:** that loses the "then" side of the comparison.

---

## 6 · The agent sees its own record, so it stays honest under pressure

**Context.** A simulated skeptical engineer asked, "did you actually open those pages?" The agent answered that its previous answer had **no search behind it**. Pushed again, it said its correct quotes were "made up". The cause: earlier turns reached the model as plain text, with no trace of the searches behind them, so it trusted the user's framing over its own work. An honesty failure under pressure is worse than a wrong price.

**Decision.** Each earlier answer is returned to the model with a bracketed **record**: the URLs it cited and what each source said (the stored evidence from #5), or "[This answer used no web search]". The prompt makes that record the truth about its past work: give the URLs when asked, don't deny searches the record shows, and don't retract a claim the record supports unless a newer source contradicts it.

**Evidence.**
- **Domains alone weren't enough.** With only domains in the record, the agent swung from denying to *over-correcting*: it retracted dates its sources had supported.
- **Full URLs and excerpts fixed it:** the skeptic persona went from 0/2 to 2/3, and "where exactly did you get that?" from 1/3 to 3/3.

---

## 7 · A deterministic number guard, tuned for precision

**Context.** In our past work, an LLM judge panel passed six numbers that were all wrong. Checking numbers with another model is slow and unreliable.

**Decision.** Plain code. Every price or percentage in a cited sentence is compared with the exact excerpt the API returns for that citation (`cited_text`). No model is involved, and it adds no time.

**Evidence.** The first version flagged any number it couldn't see, which put a warning on **36% of turns**, almost all false alarms. The cause: `cited_text` is capped at about 150 characters, and **55% of excerpts were cut off** ("…$90 per seat for Profe..."). So:
- **v2:** flag a number only when *every* excerpt it cites is complete and the number isn't in any of them. Anything behind a cut-off excerpt counts as unverifiable: tracked, not shown.
- **v2.1:** join digits split by a page's markup (`$2 9.9 0/mo` → 29.90).

Replayed offline over all 545 stored turns (`eval/replay-guard.ts`, no API calls):

| Guard | Flags | Turns with a warning |
|---|---|---|
| v1 | 543 | 36% |
| **v2.1** | **8** | **1.3%**, and all 8 were fair on hand review |

**Recall** (`eval/guard-recall.ts`, offline). Every price and percentage in the 2,550 stored cited sentences was corrupted one at a time, and the real guard was run on the result.

An independent review pointed out that most of this follows from the guard's own rules, so the method is reported that way:
- **By design:**
  - A made-up price ($90 → $113) is caught *exactly* when every excerpt behind the sentence is complete (508/508 caught; 0/1,121 when an excerpt is cut off).
  - A wrong-row price (a real price from the same page, $90 → $150) is *never* caught (0/929), because it is in the excerpt.
- **The measured fact:** only **508 of 1,630 prices (31.2%)** sit behind complete excerpts. That is the guard's expected recall on made-up prices in answers like ours.
- **Scope:** money and percentages only. A wrong "10 GB" or "v26" isn't checked at all.

So the guard is a precise, narrow net: every warning it shows was fair on hand review, but it misses about two thirds of made-up prices and every wrong-row error. The next step is label-aware matching: compare the number next to the same plan or tier name in the excerpt. Measuring it properly needs real wrong numbers flagged by a judge, not synthetic ones.

---

## 8 · Vendor sources are enforced through queries, and the search budget scales with the question

**Context.** Pricing answers kept citing blogs and trackers. Asking in the prompt didn't help, because the search engine ranks third-party pages above vendors.

**Decision.** Queries about prices, plans and launches use `site:<vendor domain>`.
- **Evidence:** `site:vercel.com pricing` returned 10 of 10 results from vercel.com. The same query without `site:` returned 0 of 10.

**Search budget.** The cap is max(6, number of entities + 2), up to 10. With a flat cap of 6, an eight-product question skipped two products and marked them "not found". That scenario went from 0/3 to 3/3 once the budget scaled.

**Still open.** In the final runs, about 5 of the 12 failures still used a third-party page when the vendor's page was in the results. The next step is to make the vendor check a hard step: a second search restricted with `allowed_domains`.

---

## 9 · How we evaluate: adversarial scenarios, repeat runs, and a judge that checks facts itself

**Context.** Ten friendly test questions told us little, and the first judge could only see the 150-character excerpts. It failed true facts it couldn't see and couldn't catch false ones that had plausible excerpts.

**Decision.**
- **28 scenarios in three suites:**
  - **core:** the brief's kinds of questions
  - **red-team:** what a sharp reviewer would try, such as a false correction ("it's $10, I just checked"), misquoting yesterday's answer, "where did you get that?", ambiguous names, questions about the future, Hindi, and "remind me tomorrow"
  - **personas:** Sonnet plays a skeptical engineer, a terse sales lead and a vague founder for up to 4 turns each
- **Two "real change" tests seed memory with true historical facts:** Node 26 becoming LTS on 28 Oct 2026, and Salesforce replacing its editions in Sep 2026. The live web can't be sent back in time, so this is the only way to grade "Changed", not just "Held".
- **The judge is Opus with up to 3 searches of its own,** so it checks disputed facts itself. It also sees the results the agent read but didn't cite.

**What made the numbers trustworthy.**
- **Single runs are unreliable.** The same code once scored 22/28 and 26/28, so decisions use per-scenario pass rates over repeat runs (`eval/report.ts`).
- **Changing the judge changes the score.** When the judge improved, I re-graded old transcripts with it (`--rejudge`): on unchanged answers, the fairer judge alone moved core from 8/10 to 9/10.
- **One result didn't replicate.** A partial run scored 94% on 22 scenarios; the full runs scored 85% on the same set.
- **Eval spend is tracked per run** (agent, judge, simulator), and `--budget` stops a run at a cap.

**Where it stands.** Final code, 3 runs: **24, 24 and 24 out of 28**. 19 scenarios pass every time, including every memory and re-check case, both real-change tests, the false correction and Hindi. Median turn is 7.4–8.3 s. I stopped iterating once three consecutive versions scored within one scenario of each other: past that point, more prompt rules would just be tuning to noise.
