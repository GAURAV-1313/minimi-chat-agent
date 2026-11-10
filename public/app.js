// Chat page. Plain JS, no build step. Renders the server's event stream (status, searches, answer, citations,
// sources) and drives Pip, the cat perched on the message box, who shows what the agent is doing.
import { marked } from "/vendor/marked.js";
import { catSVG } from "/cat.js";

const $ = (s) => document.querySelector(s);
const log = $("#log");
const input = $("#input");
const sendBtn = $("#send");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let threadId = location.hash.slice(1) || newId();
let busy = false;

const EXAMPLES = [
  "We're picking a CRM for a 20-person sales team. Compare HubSpot, Pipedrive, Salesforce, Zoho and Close on price.",
  "Which managed Postgres host is cheapest for a 20 GB database right now?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "What's the latest stable Node.js release, and what's new in it?",
];

marked.setOptions({ gfm: true, breaks: false });

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

// ---------- Pip ----------

const pip = $("#pip");
const pipSays = $("#pip-says");
pip.innerHTML = catSVG({ pose: "perch", state: "idle", label: "Pip, the assistant" });
$(".brand-cat").innerHTML = catSVG({ state: "idle", label: "" });
let happyTimer = 0;

function setPip(state, says = "") {
  clearTimeout(happyTimer);
  pip.firstElementChild.setAttribute("class", `cat ${state}`);
  pipSays.textContent = says;
  pipSays.classList.toggle("show", Boolean(says));
  if (state === "happy") happyTimer = setTimeout(() => setPip("idle"), 2400);
}

// ---------- rendering ----------

/** Markdown -> safe HTML, with ⟦1,2⟧ citation markers turned into numbered links. */
function renderAnswer(md, sourcesById) {
  const html = marked.parse(md).replace(/⟦([\d,]+)⟧/g, (_, ids) =>
    ids
      .split(",")
      .map((id) => {
        const s = sourcesById.get(Number(id));
        return s
          ? `<sup class="cite"><a href="${encodeURI(s.url)}" target="_blank" rel="noopener" title="${escapeAttr(s.title)}">${id}</a></sup>`
          : "";
      })
      .join(""),
  );
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
const escapeAttr = (s) => String(s ?? "").replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

function renderSources(container, sources) {
  container.replaceChildren();
  for (const s of sources) {
    const a = el("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = s.title;
    a.append(el("b", "", String(s.id)), el("span", "host", host(s.url)));
    if (s.pageAge) a.append(el("span", "age", s.pageAge));
    container.append(a);
  }
}

function addUser(text) {
  $("#empty")?.remove();
  log.append(el("div", "msg user", text));
}

/** One assistant message, fed by server events. */
function botMessage() {
  const root = el("div", "msg bot");
  const activity = el("details", "activity");
  activity.open = true;
  activity.hidden = true;
  const summary = el("summary");
  const steps = el("ul");
  activity.append(summary, steps);
  const answer = el("div", "answer typing");
  const guard = el("div", "guard");
  guard.hidden = true;
  const sources = el("div", "sources");
  const meta = el("div", "meta");
  root.append(activity, answer, sources, guard, meta);
  log.append(root);

  const sourcesById = new Map();
  const queryItems = new Map();
  let md = "";
  let frame = 0;
  let writing = false;

  const step = (node) => {
    activity.hidden = false;
    summary.textContent = "What I'm checking";
    steps.append(node);
    scroll();
  };
  const paint = () => {
    frame = 0;
    answer.innerHTML = renderAnswer(md, sourcesById);
    scroll();
  };
  const schedule = () => (frame ||= requestAnimationFrame(paint));

  setPip("searching", "Thinking");

  return {
    handle(e) {
      switch (e.type) {
        case "status":
          step(el("li", "", e.text));
          setPip("searching", e.text);
          break;
        case "search": {
          const li = el("li");
          li.append(el("span", "", "Searched for "), el("span", "q", `“${e.query}”`));
          queryItems.set(e.query, li);
          step(li);
          setPip("searching", `Searching “${e.query.length > 38 ? e.query.slice(0, 37) + "…" : e.query}”`);
          break;
        }
        case "results": {
          for (const r of e.results) sourcesById.set(r.id, r);
          const li = queryItems.get(e.query);
          if (!li) break;
          const box = el("div", "results");
          for (const r of e.results.slice(0, 4)) {
            const a = el("a", "", `${host(r.url)}: ${r.title}${r.pageAge ? ` (${r.pageAge})` : ""}`);
            a.href = r.url;
            a.target = "_blank";
            a.rel = "noopener";
            box.append(a);
          }
          if (e.results.length > 4) box.append(el("span", "", `and ${e.results.length - 4} more`));
          li.append(box);
          break;
        }
        case "text":
          if (!writing) {
            writing = true;
            setPip("searching", "Writing");
          }
          md += e.delta;
          schedule();
          break;
        case "preamble_end":
          if (md.trim()) step(el("li", "note", md.trim()));
          md = "";
          schedule();
          break;
        case "cite":
          md += `⟦${e.ids.join(",")}⟧`;
          schedule();
          break;
        case "sources":
          for (const s of e.sources) sourcesById.set(s.id, s);
          renderSources(sources, e.sources);
          break;
        case "guard":
          guard.hidden = false;
          guard.textContent =
            "Check before relying on: " +
            e.unverified.map((u) => `${u.value} (not in the text of source ${u.sourceIds.join(", ")})`).join("; ") +
            ".";
          break;
        case "done": {
          const m = e.meta;
          const bits = [`${(m.totalMs / 1000).toFixed(1)} s`];
          if (m.recalledTurns) bits.push(`remembered ${m.recalledTurns} earlier chat${m.recalledTurns > 1 ? "s" : ""}`);
          if (m.costUsd) bits.push(m.costUsd < 0.001 ? "under $0.001" : `about $${m.costUsd.toFixed(3)}`);
          meta.replaceChildren(...bits.map((b) => el("span", "", b)));
          summary.textContent = m.searches
            ? `Searched ${m.searches} time${m.searches > 1 ? "s" : ""} and read ${m.sourcesSeen} sources`
            : "How I answered";
          activity.open = false;
          if (!steps.children.length) activity.hidden = true;
          setPip("happy");
          break;
        }
        case "error":
          activity.hidden = !steps.children.length;
          answer.append(el("p", "error", e.message));
          setPip("idle");
          break;
      }
    },
    finish() {
      if (frame) cancelAnimationFrame(frame);
      paint();
      answer.classList.remove("typing");
      if (pip.firstElementChild.classList.contains("searching")) setPip("idle");
    },
  };
}

function scroll() {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// ---------- chat ----------

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  input.value = "";
  autosize();
  addUser(text);
  log.scrollTop = log.scrollHeight;
  const bot = botMessage();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, message: text, tz }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) bot.handle(JSON.parse(chunk.slice(6)));
      }
    }
  } catch {
    bot.handle({ type: "error", message: "Lost the connection to the server. Check that `npm run dev` is still running, then send again." });
  } finally {
    bot.finish();
    busy = false;
    sendBtn.disabled = false;
    if (location.hash.slice(1) !== threadId) history.replaceState(null, "", `#${threadId}`);
    loadThreads();
    input.focus();
  }
}

