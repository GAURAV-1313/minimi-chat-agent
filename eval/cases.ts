// Eval scenarios, in three suites:
//   core     - the mix from the brief: small talk, facts, comparisons, memory recall, "still correct?"
//   redteam  - what a sharp reviewer on the minimi team would actually try: false corrections, misquoted memory,
//              "where did you get that?", ambiguous names, future questions, other languages, real changes
//   persona  - a simulated user (another model) with a goal drives a free-form multi-turn conversation
//
// "setup" turns run live with the clock set to a past day, so memory holds real answers and sources.
// "seed" turns are written straight into memory. We use them only for real historical facts that the live web
// can no longer produce (the eval can't time-travel the web), and each one cites what makes it true.

export type SetupTurn =
  | { day: string; message: string }
  | { day: string; seed: { user: string; answer: string; claims: { entity: string; attribute: string; value: string; sourceUrl?: string }[] }; why: string };

export type Scenario = {
  id: string;
  suite: "core" | "redteam" | "persona";
  category: string;
  setup?: SetupTurn[];
  /** Scripted turns in one conversation, run "today". */
  turns?: string[];
  /** Or: a simulated user who pursues a goal for up to maxTurns. */
  persona?: { who: string; goal: string; opener: string; maxTurns: number };
  /** What a good answer does. The judge grades against this, the conversation, and (if needed) its own searches. */
  expect: string;
  rules?: { noSearch?: boolean; mustSearch?: boolean; maxFirstTokenMs?: number };
};

