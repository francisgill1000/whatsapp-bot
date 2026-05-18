import "dotenv/config";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

const {
  WEBHOOK_VERIFY_TOKEN,
  WEBHOOK_PORT = "3000",
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TOKEN,
  WHATSAPP_API_VERSION = "v25.0",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM,
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;

if (!WEBHOOK_VERIFY_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
  console.error("Missing Meta env vars. Check your .env file.");
  process.exit(1);
}

const twilioEnabled = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);

const TENANTS_DIR = process.env.TENANTS_DIR ?? "./tenants";
const LEADS_FILE = process.env.LEADS_FILE ?? "./leads.jsonl";
const SIGNUP_NUMBER = (process.env.SIGNUP_NUMBER ?? TWILIO_FROM ?? "").replace(/^\+/, "");

if (!existsSync(TENANTS_DIR)) mkdirSync(TENANTS_DIR, { recursive: true });

function normalizeNumber(n) {
  return String(n ?? "").replace(/^whatsapp:/, "").replace(/^\+/, "").trim();
}

const tenants = new Map();

function loadTenants() {
  tenants.clear();
  for (const file of readdirSync(TENANTS_DIR)) {
    if (!file.endsWith(".json") || file.endsWith("-data.json")) continue;
    try {
      const config = JSON.parse(readFileSync(join(TENANTS_DIR, file), "utf8"));
      const key = normalizeNumber(config.whatsapp_number);
      if (!key || !config.id || !config.name) {
        console.warn(`Skipping ${file}: missing id/name/whatsapp_number`);
        continue;
      }
      tenants.set(key, config);
    } catch (err) {
      console.error(`Failed to load ${file}:`, err.message);
    }
  }
  console.log(`📂 Loaded ${tenants.size} tenant(s): ${[...tenants.values()].map(t => `${t.id}→${t.whatsapp_number}`).join(", ") || "none"}`);
}

const tenantState = new Map();

function tenantDataPath(id) {
  return join(TENANTS_DIR, `${id}-data.json`);
}

function getTenantState(tenant) {
  if (tenantState.has(tenant.id)) return tenantState.get(tenant.id);
  let persisted = {};
  if (existsSync(tenantDataPath(tenant.id))) {
    try {
      persisted = JSON.parse(readFileSync(tenantDataPath(tenant.id), "utf8"));
    } catch (err) {
      console.error(`Failed to load data for ${tenant.id}:`, err.message);
    }
  }
  const state = {
    availableSlots: new Set(persisted.availableSlots ?? tenant.slots ?? []),
    bookings: new Map(persisted.bookings ?? []),
    sessions: new Map(persisted.sessions ?? []),
  };
  tenantState.set(tenant.id, state);
  return state;
}

function persistTenant(tenant) {
  const state = tenantState.get(tenant.id);
  if (!state) return;
  const data = {
    savedAt: new Date().toISOString(),
    availableSlots: Array.from(state.availableSlots),
    bookings: Array.from(state.bookings.entries()),
    sessions: Array.from(state.sessions.entries()),
  };
  const path = tenantDataPath(tenant.id);
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.error(`Failed to save data for ${tenant.id}:`, err.message);
  }
}

function tenantMenu(tenant) {
  return [
    `👋 Welcome to *${tenant.name}*`,
    "",
    "Reply with a number:",
    "1. View available slots",
    "2. My bookings",
    "3. Cancel my booking",
    "4. Talk to a human",
  ].join("\n");
}

function handleTenantMain(tenant, phone, text) {
  const state = getTenantState(tenant);
  switch (text.trim()) {
    case "1": {
      const choices = Array.from(state.availableSlots);
      if (choices.length === 0) return "Sorry, no slots available right now. Reply *menu* to return.";
      state.sessions.set(phone, { state: "PICK_SLOT", choices });
      const list = choices.map((s, i) => `${i + 1}. ${s}`).join("\n");
      return `🗓 *Available slots:*\n${list}\n\nReply with a number to book, or *0* to cancel.`;
    }
    case "2": {
      const slot = state.bookings.get(phone);
      return slot
        ? `✅ Your booking: *${slot}*\n\nReply *menu* for more options.`
        : "You don't have a booking yet.\n\nReply *menu* to see options.";
    }
    case "3": {
      const slot = state.bookings.get(phone);
      if (!slot) return "You don't have a booking to cancel.\n\nReply *menu* for options.";
      state.bookings.delete(phone);
      state.availableSlots.add(slot);
      return `❌ Cancelled: *${slot}*\nThe slot is available again.\n\nReply *menu* for options.`;
    }
    case "4":
      return `👤 A team member at *${tenant.name}* will reply soon. Meanwhile, reply *menu* to keep using the bot.`;
    default:
      return `I didn't catch that.\n\n${tenantMenu(tenant)}`;
  }
}

