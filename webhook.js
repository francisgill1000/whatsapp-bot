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
  "👋 Welcome to *Rezzy* by Eloquent FZE LLC",
  "",
  "We help salons take WhatsApp bookings automatically — no apps, no missed messages.",
  "",
  "Let's get you set up. *What's your business name?*",
].join("\n");

const signupSessions = new Map();

function handleSignup(phone, text) {
  const t = text.trim();

  if (t.toLowerCase() === "restart") {
    signupSessions.set(phone, { state: "ASK_NAME" });
    return SIGNUP_WELCOME;
  }

  const session = signupSessions.get(phone) ?? { state: "ASK_NAME" };

  switch (session.state) {
    case "ASK_NAME": {
      if (!t) return "Please type your business name.";
      signupSessions.set(phone, { state: "ASK_HOURS", name: t });
      return `Great, *${t}*! What are your *working hours*?\n(e.g. Sat-Thu 10am-9pm, Fri closed)`;
    }
    case "ASK_HOURS": {
      if (!t) return "Please type your working hours.";
      signupSessions.set(phone, { state: "ASK_SERVICES", name: session.name, hours: t });
      return "Last one — list your *services with prices*.\n(e.g. Haircut 80 AED, Beard 50 AED, Color 250 AED)";
    }
    case "ASK_SERVICES": {
      if (!t) return "Please type your services and prices.";
      const lead = {
        savedAt: new Date().toISOString(),
        from: phone,
        name: session.name,
        hours: session.hours,
        services: t,
      };
      try {
        appendFileSync(LEADS_FILE, JSON.stringify(lead) + "\n");
        console.log(`📝 New lead: ${lead.name} (${phone})`);
      } catch (err) {
        console.error("Failed to append lead:", err.message);
      }
      signupSessions.set(phone, { state: "DONE", ...lead });
      return `Thanks, *${session.name}*! 🎉\n\nFrancis will reach out within 24h to set up your dedicated Rezzy booking bot.\n\nReply *restart* if you want to redo this form.`;
    }
    case "DONE":
    default:
      return "Got it — Francis has your info. Reply *restart* if you want to edit it.";
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
});
