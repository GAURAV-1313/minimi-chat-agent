// Step 3: the single writer. One streaming call to the answer model with Claude's built-in web search.
// The model runs its searches server-side (several in parallel when the question has several parts),
// and we turn the stream into UI events: search queries, results with page dates, answer text, citations.
import Anthropic from "@anthropic-ai/sdk";
import { BLOCKED_DOMAINS, config } from "./config.ts";
import type { CitedSpan } from "./guard.ts";
import type { Source } from "./memory.ts";
import { ANSWER_SYSTEM } from "./prompts.ts";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "results"; query: string; results: Source[] }
  | { type: "text"; delta: string }
  | { type: "preamble_end" } // text so far was the model thinking aloud before a search, not the answer
  | { type: "cite"; ids: number[] }
  | { type: "sources"; sources: Source[] }
  | { type: "evidence"; spans: CitedSpan[] } // cited sentences + the exact source text they cite (for the eval judge)
  | { type: "guard"; unverified: { value: string; sentence: string; sourceIds: number[] }[] }
  | { type: "done"; meta: Record<string, unknown> }
  | { type: "error"; message: string };

export type AnswerInput = {
  model: string;
  history: Anthropic.MessageParam[];
  context: string;
  search: boolean;
  maxSearches: number;
  effort: "low" | "medium" | "high";
  timezone: string;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
};

export type AnswerResult = {
  text: string; // the final answer only (text after the last search)
  sources: Source[]; // every result seen, numbered
  cited: number[]; // ids of sources the answer cites
  spans: CitedSpan[]; // cited sentences, for the guard
  searches: number;
  usage: { input: number; output: number; cacheRead: number; searches: number };
  stopReason: string | null;
  aborted: boolean;
};

export async function answer(client: Anthropic, inp: AnswerInput): Promise<AnswerResult> {
  const tools = inp.search
    ? [
        {
          type: "web_search_20260318" as const,
          name: "web_search" as const,
          max_uses: inp.maxSearches,
          // Direct calls: the model sees results straight away. Dynamic filtering (via code execution) saves
          // tokens on huge result sets but adds a code-execution step to every search; for chat latency we skip it.
          allowed_callers: ["direct" as const],
          blocked_domains: BLOCKED_DOMAINS,
          user_location: { type: "approximate" as const, timezone: inp.timezone },
        },
      ]
    : undefined;

  const sources: Source[] = [];
  const byUrl = new Map<string, number>();
  const sourceId = (url: string, title: string, pageAge: string | null) => {
    let id = byUrl.get(url);
    if (id === undefined) {
      id = sources.length + 1;
      byUrl.set(url, id);
      sources.push({ id, url, title, pageAge });
    }
    return id;
  };

  const messages: Anthropic.MessageParam[] = [...inp.history];
  const cited = new Set<number>();
  let spans: CitedSpan[] = [];
  let finalText = "";
  let searches = 0;
  let stopReason: string | null = null;
  let aborted = false;
  const usage = { input: 0, output: 0, cacheRead: 0, searches: 0 };
  const queryById = new Map<string, string>();

  // pause_turn: the server-side search loop hit its iteration limit. Send the turn back to let it continue.
  for (let round = 0; round < 3; round++) {
    const stream = client.messages.stream(
      {
        model: inp.model,
        max_tokens: 8000,
        // Haiku runs with thinking off: it is the one setup where text after a search streams token by token.
        // Thinking models (Opus/Sonnet) hold everything after a search until the answer is complete.
        ...(inp.model.includes("haiku") ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { effort: inp.effort },
        system: [
          { type: "text", text: ANSWER_SYSTEM, cache_control: { type: "ephemeral" } },
          { type: "text", text: inp.context },
        ],
        ...(tools ? { tools } : {}),
        messages,
      },
      { signal: inp.signal },
    );

    stream.on("text", (delta) => {
      finalText += delta;
      inp.emit({ type: "text", delta });
    });

    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const query = String((block.input as { query?: string })?.query ?? "");
        queryById.set(block.id, query);
        searches++;
        // Anything written before a search was thinking aloud, not the answer.
        if (finalText.trim()) inp.emit({ type: "preamble_end" });
        finalText = "";
        spans = [];
        inp.emit({ type: "search", query });
      } else if (block.type === "web_search_tool_result") {
        const query = queryById.get(block.tool_use_id) ?? "";
        if (Array.isArray(block.content)) {
          const results = block.content.map((r) => ({ id: sourceId(r.url, r.title, r.page_age), url: r.url, title: r.title, pageAge: r.page_age }));
          inp.emit({ type: "results", query, results });
        } else {
          inp.emit({ type: "status", text: `Search failed (${block.content.error_code})` });
        }
      } else if (block.type === "text" && block.citations?.length) {
        const ids: number[] = [];
        const citedTexts: string[] = [];
        for (const c of block.citations) {
          if (c.type !== "web_search_result_location") continue;
          const id = sourceId(c.url, c.title ?? c.url, null);
          if (!ids.includes(id)) ids.push(id);
          cited.add(id);
          citedTexts.push(c.cited_text);
        }
        if (ids.length) {
          spans.push({ text: block.text, citedTexts, sourceIds: ids });
          inp.emit({ type: "cite", ids });
        }
      }
    });

    let msg: Anthropic.Message;
    try {
      msg = await stream.finalMessage();
    } catch (err) {
      if (inp.signal.aborted) {
        aborted = true;
        break;
      }
      throw err;
    }
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
    stopReason = msg.stop_reason;
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }

  return { text: finalText.trim(), sources, cited: [...cited], spans, searches, usage, stopReason, aborted };
}
