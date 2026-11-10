import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/config.ts";
const client = new Anthropic({ apiKey: config.apiKey });
const model = process.env.PB_MODEL!;
const thinking = process.env.PB_THINKING ? { type: process.env.PB_THINKING } : undefined;
const t0 = Date.now();
const s = client.messages.stream({
  model, max_tokens: 4000, ...(thinking ? { thinking: thinking as any } : {}), ...(model.includes("haiku") ? {} : { output_config: { effort: "low" } }),
  tools: [{ type: "web_search_20260318", name: "web_search", max_uses: 4, allowed_callers: ["direct"] }],
  system: "Search for each item in parallel in one step. Then answer with a compact table.",
  messages: [{ role: "user", content: "Compare the current monthly price of Vercel Pro, Netlify Pro and Render Pro." }],
});
let first = 0, n = 0, searchAt = 0, resAt = 0;
for await (const e of s) {
  if (e.type === "content_block_start" && e.content_block.type === "server_tool_use" && !searchAt) searchAt = Date.now() - t0;
  if (e.type === "content_block_start" && e.content_block.type === "web_search_tool_result" && !resAt) resAt = Date.now() - t0;
  if (e.type === "content_block_delta" && e.delta.type === "text_delta") { if (!first) first = Date.now() - t0; n++; }
}
const m = await s.finalMessage();
console.log(model, process.env.PB_THINKING ?? "default", "| first search", searchAt, "| first result", resAt, "| first text", first, "| total", Date.now() - t0, "| deltas", n, "| searches", m.usage.server_tool_use?.web_search_requests, "| out tok", m.usage.output_tokens);
