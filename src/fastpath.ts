// Latency shortcuts around the planner (about 2 s of every turn, DECISIONS.md #2).
//
// 1. Fast path: a message that is obviously small talk ("hey!", "thanks", "what can you do?") skips the planner
//    entirely. The pattern is deliberately narrow: the whole message must be a greeting, thanks or a question about
//    Pip, so "hey, what does Notion cost?" still goes through the planner.
// 2. Speculation: a message that looks like a fresh research question (no dates, no reference to an earlier chat)
//    can start the search writer while the planner runs. Its output is held back until the planner agrees.
import type { DateMention } from "./dates.ts";
import type { Plan } from "./planner.ts";

const WORDS = [
      "h+i+",
      "he+y+",
      "hello+",
      "hiya",
      "yo",
      "sup",
      "good (?:morning|afternoon|evening|night)",
      "gm",
      "gn",
      "thanks?",
      "thank you(?: so much| very much)?",
      "thx",
      "ty",
      "ok(?:ay)?",
      "k",
      "cool",
      "nice",
      "great",
      "awesome",
      "perfect",
      "got it",
      "bye",
      "see (?:you|ya)",
      "who are you",
      "what are you",
      "what can you do",
      "what do you do",
      "help",
].join("|");
const TAIL = "pip|there|again|a lot|so much|mate|buddy";
// One or more small-talk words ("cool, thanks", "ok thanks pip"), then only punctuation or emoji.
const SMALLTALK = new RegExp(
  // Emoji may carry a skin-tone modifier or the emoji-style selector (👍🏽, ❤️).
  `^\\s*(?:${WORDS})(?:[\\s,!.]+(?:${WORDS}|${TAIL}))*[\\s!.?,:)(]*(?:\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F\\u200D]*[\\s!.?]*)*$`,
  "iu",
);

export function isSmallTalk(message: string): boolean {
  return message.length <= 60 && SMALLTALK.test(message);
}

/**
 * The plan the planner would produce for obvious small talk, without the ~2 s call. `previous` is the last turn in
 * this chat: "ok" or "great" right after Pip asked something ("shall I check the other five?") is an answer, not
 * small talk, so it goes to the planner, which sees the conversation.
 */
export function fastPlan(message: string, previous?: { intent: string; answerText: string }): Plan | null {
  if (!isSmallTalk(message)) return null;
  if (previous && (previous.intent === "clarify" || /\?\s*\)?\s*$/.test(previous.answerText.trim()))) return null;
  return { intent: "smalltalk", refers_to_past_conversation: false, topic_keywords: [], entities: [], search_queries: [], clarify_question: "" };
}

// Words that point at an earlier chat or ask for a re-check: these turns need the planner's memory lookup first.
const PAST_REFERENCE = /\b(?:i asked|you (?:said|told|gave|answered|recommended)|we (?:talked|discussed|shortlisted|picked|chose)|earlier|last time|before|previous(?:ly)?|still (?:correct|right|true|valid)|changed since|since (?:then|we)|remember|recall|that answer|your answer)\b/i;

/**
 * Speculate only on messages that look like fresh research: no dates (which pull in memory), no reference to an
 * earlier chat, and long enough to be a real question. Everything else waits for the planner as before.
 */
export function shouldSpeculate(message: string, mentions: DateMention[]): boolean {
  if (mentions.length) return false;
  if (PAST_REFERENCE.test(message)) return false;
  if (message.trim().length < 12) return false;
  return !isSmallTalk(message);
}