function handleTenantPickSlot(tenant, phone, text) {
  const state = getTenantState(tenant);
  const session = state.sessions.get(phone) ?? { state: "MAIN" };
  const input = text.trim();

  if (input === "0") {
    state.sessions.set(phone, { state: "MAIN" });
    return `Cancelled.\n\n${tenantMenu(tenant)}`;
  }

  const idx = Number(input) - 1;
  const choice = session.choices?.[idx];
  if (!Number.isInteger(idx) || !choice) return "Please reply with a valid slot number, or *0* to cancel.";

  if (!state.availableSlots.has(choice)) {
    state.sessions.set(phone, { state: "MAIN" });
    return `Sorry, *${choice}* was just taken. Reply *menu* to try another.`;
  }

  const existing = state.bookings.get(phone);
  if (existing) state.availableSlots.add(existing);
  state.bookings.set(phone, choice);
  state.availableSlots.delete(choice);
  state.sessions.set(phone, { state: "MAIN" });
  return `✅ Booked: *${choice}* at *${tenant.name}*\n\nReply *menu* for more options.`;
}

function routeTenant(tenant, phone, text) {
  const state = getTenantState(tenant);
  const normalized = text.trim().toLowerCase();
  if (["menu", "hi", "hello", "start"].includes(normalized)) {
    state.sessions.set(phone, { state: "MAIN" });
    return tenantMenu(tenant);
  }
  const session = state.sessions.get(phone) ?? { state: "MAIN" };
  if (session.state === "PICK_SLOT") return handleTenantPickSlot(tenant, phone, text);
  return handleTenantMain(tenant, phone, text);
}

const SIGNUP_WELCOME = [
  "👋 Welcome to Rezzy Booking Bot.",
  "",
  "Let's get you set up. *What's your business name?*",
  "(e.g. Glamour Salon Dubai)",
].join("\n");

const CITY_PRESETS = [
  "Dubai",
  "Abu Dhabi",
  "Sharjah",
  "Other (we'll ask on the call)",
];

const MAX_UNRELATED = 3;
const GREETING_WORDS = new Set([
  "hi", "hello", "hey", "yo", "hola", "salam", "salaam", "marhaba",
  "menu", "start", "test", "ok", "okay",
]);

function presetPrompt(label, presets, exampleHint) {
  const lines = [
    `*${label}*`,
    "",
    "Tap a number to use a preset, or type your own:",
    "",
    ...presets.map((p, i) => `*${i + 1}.* ${p}`),
    "",
    `Or type your own (e.g. ${exampleHint}).`,
  ];
  return lines.join("\n");
}

function resolvePreset(text, presets) {
  const idx = Number(text.trim()) - 1;
  if (Number.isInteger(idx) && idx >= 0 && idx < presets.length) return presets[idx];
  return text.trim();
}

