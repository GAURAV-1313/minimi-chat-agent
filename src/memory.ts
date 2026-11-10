// Long-term memory: every turn, and the dated claims each answer made, in one local SQLite file.
// Recall is by calendar day and by topic, which plain SQL indexes and FTS5 handle exactly. No embeddings.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export type Source = { id: number; url: string; title: string; pageAge: string | null };
export type Claim = {
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string | null;
  sourceDate: string | null;
};
/** A cited sentence from an answer and the exact source excerpt(s) it cites. */
export type Evidence = { text: string; citedTexts: string[]; sourceIds: number[] };
export type Turn = {
  id: number;
  threadId: string;
  createdAt: string;
  localDate: string;
  userText: string;
  answerText: string;
  intent: string;
  sources: Source[];
  evidence?: Evidence[];
};
export type StoredClaim = Claim & { turnId: number; observedOn: string };

export class Memory {
  private db: DatabaseSync;

  constructor(path = config.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        created_at TEXT NOT NULL,          -- UTC instant
        local_date TEXT NOT NULL,          -- the user's calendar day, so "on Monday" is a plain lookup
        user_text TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        intent TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS turns_day ON turns(local_date);
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(user_text, answer_text, content='turns', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, user_text, answer_text) VALUES (new.id, new.user_text, new.answer_text);
      END;
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        observed_on TEXT NOT NULL,         -- day the claim was true according to our search
        entity TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        source_url TEXT,
        source_date TEXT
      );
      CREATE INDEX IF NOT EXISTS claims_turn ON claims(turn_id);
      CREATE INDEX IF NOT EXISTS claims_entity ON claims(entity COLLATE NOCASE);
    `);
    this.migrate();
  }

  /** Databases created before evidence was stored get the column added in place. */
  private migrate() {
    const cols = (this.db.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("evidence_json")) this.db.exec("ALTER TABLE turns ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'");
  }

  createThread(id: string, title: string, createdAt: string) {
    this.db.prepare("INSERT OR IGNORE INTO threads (id, title, created_at) VALUES (?, ?, ?)").run(id, title, createdAt);
  }

  listThreads(limit = 50) {
    return this.db
      .prepare(
        `SELECT t.id, t.title, t.created_at AS createdAt, MAX(u.created_at) AS lastAt
         FROM threads t LEFT JOIN turns u ON u.thread_id = t.id
         GROUP BY t.id ORDER BY COALESCE(MAX(u.created_at), t.created_at) DESC LIMIT ?`,
      )
      .all(limit) as { id: string; title: string; createdAt: string; lastAt: string | null }[];
  }

  saveTurn(t: Omit<Turn, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO turns (thread_id, created_at, local_date, user_text, answer_text, intent, sources_json, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.threadId, t.createdAt, t.localDate, t.userText, t.answerText, t.intent, JSON.stringify(t.sources), JSON.stringify(t.evidence ?? []));
    return Number(r.lastInsertRowid);
  }

  saveClaims(turnId: number, observedOn: string, claims: Claim[]) {
    const ins = this.db.prepare(
      "INSERT INTO claims (turn_id, observed_on, entity, attribute, value, source_url, source_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of claims) ins.run(turnId, observedOn, c.entity, c.attribute, c.value, c.sourceUrl, c.sourceDate);
  }

  /** Recent turns of one conversation, oldest first, for the model's short-term context. */
  threadTurns(threadId: string, limit = 8): Turn[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
      .all(threadId, limit) as Row[];
    return rows.reverse().map(toTurn);
  }

  /** Every turn on the given local calendar days, across all conversations. */
  turnsOnDays(days: string[]): Turn[] {
    if (!days.length) return [];
    const rows = this.db
      .prepare(`SELECT * FROM turns WHERE local_date IN (${days.map(() => "?").join(",")}) ORDER BY id`)
      .all(...days) as Row[];
    return rows.map(toTurn);
  }

  turnsBetween(from: string, to: string): Turn[] {
    return (this.db.prepare("SELECT * FROM turns WHERE local_date BETWEEN ? AND ? ORDER BY id").all(from, to) as Row[]).map(toTurn);
  }

  /** Topic recall ("the Postgres hosting question") via FTS5, best match first. */
  searchTurns(terms: string[], limit = 5): Turn[] {
    const words = terms
      .flatMap((t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length > 2);
    if (!words.length) return [];
    const q = [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT turns.* FROM turns_fts JOIN turns ON turns.id = turns_fts.rowid
         WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`,
      )
      .all(q, limit) as Row[];
    return rows.map(toTurn);
  }

  claimsForTurns(ids: number[]): StoredClaim[] {
    if (!ids.length) return [];
    return this.db
      .prepare(
        `SELECT turn_id AS turnId, observed_on AS observedOn, entity, attribute, value,
                source_url AS sourceUrl, source_date AS sourceDate
         FROM claims WHERE turn_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...ids) as StoredClaim[];
  }

  firstDay(): string | null {
    const r = this.db.prepare("SELECT MIN(local_date) AS d FROM turns").get() as { d: string | null };
    return r.d;
  }

  /** Turns outside the given conversation: "do you remember what I asked?" is about other chats. */
  turnCount(excludeThread = ""): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE thread_id != ?").get(excludeThread) as { n: number }).n;
  }

  /** Days that have any conversation, newest first. Lets the agent say "I have chats from 9 and 10 Nov". */
  activeDays(limit = 14, excludeThread = ""): string[] {
    return (
      this.db.prepare("SELECT DISTINCT local_date AS d FROM turns WHERE thread_id != ? ORDER BY d DESC LIMIT ?").all(excludeThread, limit) as { d: string }[]
    ).map((r) => r.d);
  }

}

type Row = {
  id: number;
  thread_id: string;
  created_at: string;
  local_date: string;
  user_text: string;
  answer_text: string;
  intent: string;
  sources_json: string;
  evidence_json?: string;
};

const toTurn = (r: Row): Turn => ({
  id: r.id,
  threadId: r.thread_id,
  createdAt: r.created_at,
  localDate: r.local_date,
  userText: r.user_text,
  answerText: r.answer_text,
  intent: r.intent,
  sources: JSON.parse(r.sources_json),
  evidence: JSON.parse(r.evidence_json ?? "[]"),
});
