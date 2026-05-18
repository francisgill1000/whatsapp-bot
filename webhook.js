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
import { join, resolve, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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

const SESSION_COOKIE = "rzy_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sessionSecret() {
  return createHmac("sha256", ADMIN_PASS || "no-pass").update("rezzy-admin-session-v1").digest();
}

function signSession(expSec) {
  const sig = createHmac("sha256", sessionSecret()).update(String(expSec)).digest("hex");
  return `${expSec}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = parseInt(expStr, 10);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;
  const expected = createHmac("sha256", sessionSecret()).update(expStr).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const map = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map[k] = decodeURIComponent(v);
  }
  return map;
}

function isSecureRequest(req) {
  const proto = req.headers["x-forwarded-proto"];
  if (proto) return String(proto).split(",")[0].trim() === "https";
  return !!req.socket?.encrypted;
}

function checkSession(req) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function credentialsValid(user, pass) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  const gu = Buffer.from(String(user || ""));
  const gp = Buffer.from(String(pass || ""));
  const eu = Buffer.from(ADMIN_USER);
  const ep = Buffer.from(ADMIN_PASS);
  if (gu.length !== eu.length || gp.length !== ep.length) return false;
  return timingSafeEqual(gu, eu) && timingSafeEqual(gp, ep);
}

function setSessionCookie(res, req) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = signSession(exp);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/admin",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, req) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/admin",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function renderLoginPage({ error = "", nextPath = "/admin" } = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Rezzy Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#16130f; --panel:#1d1916; --panel2:#241f1b; --line:#2c2722; --line2:#3a342e;
    --ink:#f5efe7; --ink2:#b8ad9f; --ink3:#7d7368; --ink4:#5a5048;
    --coral:#e87b56; --red:#e07a6b;
  }
  *,*::before,*::after { box-sizing:border-box; }
  html,body { margin:0; padding:0; height:100%; font-family:'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; background:var(--bg); color:var(--ink); }
  body { display:flex; align-items:center; justify-content:center; padding:24px; }
  .card {
    width:100%; max-width:380px; background:var(--panel); border:1px solid var(--line);
    border-radius:14px; padding:32px 28px; box-shadow:0 24px 60px rgba(0,0,0,0.35);
  }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:22px; }
  .logo {
    width:30px; height:30px; border-radius:8px; background:var(--coral);
    display:flex; align-items:center; justify-content:center; color:#1a1410; font-weight:700; font-size:15px;
  }
  .brand-name { font-weight:600; font-size:16px; letter-spacing:-0.01em; }
  .brand-sub { color:var(--ink3); font-size:12.5px; margin-top:2px; }
  h1 { margin:0 0 6px; font-size:20px; font-weight:600; letter-spacing:-0.01em; }
  .lede { color:var(--ink3); font-size:13px; margin:0 0 22px; }
  label { display:block; font-size:11px; color:var(--ink4); text-transform:uppercase; letter-spacing:0.07em; font-weight:600; margin-bottom:6px; }
  input {
    width:100%; padding:10px 12px; background:var(--panel2); border:1px solid var(--line2);
    border-radius:8px; color:var(--ink); font-size:14px; font-family:inherit; outline:none;
  }
  input:focus { border-color:var(--coral); box-shadow:0 0 0 3px rgba(232,123,86,0.15); }
  .field + .field { margin-top:14px; }
  .err {
    margin-top:16px; padding:9px 12px; background:rgba(224,122,107,0.10);
    border:1px solid rgba(224,122,107,0.30); border-radius:8px;
    color:var(--red); font-size:12.5px;
  }
  button[type=submit] {
    margin-top:20px; width:100%; padding:11px 14px; border:none; border-radius:8px;
    background:var(--coral); color:white; font-size:14px; font-weight:600; font-family:inherit;
    cursor:pointer;
  }
  button[type=submit]:hover { background:#f08862; }
  .foot { margin-top:18px; text-align:center; color:var(--ink4); font-size:11.5px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/admin/login" autocomplete="on">
    <div class="brand">
      <div class="logo">R</div>
      <div>
        <div class="brand-name">Rezzy</div>
        <div class="brand-sub">Admin</div>
      </div>
    </div>
    <h1>Sign in</h1>
    <p class="lede">Enter your admin credentials to continue.</p>
    <input type="hidden" name="next" value="${esc(nextPath)}">
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus required>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <button type="submit">Sign in</button>
    <div class="foot">Rezzy Booking Bot · bot.eloquentservice.com</div>
  </form>
</body>
</html>`;
}

