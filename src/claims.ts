// Step 5, after the answer has streamed (off the critical path): turn the answer into dated, sourced claims.
// "Is your answer still correct?" then becomes a claim-by-claim re-check, not a vague re-research.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.ts";
import type { Claim, Source } from "./memory.ts";

const Claims = z.object({
  claims: z.array(
    z.object({
      entity: z.string().describe("The product, company or thing, e.g. 'HubSpot Sales Hub'."),
      attribute: z.string().describe("What about it, e.g. 'Starter price', 'latest release', 'free tier'."),
      value: z
        .string()
        .describe("The value exactly as the answer's main text or table states it, with currency, units and billing basis. If the answer gives both a list and a promo price, record both in this field."),
      source_id: z.number().describe("Id of the source that supports it, or 0 if none."),
    }),
  ),
});

export async function extractClaims(client: Anthropic, question: string, answer: string, sources: Source[]): Promise<Claim[]> {
  if (!sources.length || answer.length < 40) return [];
  const list = sources.map((s) => `[${s.id}] ${s.title} (${s.url})${s.pageAge ? `, updated ${s.pageAge}` : ""}`).join("\n");
  const res = await client.messages.parse({
    model: config.fastModel,
    max_tokens: 2000,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: zodOutputFormat(Claims) },
    messages: [
      {
        role: "user",
        content:
          `Extract the checkable factual claims from this answer: prices, plan limits, release or launch facts, dates, versions, people in roles. ` +
          `Skip opinions and advice. At most 15 claims. Use the source the answer cites for each.\n\n` +
          `Question: ${question}\n\nAnswer:\n${answer}\n\nSources:\n${list}`,
      },
    ],
  });
  const byId = new Map(sources.map((s) => [s.id, s]));
  return (res.parsed_output?.claims ?? []).map((c) => {
    const s = byId.get(c.source_id);
    return { entity: c.entity, attribute: c.attribute, value: c.value, sourceUrl: s?.url ?? null, sourceDate: s?.pageAge ?? null };
  });
}
