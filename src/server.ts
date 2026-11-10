// HTTP server: serves the chat page and streams each turn as Server-Sent Events. No framework needed.
import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, isAuthError, isBillingError } from "./agent.ts";
import { config, hasKey } from "./config.ts";
import { isValidTz } from "./dates.ts";
import { Memory } from "./memory.ts";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const VENDOR: Record<string, string> = {
  "/vendor/marked.js": fileURLToPath(import.meta.resolve("marked")),
  "/vendor/purify.js": fileURLToPath(import.meta.resolve("dompurify/dist/purify.min.js")),
};
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const memory = new Memory();
const agent = new Agent(new Anthropic({ apiKey: config.apiKey || "missing", maxRetries: 2 }), memory);
let keyRejected = false;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const KEY_HELP =
  "No working ANTHROPIC_API_KEY. Copy .env.example to .env, put your key in it, and restart `npm run dev`.";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/status") {
      return json(res, 200, { ok: hasKey() && !keyRejected, help: hasKey() && !keyRejected ? null : KEY_HELP, model: [...new Set(Object.values(config.models))].map((m) => m.replace("claude-", "")).join(" · ") });
    }
    if (url.pathname === "/api/threads" && req.method === "GET") return json(res, 200, memory.listThreads());
    const m = url.pathname.match(/^\/api\/threads\/([\w-]{1,64})$/);
    if (m && req.method === "GET") return json(res, 200, memory.threadTurns(m[1], 200));

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { threadId, message, tz } = await body(req);
      if (typeof threadId !== "string" || !/^[\w-]{1,64}$/.test(threadId) || typeof message !== "string" || !message.trim()) {
        return json(res, 400, { error: "threadId and message are required" });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (!hasKey() || keyRejected) {
        send({ type: "error", message: KEY_HELP });
        return res.end();
      }
      try {
        await agent.runTurn({ threadId, message: message.trim().slice(0, 4000), tz: isValidTz(tz) ? tz : "UTC" }, send);
      } catch (err) {
        console.error(err);
        if (isAuthError(err)) keyRejected = true;
        send({ type: "error", message: isAuthError(err) ? KEY_HELP : friendlyError(err) });
      }
      return res.end();
    }

    // Two browser libraries, served straight from node_modules so the page needs no build step or CDN.
    const vendor = VENDOR[url.pathname];
    if (vendor) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(await readFile(vendor));
    }

    // The architecture diagrams, so reviewers can open them from the running app.
    if (url.pathname === "/architecture") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(await readFile(fileURLToPath(new URL("../docs/architecture.html", import.meta.url))));
    }

    // Static files from public/.
    const path = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(PUBLIC)) return json(res, 404, { error: "not found" });
    const file = await readFile(path).catch(() => null);
    if (!file) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

function friendlyError(err: unknown): string {
  // Found when our own eval drained the account: the API returns a plain 400 for this, so without a
  // specific message the user saw "something went wrong" and had no idea what to do.
  if (isBillingError(err))
    return "Your Anthropic account is out of credits. Add credits at console.anthropic.com (Plans & Billing), then try again.";
  if (err instanceof Anthropic.RateLimitError) return "The model API is rate-limiting us. Give it a few seconds and try again.";
  if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) return "The model API had a hiccup. Please try again.";
  if (err instanceof Anthropic.APIConnectionError) return "I couldn't reach the model API. Check your internet connection.";
  return "Something went wrong on my side. Please try again.";
}

server.listen(config.port, () => {
  console.log(`\n  minimi chat agent → http://localhost:${config.port}\n`);
  if (!hasKey()) console.log(`  ⚠ ${KEY_HELP}\n`);
  console.log(`  models: chat ${config.models.chat} · search ${config.models.search} · recheck ${config.models.recheck} · fast model: ${config.fastModel} · memory: ${config.dbPath}\n`);
});