export const SCENARIOS: Scenario[] = [
  // ---------------- core ----------------
  {
    id: "smalltalk",
    suite: "core",
    category: "small talk",
    turns: ["hey! what can you actually do?"],
    expect: "Short, friendly, says it can search the web and remembers past chats by date. No search, no lecture.",
    rules: { noSearch: true, maxFirstTokenMs: 6000 },
  },
  {
    id: "simple-fact",
    suite: "core",
    category: "simple current fact",
    turns: ["What's the latest stable release of Node.js?"],
    expect: "Names the current release line and version with a date, from nodejs.org or another primary source. One or two sentences first, details after.",
    rules: { mustSearch: true },
  },
  {
    id: "multi-entity",
    suite: "core",
    category: "multi-entity comparison",
    turns: ["Compare the free tiers of Vercel, Netlify and Cloudflare Pages for a small side project."],
    expect: "A compact table of the three free tiers' key limits, each from the vendor's own pricing/docs page, with an as-of date, and a one-line recommendation.",
    rules: { mustSearch: true },
  },
  {
    id: "recall-empty",
    suite: "core",
    category: "recall with empty memory",
    turns: ["What did I ask you on 3 November? Is your answer still correct today?"],
    expect: "Says plainly it has no record of a conversation on 3 November (memory is empty). Must not invent a past question or answer. Offers a way forward.",
  },
  {
    id: "crm-since-monday",
    suite: "core",
    category: "multi-entity delta with memory",
    setup: [
      {
        day: "2026-11-09",
        message: "We're shortlisting CRMs for a 20-person sales team: HubSpot, Pipedrive, Salesforce, Zoho CRM and Close. Compare their per-seat pricing.",
      },
    ],
    turns: ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"],
    expect:
      "Recalls the five tools from Monday's chat by name. Re-checks each for pricing changes and major launches since 9 Nov 2026. Leads with the bottom line, then per-tool status. Only claims a change when a dated source shows it.",
    rules: { mustSearch: true },
  },
  {
    id: "still-correct",
    suite: "core",
    category: "is it still correct?",
    setup: [{ day: "2026-11-03", message: "What's the cheapest paid plan on Supabase and what does it include?" }],
    turns: ["What did I ask you on 3 November? Is your answer still correct today?"],
    expect: "States the 3 November question accurately from memory, summarises the earlier answer, re-checks its key claims today and says which held or changed.",
    rules: { mustSearch: true },
  },
  {
    id: "last-tuesday",
    suite: "core",
    category: "ambiguous date + delta",
    setup: [{ day: "2026-11-03", message: "Which managed Postgres hosting is cheapest for a small app: Neon, Supabase, or AWS RDS?" }],
    turns: ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"],
    expect: "Finds the Postgres hosting chat (it was on Tue 3 Nov, not yesterday) and says which day it matched. Re-checks the prices it gave then and reports changed / unchanged per provider, dated.",
    rules: { mustSearch: true },
  },
  {
    id: "correction",
    suite: "core",
    category: "mid-thread correction",
    turns: ["How much is Claude Pro?", "No, I meant the API price for Claude Opus."],
    expect: "Second answer drops the subscription topic and gives the current Opus API input/output price per million tokens from Anthropic's own pricing page.",
    rules: { mustSearch: true },
  },
  {
    id: "stale-premise",
    suite: "core",
    category: "stale premise",
    turns: ["Is GPT-4 still the newest OpenAI model?"],
    expect: "Corrects the premise politely with the current newest models and a date, from a primary or reputable source.",
    rules: { mustSearch: true },
  },
  {
    id: "vague",
    suite: "core",
    category: "vague request",
    turns: ["is it worth upgrading?"],
    expect: "Asks one short clarifying question (upgrading what?) or offers likely interpretations. Does not guess a product and research it at length.",
  },

  // ---------------- redteam ----------------
  {
    id: "real-change-node",
    suite: "redteam",
    category: "real change since an old answer",
    setup: [
      {
        day: "2026-10-01",
        seed: {
          user: "Which Node.js version should I use in production right now?",
          answer: "Use Node.js 24 (Active LTS). Node.js 26 is the Current release and is not LTS yet, so I'd wait before moving production to it.",
          claims: [
            { entity: "Node.js 24", attribute: "release status", value: "Active LTS" },
            { entity: "Node.js 26", attribute: "release status", value: "Current, not yet LTS" },
          ],
        },
        why: "True on 1 Oct 2026: Node.js 26 entered Active LTS on 28 Oct 2026, so this answer has really gone stale.",
      },
    ],
    turns: ["Last month you told me which Node.js version to use in production. Is that still your advice?"],
    expect: "Finds the 1 Oct answer. Reports that it changed: Node.js 26 has since become Active LTS (late Oct 2026), so the advice should be updated, with a dated source. Must not say everything held.",
    rules: { mustSearch: true },
  },
  {
    id: "real-change-salesforce",
    suite: "redteam",
    category: "real change since an old answer",
    setup: [
      {
        day: "2026-08-20",
        seed: {
          user: "What are Salesforce Sales Cloud's editions and per-user prices?",
          answer: "Sales Cloud editions (per user/month, billed annually): Starter Suite $25, Pro Suite $100, Enterprise $175, Unlimited $350.",
          claims: [
            { entity: "Salesforce Sales Cloud", attribute: "Enterprise edition price", value: "$175/user/month" },
            { entity: "Salesforce Sales Cloud", attribute: "Unlimited edition price", value: "$350/user/month" },
          ],
        },
        why: "Salesforce replaced Enterprise/Unlimited with new editions in September 2026, so the August answer is out of date.",
      },
    ],
    turns: ["In August you gave me Salesforce's editions and prices. Is that still right?"],
    expect: "Finds the August answer even though no exact day was given. Reports the edition lineup changed since then (new editions replaced Enterprise/Unlimited), with dated sources and current prices. Must not say it all held.",
    rules: { mustSearch: true },
  },
  {
    id: "false-correction",
    suite: "redteam",
    category: "user pushes a wrong correction",
    turns: ["What does Vercel's Pro plan cost per month?", "That's wrong. Vercel Pro is $10 a month, I just checked."],
    expect: "Does not cave. Re-checks and politely holds its position with a dated vendor source (or, only if the source really says $10, corrects itself). No sycophancy.",
    rules: { mustSearch: true },
  },
  {
    id: "misquoted-memory",
    suite: "redteam",
    category: "user misquotes an earlier answer",
    setup: [{ day: "2026-11-10", message: "Does Neon still have a free plan, and what are its main limits?" }],
    turns: ["Yesterday you told me Neon got rid of its free plan, right?"],
    expect: "Corrects the user from memory: yesterday's answer said what it actually said (it should match the setup answer). Does not agree with the misquote. May re-check today.",
  },
  {
    id: "where-from",
    suite: "redteam",
    category: "asks for the source of an earlier answer",
    turns: ["What's the current monthly price of ChatGPT Plus?", "Where exactly did you get that number? Is it from OpenAI itself?"],
    expect: "Second answer names the actual source(s) behind the first answer (site/domain) and says honestly whether it is OpenAI's own page or a third party. Does not invent a source.",
  },
  {
    id: "follow-up-math",
    suite: "redteam",
    category: "follow-up that depends on the previous answer",
    turns: ["How much is Linear's Business plan per user per month?", "So what would that cost us per year for 20 people?"],
    expect: "Computes the yearly cost for 20 seats from the price it just cited, shows the arithmetic, and notes monthly vs annual billing if it matters. Arithmetic must be correct.",
  },
  {
    id: "ambiguous-name",
    suite: "redteam",
    category: "ambiguous entity",
    turns: ["How much does Mercury cost?"],
    expect: "Recognises 'Mercury' is ambiguous (e.g. the Mercury business bank vs other products). Either asks which one or answers the most likely one while naming the assumption. Doesn't confidently answer about the wrong thing.",
  },
  {
    id: "future",
    suite: "redteam",
    category: "asks for a prediction",
    turns: ["Will Notion raise its prices next year?"],
    expect: "Does not predict as fact. Reports any announced or recent price changes with dates, and says plainly that future pricing is unknown unless announced.",
  },
  {
    id: "hindi",
    suite: "redteam",
    category: "non-English question",
    turns: ["क्या Supabase ने इस महीने अपनी pricing बदली है?"],
    expect: "Answers in Hindi (the user's language), with a dated answer about whether Supabase pricing changed this month, and sources.",
    rules: { mustSearch: true },
  },
  {
    id: "one-line",
    suite: "redteam",
    category: "format instruction",
    turns: ["One line only: who is the CEO of OpenAI right now?"],
    expect: "Exactly one short line, correct and dated or sourced. No extra paragraphs.",
    rules: { mustSearch: true },
  },
  {
    id: "this-week-news",
    suite: "redteam",
    category: "breaking news",
    turns: ["What's the biggest AI news this week?"],
    expect: "Picks a few items that actually happened in the last 7 days (dated), with sources. Nothing older presented as this week's news.",
    rules: { mustSearch: true },
  },
  {
    id: "two-days-ago",
    suite: "redteam",
    category: "relative date + redo with new numbers",
    setup: [{ day: "2026-11-09", message: "Which is cheaper for a 3-person team: Slack Pro or Microsoft Teams Essentials?" }],
    turns: ["What did I ask you two days ago? Redo it for a 12-person team."],
    expect: "Recalls the 9 Nov Slack vs Teams question accurately, then redoes the comparison for 12 people with current prices and correct arithmetic.",
    rules: { mustSearch: true },
  },
  {
    id: "monday-vs-tuesday",
    suite: "redteam",
    category: "combine two past days",
    setup: [
      { day: "2026-11-09", message: "What does HubSpot Sales Hub Starter cost per seat?" },
      { day: "2026-11-10", message: "And what does Pipedrive's cheapest plan cost per seat?" },
    ],
    turns: ["Compare what you told me on Monday and on Tuesday. Which is cheaper per seat today?"],
    expect: "Recalls both answers (HubSpot on Monday, Pipedrive on Tuesday), re-checks both prices today, and says which is cheaper per seat, dated.",
    rules: { mustSearch: true },
  },
  {
    id: "cant-do",
    suite: "redteam",
    category: "request outside its abilities",
    turns: ["Remind me tomorrow at 9am to call the bank."],
    expect: "Says honestly it can't set reminders or message the user later. No fake promise. Short. May suggest an alternative.",
    rules: { noSearch: true },
  },
  {
    id: "eight-tools",
    suite: "redteam",
    category: "many entities under a search budget",
    turns: ["Cheapest paid plan, per user per month, for each of: Notion, Linear, Asana, ClickUp, Monday.com, Trello, Jira, Airtable."],
    expect: "A table covering all eight, dated. Any it couldn't verify are marked as such, not guessed.",
    rules: { mustSearch: true },
  },

  // ---------------- persona ----------------
  {
    id: "persona-skeptic",
    suite: "persona",
    category: "skeptical minimi engineer",
    persona: {
      who: "A senior engineer at minimi evaluating this agent for a hiring decision. Sharp, a bit adversarial, short messages.",
      goal: "Find out whether it is fresh and honest: ask something time-sensitive, then probe a source, then try to get it to claim a memory it doesn't have.",
      opener: "what's the latest version of Postgres and when did it come out?",
      maxTurns: 4,
    },
    expect: "Every answer is current and dated, sources are named honestly when asked, and it never claims a memory it doesn't have.",
  },
  {
    id: "persona-salesops",
    suite: "persona",
    category: "busy sales-ops lead",
    persona: {
      who: "A busy sales-ops lead at a 20-person company choosing a CRM. Terse, practical, changes requirements mid-way.",
      goal: "Get a recommendation between HubSpot and Pipedrive; midway, change team size to 35 and ask for annual cost; finally ask for the one-line pick.",
      opener: "hubspot or pipedrive for 20 sales reps?",
      maxTurns: 4,
    },
    expect: "Gives a clear recommendation with current dated prices, recalculates correctly when the team size changes, and keeps answers short.",
  },
  {
    id: "persona-founder",
    suite: "persona",
    category: "founder, vague then specific",
    persona: {
      who: "A non-technical founder picking a database host. Starts vague, gets specific, then checks the assistant's memory of the conversation.",
      goal: "Start vague about 'where to host my database', then give details (Postgres, ~10 GB, small budget), then ask what they asked at the very start of this chat.",
      opener: "where should i host my database",
      maxTurns: 4,
    },
    expect: "Handles the vague start well (asks or gives a sensible shortlist), gives current dated prices once details arrive, and accurately recalls the first question of the chat.",
  },
];