function sendLoginPage(res, opts = {}, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(renderLoginPage(opts));
}

function redirectToLogin(res, currentPath) {
  const next = encodeURIComponent(currentPath || "/admin");
  res.writeHead(302, { Location: `/admin/login?next=${next}` });
  res.end();
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

const ADMIN_DIR = resolve(process.env.ADMIN_DIR ?? "./admin");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveAdminFile(req, res, relPath) {
  const safePath = relPath.replace(/^\/+/, "") || "index.html";
  const absPath = resolve(ADMIN_DIR, safePath);
  if (!absPath.startsWith(ADMIN_DIR + (process.platform === "win32" ? "\\" : "/")) && absPath !== ADMIN_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(absPath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  try {
    const data = readFileSync(absPath);
    const type = MIME_TYPES[extname(absPath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch (err) {
    console.error(`Failed to serve ${absPath}:`, err.message);
    res.writeHead(500);
    res.end("Server error");
  }
}

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

  if (req.method === "GET" && url.pathname === "/admin/login") {
    if (checkSession(req)) {
      res.writeHead(302, { Location: url.searchParams.get("next") || "/admin" });
      res.end();
      return;
    }
    sendLoginPage(res, { nextPath: url.searchParams.get("next") || "/admin" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/login") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (raw.length > 4096) { res.writeHead(413); res.end(); return; }
    const form = new URLSearchParams(raw);
    const username = form.get("username") || "";
    const password = form.get("password") || "";
    const nextPath = (() => {
      const n = form.get("next") || "/admin";
      return n.startsWith("/admin") ? n : "/admin";
    })();
    if (!credentialsValid(username, password)) {
      sendLoginPage(res, { error: "Invalid username or password.", nextPath }, 401);
      return;
    }
    setSessionCookie(res, req);
    res.writeHead(302, { Location: nextPath });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/logout") {
    clearSessionCookie(res, req);
    res.writeHead(302, { Location: "/admin/login" });
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/deploy") {
    if (!checkSession(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const cwd = process.env.DEPLOY_CWD ?? process.cwd();
    const pmName = process.env.PM2_APP_NAME ?? "rezzy-bot";
    let pullOutput = "";
    let pullOk = true;
    try {
      const { stdout, stderr } = await execFileP("git", ["pull", "--ff-only"], { cwd, timeout: 30000 });
      pullOutput = (stdout || "") + (stderr || "");
      console.log(`🚀 Deploy: git pull\n${pullOutput.trim()}`);
    } catch (err) {
      pullOk = false;
      pullOutput = (err.stdout || "") + (err.stderr || "") + (err.message || "");
      console.error(`❌ Deploy: git pull failed: ${pullOutput.trim()}`);
    }
    res.writeHead(pullOk ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: pullOk, output: pullOutput, restarting: pullOk }));
    if (pullOk) {
      setTimeout(() => {
        execFile("pm2", ["restart", pmName], (err, stdout, stderr) => {
          if (err) console.error(`❌ pm2 restart ${pmName} failed:`, err.message);
          else console.log(`♻️  pm2 restart ${pmName}: ${(stdout || stderr || "").trim()}`);
        });
      }, 300);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/leads.json") {
    if (!checkSession(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const leads = readLeads();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(leads));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
    if (!checkSession(req)) { redirectToLogin(res, url.pathname); return; }
    const rel = url.pathname === "/admin" ? "" : url.pathname.slice("/admin/".length);
    serveAdminFile(req, res, rel);
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
  console.log(`   Admin UI:       /admin     ${ADMIN_USER && ADMIN_PASS ? `(user: ${ADMIN_USER}, dir: ${ADMIN_DIR})` : "(disabled — set ADMIN_USER + ADMIN_PASS in .env)"}`);
});
