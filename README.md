# minimi: a chat agent with web search and a dated memory

Ask it anything current. It searches the web, shows its sources with their dates, and remembers what you discussed, so you can come back days later and ask *"has anything changed since Monday?"*

The assistant is **Pip**, a cat that sits on the message box and shows what it's doing: blinking while idle, looking around while it searches, and squinting happily when the answer lands.

## Run it

Needs **Node 22.13 or newer** and an **Anthropic API key** (the only key; web search runs through the same key).

```bash
npm install
cp .env.example .env    # then paste your ANTHROPIC_API_KEY into .env
npm run dev
```

Open **http://localhost:3000**. If the key is missing or wrong, the page tells you so.

- Architecture diagrams: http://localhost:3000/architecture (or `docs/architecture.html`)
- How it works and why: [`DESIGN.md`](DESIGN.md)

## Things to try

- *"Compare HubSpot, Pipedrive, Salesforce, Zoho and Close pricing for a 20-person sales team."* A day or more later, in a new chat: *"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"*
- *"What did I ask you on 3 November? Is your answer still correct today?"* On a fresh install it should tell you it has no record of that, not invent one.
- *"How much is Claude Pro?"* then *"no, I meant the Opus API price"*.

Memory is a SQLite file at `data/minimi.db`. Delete it to start fresh.

## Other commands

```bash
npm test            # unit tests: date resolution, number guard
npm run typecheck
npm run eval        # 28 scenarios end to end: real models + real search, graded by a separate judge (~$2.50 estimated per run)
```

- **Suites:** `core` (the brief's kinds of questions), `redteam` (false corrections, misquoted memory, "where did you get that?", real changes since an old answer, Hindi, …) and `persona` (a simulated user drives a multi-turn chat).
- **Flags:**
  - `--suite redteam` runs one suite.
  - `--only hindi,cant-do` runs specific scenarios.
  - `--budget 3` stops starting new scenarios once about $3 is spent.
  - `--rejudge <results.json>` re-grades old transcripts with the current judge.
- **A/B another answer model:** `ANSWER_MODEL=claude-sonnet-5-5 npm run eval`.
- **Reports:**
  - `npx tsx eval/report.ts <label>` combines repeat runs into per-scenario pass rates.
  - `npx tsx eval/replay-guard.ts` re-runs the number guard over every stored transcript, with no API calls.
