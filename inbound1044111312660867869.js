// Serwer pizza-bota: Messenger -> zamówienia -> panel -> "pizza gotowa".
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MENU, parse, describe } = require("./parser");

const {
  PAGE_TOKEN, VERIFY_TOKEN, APP_SECRET, PANEL_KEY,
  ANTHROPIC_API_KEY, LLM_MODEL = "claude-haiku-5-5",
  MAX_PER_DAY = "0", PORT = 3000,
} = process.env;
const GRAPH = "https://graph.facebook.com/v21.0";
const DATA = path.join(__dirname, "data", "orders.json");

// ---------- magazyn zamówień (plik JSON; po restarcie na darmowym hostingu może zniknąć) ----------
let orders = [];
try { orders = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) {}
const dayAgo = () => Date.now() - 24 * 3600 * 1000;
orders = orders.filter((o) => o.t > dayAgo());
function save() {
  try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(orders)); } catch (e) {}
}
const pending = new Map(); // psid -> szkic zamówienia czekający na "Tak"
const clients = new Set();  // otwarte panele (SSE)
const push = () => clients.forEach((res) => res.write(`data: ${JSON.stringify(orders)}\n\n`));

// ---------- Messenger ----------
async function send(psid, text, quick, type = "RESPONSE") {
  const message = { text };
  if (quick) message.quick_replies = quick.map(([title, payload]) => ({ content_type: "text", title, payload }));
  const r = await fetch(`${GRAPH}/me/messages?access_token=${PAGE_TOKEN}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, messaging_type: type, message }),
  });
  if (!r.ok) console.error("send error", r.status, await r.text());
  return r.ok;
}
async function nameOf(psid) {
  try {
    const r = await fetch(`${GRAPH}/${psid}?fields=first_name,last_name&access_token=${PAGE_TOKEN}`);
    const j = await r.json();
    return [j.first_name, j.last_name].filter(Boolean).join(" ") || "Ktoś";
  } catch (e) { return "Ktoś"; }
}

// ---------- rezerwowe rozumienie przez Claude (tylko gdy parser nie rozpozna) ----------
async function askLLM(text) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: LLM_MODEL, max_tokens: 300,
        system: "Jesteś asystentem pizzerii. Zamieniasz wiadomość pracownika (z literówkami) na zamówienie. " +
          "Menu: " + JSON.stringify(MENU) + ". Zwróć WYŁĄCZNIE JSON: " +
          '{"pizza": nazwa z menu lub null, "extras": [dodatki po polsku w mianowniku], "note": "np. bez cebuli" lub "", "time": "ASAP" lub "HH:MM"}. ' +
          "Jeśli ktoś opisuje własną pizzę, ustaw pizza=null i wpisz składniki w extras. Jeśli to nie jest zamówienie, zwróć {\"pizza\":null,\"extras\":[]}.",
        messages: [{ role: "user", content: text }],
      }),
    });
    const j = await r.json();
    const raw = (j.content || []).map((c) => c.text || "").join("").replace(/```json|```/g, "").trim();
    const o = JSON.parse(raw);
    if (o.pizza && !MENU[o.pizza]) o.pizza = null;
    return { pizza: o.pizza || null, extras: o.extras || [], note: o.note || "", time: o.time || "ASAP" };
  } catch (e) { console.error("LLM error", e.message); return null; }
}

// ---------- obsługa wiadomości ----------
async function handle(psid, text, payload) {
  const t = (text || "").trim();

  if (payload === "YES" && pending.has(psid)) {
    const d = pending.get(psid); pending.delete(psid);
    const limit = +MAX_PER_DAY;
    if (limit && orders.filter((o) => o.psid === psid && !o.cancelled).length >= limit)
      return send(psid, `Limit to ${limit} pizza dziennie na osobę. Napisz "anuluj", żeby odwołać poprzednie zamówienie.`);
    orders.push({ id: Date.now(), psid, who: d.who, pizza: d.pizza, note: d.note, time: d.time, done: false, t: Date.now() });
    save(); push();
    return send(psid, "Zapisane! Dam znać, gdy pizza będzie gotowa 🍕");
  }
  if (payload === "FIX") {
    pending.delete(psid);
    return send(psid, "Okej, napisz zamówienie jeszcze raz (np. \"diavola na 15:30\").");
  }
  if (/^anuluj/i.test(t)) {
    const mine = orders.filter((o) => o.psid === psid && !o.done).pop();
    if (!mine) return send(psid, "Nie masz otwartego zamówienia.");
    orders = orders.filter((o) => o.id !== mine.id); save(); push();
    return send(psid, `Anulowane: ${mine.pizza}.`);
  }
  if (/^(menu|karta)/i.test(t))
    return send(psid, "Pizze: " + Object.keys(MENU).join(", ") + ". Możesz też wymyślić własną z dodatków.");

  let r = parse(t);
  if (!r.pizza && !r.extras.length) r = (await askLLM(t)) || r;
  if (!r.pizza && !r.extras.length)
    return send(psid, "Nie rozpoznałem pizzy 🤔 Napisz \"menu\", żeby zobaczyć kartę, albo wypisz dodatki.");

  const d = describe(r);
  d.who = await nameOf(psid);
  pending.set(psid, d);
  const when = d.time === "ASAP" ? "jak najszybciej" : "na " + d.time;
  return send(psid, `${d.pizza}${d.note ? " (" + d.note + ")" : ""}, ${when}. Dobrze?`, [["Tak", "YES"], ["Popraw", "FIX"]]);
}

// ---------- Express ----------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (APP_SECRET) {
    const sig = (req.get("x-hub-signature-256") || "").replace("sha256=", "");
    const exp = crypto.createHmac("sha256", APP_SECRET).update(req.raw).digest("hex");
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.sendStatus(403);
  }
  res.sendStatus(200); // Meta wymaga szybkiej odpowiedzi
  if (req.body.object !== "page") return;
  for (const e of req.body.entry || [])
    for (const ev of e.messaging || []) {
      if (!ev.message || ev.message.is_echo) continue;
      handle(ev.sender.id, ev.message.text, ev.message.quick_reply && ev.message.quick_reply.payload)
        .catch((err) => console.error("handle error", err));
    }
});

const auth = (req, res, next) =>
  (!PANEL_KEY || req.query.key === PANEL_KEY || req.get("x-key") === PANEL_KEY) ? next() : res.sendStatus(401);

app.get("/api/orders", auth, (_req, res) => res.json(orders));

app.get("/api/stream", auth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify(orders)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(res); });
});

// odhaczenie / cofnięcie; po odhaczeniu bot pisze do pracownika
app.post("/api/orders/:id/done", auth, async (req, res) => {
  const o = orders.find((x) => x.id == req.params.id);
  if (!o) return res.sendStatus(404);
  o.done = req.body.done !== false;
  save(); push();
  if (o.done && o.psid) await send(o.psid, `Twoja pizza (${o.pizza}) jest gotowa 🍕`, null, "UPDATE");
  res.json(o);
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log("Pizza-bot działa na porcie " + PORT));
