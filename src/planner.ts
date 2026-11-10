// Step 1 of a turn: one fast Haiku call that decides what kind of turn this is.
// It runs before any search, so small talk and memory questions never pay for web search,
// and research turns start with a plan (entities, neutral dated queries) instead of a guess.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.ts";

export const Plan = z.object({
  intent: z
    .enum(["smalltalk", "memory_only", "recheck", "search", "clarify"])
    .describe(
      "smalltalk: greetings, thanks, chit-chat, questions about you. " +
        "memory_only: only asks what was said before, no need for fresh facts. " +
        "recheck: asks whether something said or decided earlier is STILL TRUE or WHAT CHANGED since then. " +
        "Not recheck: asking where an answer came from, or a follow-up that reuses an earlier answer (new team size, a calculation): those are search. " +
        "search: needs current facts from the web. " +
        "clarify: impossible to act on without one missing detail AND no sensible default exists.",
    ),
  refers_to_past_conversation: z
    .boolean()
    .describe("True if the user points at an earlier chat with you ('I asked you', 'we shortlisted', 'your answer', 'last time')."),
  topic_keywords: z.array(z.string()).describe("2-6 keywords to find the earlier conversation in memory, e.g. ['postgres', 'hosting']."),
  entities: z.array(z.string()).describe("Named products, companies, people or places the answer is about."),
  search_queries: z
    .array(z.string())
    .describe(
      "For search/recheck: 1-5 neutral web queries, one per entity or sub-question, run in parallel. " +
        "For prices, plans, limits and launches use a site: query on the vendor's domain ('site:hubspot.com pricing'). For 'what changed' questions say 'changes since <date>' or the current month and year. " +
        "Never pin a past year unless the user did. Empty for other intents.",
    ),
  clarify_question: z.string().describe("For clarify only: the single question to ask. Empty otherwise."),
});
export type Plan = z.infer<typeof Plan>;

const SYSTEM = `You route messages for a chat assistant that has one tool, web search, and remembers past conversations.
Classify the latest user message and plan the turn. Be decisive.
- Prefer search over clarify: if a sensible default exists, plan the search and the assistant will state the assumption.
- A question about current prices, releases, news, people in roles, or anything that changes over time is search, even if it sounds simple.
- A follow-up that corrects you ("no, I meant X") is planned from scratch around the corrected target.
- If the user refers to an earlier chat and also asks whether it is still true or what changed, that is recheck.`;

export async function plan(
  client: Anthropic,
  input: { message: string; today: string; dates: string; history: string; memory: string },
): Promise<Plan> {
  const res = await client.messages.parse({
    model: config.fastModel,
    max_tokens: 1500,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: zodOutputFormat(Plan) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Today: ${input.today}\n` +
          `Dates mentioned (already resolved): ${input.dates || "none"}\n` +
          `Memory found for those dates/topics: ${input.memory || "none"}\n\n` +
          `Recent conversation:\n${input.history || "(new conversation)"}\n\n` +
          `Latest user message:\n${input.message}`,
      },
    ],
  });
  if (!res.parsed_output) throw new Error("planner returned no plan");
  return res.parsed_output;
}

/** Used when the planner call fails: search is the safe default for a web-search assistant. */
export const fallbackPlan = (message: string): Plan => ({
  intent: "search",
  refers_to_past_conversation: /\b(i asked|you said|we (?:shortlisted|discussed|talked)|last time|your answer)\b/i.test(message),
  topic_keywords: [],
  entities: [],
  search_queries: [],
  clarify_question: "",
});
