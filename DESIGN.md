# DESIGN

A chat agent with one tool, web search, plus a **dated memory of every answer it gives**. That memory is what lets it answer *"On Monday we shortlisted 5 CRMs. Has anything changed since?"* honestly: it knows what it said, when, and from which page. Diagrams are at `/architecture` in the running app; [`DECISIONS.md`](DECISIONS.md) goes deeper on the nine key decisions, each with its context, evidence and what was rejected.

## How a turn works

1. **Prep (code, ~0 ms).** chrono-node resolves "Monday", "3 November", "last Tuesday", "in August" or "this week" into calendar days in the browser's timezone. SQLite returns the turns from those days (FTS5 handles "the Postgres question" when no date is given), plus each turn's dated claims and cited evidence.
2. **Plan (Haiku 5.5, ~2 s).** Structured output gives the turn type (`smalltalk`, `memory_only`, `clarify`, `search` or `recheck`), the entities, and neutral queries, with `site:vendor.com` for prices and launches.
3. **Write (one call, model picked by turn type).**
   - Haiku, thinking off, for chat; it truly streams.
   - Sonnet 5.5 with web search for research.
   - Opus 5.5 with web search for "what changed since" re-checks.

   The search budget grows with the number of entities (6 to 10). Code also gives the writer an explicit date window ("this week" = 5–11 Nov).
4. **Guard (code).** A price or percentage missing from its cited excerpt is flagged, but only when that excerpt is complete.
5. **Remember (Haiku, after the reply).** The turn is saved by local day, with its cited evidence and claims ({entity, value, source, page date}). Earlier answers return to the model with their own record: the URLs they cited and what those pages said.

## Why it's built this way

The starting point was our own data: 265 of our past research sub-agents and an earlier chatbot evaluation. After that, 19 recorded eval runs, plus 3 cut short when credit ran out, drove the changes.

- **Code does whatever can be exact.** In our past agents, 43% of queries containing a year used a *past* year, and prompt rules didn't fix it. So dates, recall and number checks are code. Whenever an eval failure could be fixed in code instead of the prompt, code won ("this week" as a window, digits split across a page's markup).
- **Memory stores claims and evidence, not just transcripts.** A re-check compares the old claim with what today's sources say, and labels each item **Held**, **Changed** (the world changed), **Corrected** (my earlier answer was wrong) or **Couldn't verify**. Separating "Corrected" from "Changed" took the brief's own CRM example from 1/3 to 3/3 in that iteration (2/3 in the final runs).
- **The agent can see its own record.** A skeptical simulated user once got it to deny searches it had made and call its correct quotes "made up", because earlier turns reached it as plain text. With the cited URLs and excerpts attached, that persona went from 0/2 to 2/3, and "where did you get that?" from 1/3 to 3/3.
- **One planner and one writer, no sub-agents.** Our research sub-agents took a median of 8.6 minutes. Parallel searches inside one call give the same breadth in seconds.
- **The model is chosen per turn type, by measurement.** On the first 10 scenarios, Opus and Sonnet tied on quality, with Sonnet 35% faster. Haiku failed every re-check. So Opus runs only where re-checks need it.
- **Small and readable.** `node:http` with SSE, `node:sqlite` (built into Node, so no native build), a plain JS page, one API key, about 1,200 lines of TypeScript.

## How we tested

- **28 scenarios in three suites:**
  - **core:** the brief's kinds of questions
  - **red-team:** what a sharp reviewer would try, such as a false correction, a misquoted memory, "where did you get that?", ambiguous names, the future, Hindi, and **two real changes seeded with historical facts**: Node 26 becoming LTS, and Salesforce's September 2026 edition change
  - **personas:** Sonnet plays a skeptical engineer, a terse sales lead and a vague founder
- **The judge** is Opus with up to 3 searches of its own, so it checks disputed facts instead of trusting 150-character excerpts.
- **Repeat runs:** the same code once scored both 22/28 and 26/28, so every decision uses per-scenario pass rates across repeat runs (`eval/report.ts`).

| Version | 28-scenario result |
|---|---|
| Iteration 1 | 24 |
| Iteration 2 (2 runs) | 22, 26 |
| Iteration 3 (3 runs) | 23, 24, 24 |
| Iteration 4 (3 runs) | 22, 23, 23 |
| **Final (3 runs)** | **24, 24, 24**: 19 scenarios at 3/3; median turn 7.4–8.3 s; about $1.30 of agent spend per 28 scenarios (estimated) |

## What I got wrong along the way

- **My guard was mostly noise.** The API cuts `cited_text` at about 150 characters, and 55% of excerpts were truncated. Flagging every number it couldn't see warned on 36% of turns. Now it flags only numbers missing from complete excerpts: 8 flags across 545 replayed turns (1.3%), each one checked by hand. Recall is unmeasured: 31% of numbers can't be checked at all.
- **I predicted three failures before iteration 1, and all three passed.** What actually failed was the honesty-under-pressure case I hadn't thought of.
- **A 94% partial run didn't replicate.** The final runs score 85% on the same scenarios.
- **My cost estimates ran at least 2× high against the console,** and at first I didn't track the judge at all. Spend is now tracked per run and capped with `--budget`.
- **The judge got fairer partway through.** That alone moved core from 8/10 to 9/10 on unchanged answers, so I re-graded old runs before claiming any gain.

## Considered and rejected

- **Claude Managed Agents:** a hosted loop would hide exactly what the judges read, and it adds per-session containers that a one-tool agent doesn't need.
- **Sub-agents, or best-of-N with a runtime judge:** minutes per turn, and judges miss numbers.
- **A vector DB:** recall here is by date and topic.
- **Re-researching from scratch on "still correct?":** it loses the "then" side.
- **Web fetch or a second search API:** the brief says one tool.
- **Splitting search and writing to get streaming:** tested; the second call buffers too.

## Limits

- **Research answers arrive in one burst.** With server-side search, thinking models release nothing after a search until the answer is complete (Opus: 77 text pieces in 0.3 s, 8.9 s in). The UI streams each query as it starts instead.
- **The remaining failures are mostly source quality:** about 5 of the 12 final failures used a third-party page when the vendor's page was in the results.
- **The planner adds about 2 s to every turn.**
- **Single user, local memory.** There's no way yet to say "forget that".

## With another week

1. **Make primary sources a hard step.** If a key number comes from a third party, run one more search restricted with `allowed_domains` to the vendor before answering.
2. **Calibrate cost against the console's usage export,** instead of a price table.
3. **Measure guard recall:** seed answers with wrong numbers and count how many it catches.
4. **A fast path for obvious small talk,** and start the writer while the planner is still running.
5. **"Watch these 5 CRMs":** a daily re-check of stored claims, plus memory controls ("forget that").