/** Past chats grouped by the day they happened: the memory, made visible. */
async function loadThreads() {
  const threads = await fetch("/api/threads").then((r) => r.json());
  const nav = $("#threads");
  nav.replaceChildren();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  let lastDay = "";
  for (const t of threads) {
    const when = new Date(t.lastAt || t.createdAt);
    const ds = when.toDateString();
    const day = ds === today ? "Today" : ds === yesterday ? "Yesterday" : when.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    if (day !== lastDay) nav.append(el("div", "day-label", day));
    lastDay = day;
    const a = el("a", t.id === threadId ? "active" : "", t.title);
    a.href = `#${t.id}`;
    nav.append(a);
  }
  if (!threads.length) nav.append(el("p", "memo", "No chats yet."));
}

async function openThread(id) {
  threadId = id;
  const turns = await fetch(`/api/threads/${id}`).then((r) => r.json());
  log.replaceChildren();
  if (!turns.length) return showEmpty();
  for (const t of turns) {
    addUser(t.userText);
    const root = el("div", "msg bot");
    const answer = el("div", "answer");
    answer.innerHTML = renderAnswer(t.answerText, new Map());
    const sources = el("div", "sources");
    renderSources(sources, t.sources);
    const meta = el("div", "meta");
    meta.append(el("span", "", new Date(t.createdAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })));
    root.append(answer, sources, meta);
    log.append(root);
  }
  log.scrollTop = log.scrollHeight;
  loadThreads();
}

function showEmpty() {
  log.replaceChildren();
  const empty = el("div");
  empty.id = "empty";
  empty.append(
    el("h2", "", "What should I look up?"),
    el(
      "p",
      "",
      "I search the web, show where each fact came from and how old it is, and remember what we talked about, so you can come back next week and ask what's changed.",
    ),
  );
  const ex = el("ul");
  ex.id = "examples";
  ex.setAttribute("aria-label", "Example questions");
  for (const q of EXAMPLES) {
    const li = el("li");
    const b = el("button", "", q);
    b.type = "button";
    b.onclick = () => send(q);
    li.append(b);
    ex.append(li);
  }
  empty.append(ex);
  log.append(empty);
  setPip("idle");
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
input.addEventListener("input", autosize);
// The full placeholder wraps on a phone, so narrow screens get a short one.
const narrow = matchMedia("(max-width: 520px)");
const setPlaceholder = () => (input.placeholder = narrow.matches ? "Ask about anything current" : "Ask about a price, a release, the news, or an earlier chat");
narrow.addEventListener("change", setPlaceholder);
setPlaceholder();
$("#new-chat").onclick = () => {
  threadId = newId();
  history.replaceState(null, "", location.pathname);
  showEmpty();
  loadThreads();
  document.body.classList.remove("sidebar-open");
  input.focus();
};
$("#toggle-sidebar").onclick = () => document.body.classList.toggle("sidebar-open");
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== threadId) openThread(id);
  document.body.classList.remove("sidebar-open");
});

(async function init() {
  if (location.hash.slice(1)) await openThread(threadId);
  else showEmpty();
  loadThreads();
  const status = await fetch("/api/status").then((r) => r.json());
  if (!status.ok) {
    $("#banner").hidden = false;
    $("#banner").textContent = status.help;
    setPip("idle", "I need an API key first");
  }
})();