function isValidBusinessName(t) {
  if (!t || t.length < 3) return false;
  if (GREETING_WORDS.has(t.toLowerCase())) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

const signupSessions = new Map();

function bumpUnrelated(phone, session) {
  const next = { ...session, unrelated: (session.unrelated ?? 0) + 1 };
  signupSessions.set(phone, next);
  return next;
}

function resetUnrelated(session) {
  return { ...session, unrelated: 0 };
}

function handleSignup(phone, text) {
  const t = text.trim();

  if (t.toLowerCase() === "restart") {
    signupSessions.set(phone, { state: "ASK_NAME", unrelated: 0 });
    return SIGNUP_WELCOME;
  }

  const session = signupSessions.get(phone) ?? { state: "ASK_NAME", unrelated: 0 };

  if ((session.unrelated ?? 0) >= MAX_UNRELATED) {
    console.log(`🤐 Silent: ${phone} exceeded ${MAX_UNRELATED} unrelated replies (state=${session.state})`);
    return null;
  }

  switch (session.state) {
    case "ASK_NAME": {
      if (!isValidBusinessName(t)) {
        bumpUnrelated(phone, session);
        return "Please type your *real business name* (e.g. Glamour Salon Dubai).";
      }
      const next = resetUnrelated({ state: "ASK_CITY", name: t });
      signupSessions.set(phone, next);
      return presetPrompt(
        "Which city is your salon in?",
        CITY_PRESETS,
        "Ras al Khaimah"
      );
    }
    case "ASK_CITY": {
      if (!t) {
        bumpUnrelated(phone, session);
        return "Please pick a number (1-4) or type your city.";
      }
      const city = resolvePreset(t, CITY_PRESETS);
      const lead = {
        savedAt: new Date().toISOString(),
        from: phone,
        name: session.name,
        city,
      };
      try {
        appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n");
        console.log(`📝 New lead: ${lead.name} in ${lead.city} (${phone})`);
      } catch (err) {
        console.error("Failed to append lead:", err.message);
      }
      signupSessions.set(phone, { state: "DONE", ...lead, unrelated: 0 });
      return [
        `Thanks, *${session.name}*! 🎉`,
        "",
        "Our staff will call you soon to set up your dedicated Booking Bot.",
      ].join("\n");
    }
    case "DONE":
    default: {
      bumpUnrelated(phone, session);
      return "Got it — our staff has your info. Reply *restart* if you want to edit it.";
    }
  }
}

function routeIncoming(toNumber, fromPhone, text) {
  const to = normalizeNumber(toNumber);
  if (!to) return null;

  if (to === SIGNUP_NUMBER) {
    return handleSignup(fromPhone, text);
  }

  const tenant = tenants.get(to);
  if (tenant) {
    const reply = routeTenant(tenant, fromPhone, text);
    persistTenant(tenant);
    return reply;
  }

  console.warn(`No tenant found for To=${toNumber} (normalized=${to})`);
  return null;
}

function validateTwilioSignature(fullUrl, params, signature) {
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let data = fullUrl;
  for (const [key, value] of entries) data += key + value;
  const expected = createHmac("sha1", TWILIO_AUTH_TOKEN).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function checkBasicAuth(req) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const givenUser = Buffer.from(decoded.slice(0, idx));
  const givenPass = Buffer.from(decoded.slice(idx + 1));
  const expectUser = Buffer.from(ADMIN_USER);
  const expectPass = Buffer.from(ADMIN_PASS);
  if (givenUser.length !== expectUser.length || givenPass.length !== expectPass.length) return false;
  return timingSafeEqual(givenUser, expectUser) && timingSafeEqual(givenPass, expectPass);
}

function sendAuthRequired(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Rezzy Admin", charset="UTF-8"',
    "Content-Type": "text/plain",
  });
  res.end("Authentication required");
}

