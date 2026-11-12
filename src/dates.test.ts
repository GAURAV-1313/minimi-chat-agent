import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDates } from "./dates.ts";

// Wednesday 11 Nov 2026, 10:00 in India.
const clock = { now: new Date("2026-11-11T04:30:00Z"), tz: "Asia/Kolkata" };
const one = (t: string) => resolveDates(t, clock)[0];

test("bare weekday means the most recent one", () => {
  assert.equal(one("On Monday we shortlisted 5 CRM tools").date, "2026-11-09");
  // Ambiguous: yesterday, or Tuesday of last week. Keep both; memory decides.
  const last = one("Last Tuesday I asked you about Postgres hosting");
  assert.equal(last.date, "2026-11-10");
  assert.deepEqual(last.alternatives, ["2026-11-03"]);
});
test("a date without a year is in the past", () => {
  assert.equal(one("What did I ask you on 3 November?").date, "2026-11-03");
  assert.equal(one("what about 20 December?").date, "2025-12-20");
});
test("explicit future stays future", () => {
  assert.equal(one("what is on next Monday").date, "2026-11-16");
});
test("yesterday and today", () => {
  assert.equal(one("what did we discuss yesterday").date, "2026-11-10");
});
test("timezone decides the day", () => {
  // 23:30 UTC on the 10th is already the 11th in India.
  const late = { now: new Date("2026-11-10T23:30:00Z"), tz: "Asia/Kolkata" };
  assert.equal(resolveDates("today", late)[0].date, "2026-11-11");
  assert.equal(resolveDates("today", { ...late, tz: "America/New_York" })[0].date, "2026-11-10");
});

test("a bare month name or 'last month' is the whole month", () => {
  assert.deepEqual(one("In August you gave me Salesforce's editions").range, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(one("Last month you told me which Node.js version").range, { from: "2026-10-01", to: "2026-10-31" });
  // A month that hasn't happened yet this year means last year's.
  assert.deepEqual(one("what did we discuss in December?").range, { from: "2025-12-01", to: "2025-12-31" });
});
test("a product named after a weekday is not a date", () => {
  assert.equal(resolveDates("Cheapest plan for Notion, Monday.com and Trello?", clock).length, 0);
  assert.equal(resolveDates("Is monday.com cheaper than Asana?", clock).length, 0);
  // the real weekday still works, including at the end of a sentence
  assert.equal(one("What did we shortlist on Monday.").date, "2026-11-09");
  assert.equal(one("What did we discuss on Monday.Can you remind me?").date, "2026-11-09");
});
test("relative days", () => {
  assert.equal(one("What did I ask you two days ago?").date, "2026-11-09");
});

test("'this week' is the last seven days", () => {
  assert.deepEqual(one("What's the biggest AI news this week?").range, { from: "2026-11-05", to: "2026-11-11" });
});