function readLeads() {
  if (!existsSync(LEADS_FILE)) return [];
  try {
    return readFileSync(LEADS_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.error("Failed to read leads:", err.message);
    return [];
  }
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rezzy Admin — Leads</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; max-width: 1000px; margin: 0 auto; background: #fafafa; color: #1a1a1a; }
  h1 { font-size: 1.5em; margin: 0 0 0.25em; }
  .meta { color: #666; margin-bottom: 1.5em; font-size: 0.9em; display: flex; gap: 1em; align-items: center; flex-wrap: wrap; }
  .meta button { font-size: 0.85em; padding: 4px 10px; border: 1px solid #ccc; background: white; border-radius: 4px; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  th { background: #f7f7f7; font-weight: 600; font-size: 0.85em; text-transform: uppercase; color: #555; letter-spacing: 0.03em; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #fafafa; }
  .empty { color: #999; text-align: center; padding: 3em 1em; }
  .phone { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }
  .time { color: #777; font-size: 0.85em; white-space: nowrap; }
  .wa-link { color: #25d366; text-decoration: none; font-weight: 500; }
  .wa-link:hover { text-decoration: underline; }
  @media (max-width: 640px) {
    body { padding: 16px; }
    th:nth-child(4), td:nth-child(4) { display: none; }
    th, td { padding: 10px; font-size: 0.95em; }
  }
</style>
</head>
<body>
  <h1>🎯 Rezzy Leads</h1>
  <div class="meta">
    <span id="count">Loading…</span>
    <button onclick="load()">↻ Refresh</button>
  </div>
  <table>
    <thead>
      <tr><th>Salon</th><th>City</th><th>WhatsApp</th><th>When</th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
<script>
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
async function load() {
  document.getElementById("count").textContent = "Loading…";
  const res = await fetch("/admin/leads.json", { cache: "no-store" });
  if (!res.ok) { document.getElementById("count").textContent = "Error: " + res.status; return; }
  const leads = await res.json();
  const tbody = document.getElementById("rows");
  document.getElementById("count").textContent = leads.length + " lead" + (leads.length === 1 ? "" : "s");
  if (leads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No leads yet. Share <strong>+971 54 172 1640</strong> to start collecting.</td></tr>';
    return;
  }
  leads.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  tbody.innerHTML = leads.map(l => {
    const when = l.savedAt ? new Date(l.savedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
    const phone = l.from || "";
    const waLink = phone ? '<a class="wa-link" href="https://wa.me/' + esc(phone) + '" target="_blank">' + esc(phone) + '</a>' : "";
    return '<tr>' +
      '<td>' + esc(l.name) + '</td>' +
      '<td>' + esc(l.city) + '</td>' +
      '<td class="phone">' + waLink + '</td>' +
      '<td class="time">' + esc(when) + '</td>' +
    '</tr>';
  }).join("");
}
load();
</script>
</body>
</html>`;

async function sendTwilio(toPhone, body, fromNumber) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const form = new URLSearchParams({
    From: `whatsapp:+${normalizeNumber(fromNumber)}`,
    To: `whatsapp:+${normalizeNumber(toPhone)}`,
    Body: body,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Twilio reply failed:", res.status, JSON.stringify(data));
    return;
  }
  console.log(`↩️  (twilio from +${normalizeNumber(fromNumber)}) replied to ${toPhone}: ${body.split("\n")[0]}…`);
}

async function sendMeta(toPhone, body) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Meta reply failed:", res.status, JSON.stringify(data));
    return;
  }
  console.log(`↩️  (meta) replied to ${toPhone}: ${body.split("\n")[0]}…`);
}

loadTenants();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/webhook") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
      console.log("✅ Webhook verified by Meta");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
      return;
    }
    console.warn("❌ Verification failed — token mismatch");
    res.writeHead(403);
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw);
      const change = body.entry?.[0]?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      if (message?.type === "text" && message.text?.body) {
        const from = message.from;
        const text = message.text.body;
        console.log(`📩 (meta) from ${from}: ${text}`);
        const reply = handleSignup(from, text);
        if (reply) await sendMeta(from, reply);
      } else if (change?.statuses) {
        const s = change.statuses[0];
        console.log(`📊 (meta) status: ${s.status} (msg ${s.id})`);
      }
    } catch (err) {
      console.error("Failed to parse Meta webhook body:", err.message);
    }
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    if (!checkBasicAuth(req)) { sendAuthRequired(res); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML);
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/leads.json") {
    if (!checkBasicAuth(req)) { sendAuthRequired(res); return; }
    const leads = readLeads();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(leads));
    return;
  }

  if (req.method === "POST" && url.pathname === "/twilio") {
    let raw = "";
    for await (const chunk of req) raw += chunk;

    if (!twilioEnabled) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Twilio not configured");
      return;
    }

    const proto = req.headers["x-forwarded-proto"] ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const fullUrl = process.env.TWILIO_WEBHOOK_URL ?? `${proto}://${host}${req.url}`;
    const signature = req.headers["x-twilio-signature"];

    let params;
    try {
      params = new URLSearchParams(raw);
    } catch (err) {
      console.error("Failed to parse Twilio webhook body:", err.message);
      res.writeHead(400);
      res.end();
      return;
    }

    if (!validateTwilioSignature(fullUrl, params, signature)) {
      console.warn(`❌ Twilio signature validation failed for ${fullUrl}`);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const toRaw = params.get("To") ?? "";
      const fromRaw = params.get("From") ?? "";
      const text = params.get("Body") ?? "";
      const from = normalizeNumber(fromRaw);
      console.log(`📩 (twilio) from ${from} to ${normalizeNumber(toRaw)}: ${text}`);

      if (from && text) {
        const reply = routeIncoming(toRaw, from, text);
        if (reply) await sendTwilio(from, reply, toRaw);
      }
    } catch (err) {
      console.error("Failed to handle Twilio message:", err.message);
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end("<Response></Response>");
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(Number(WEBHOOK_PORT), () => {
  console.log(`🚀 Rezzy multi-tenant bot on http://localhost:${WEBHOOK_PORT}`);
  console.log(`   Meta webhook:   /webhook   (signup bot via Meta test number)`);
  console.log(`   Twilio webhook: /twilio    ${twilioEnabled ? "" : "(disabled — TWILIO_* env vars missing)"}`);
  console.log(`   Signup number:  +${SIGNUP_NUMBER || "(unset)"}`);
  console.log(`   Tenants:        ${tenants.size} loaded`);
  console.log(`   Leads file:     ${LEADS_FILE}`);
  console.log(`   Admin UI:       /admin     ${ADMIN_USER && ADMIN_PASS ? `(user: ${ADMIN_USER})` : "(disabled — set ADMIN_USER + ADMIN_PASS in .env)"}`);
});
