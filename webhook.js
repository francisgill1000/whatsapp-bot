import "dotenv/config";
import { createServer } from "node:http";

const {
  WEBHOOK_VERIFY_TOKEN,
  WEBHOOK_PORT = "3000",
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TOKEN,
  WHATSAPP_API_VERSION = "v25.0",
} = process.env;

if (!WEBHOOK_VERIFY_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
  console.error("Missing env vars. Check your .env file.");
  process.exit(1);
}

const availableSlots = new Set([
  "Tomorrow 10:00 AM",
  "Tomorrow 02:00 PM",
  "Friday 11:00 AM",
  "Friday 04:00 PM",
]);

const bookings = new Map();
const sessions = new Map();

const MENU = [
  "👋 Welcome to *Rezzy Booking*",
  "",
  "Reply with a number:",
  "1. View available slots",
  "2. My bookings",
  "3. Cancel my booking",
  "4. Talk to a human",
].join("\n");

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { state: "MAIN" });
  return sessions.get(phone);
}

function handleMain(phone, text) {
  switch (text.trim()) {
    case "1": {
      const choices = Array.from(availableSlots);
      if (choices.length === 0) {
        return "Sorry, no slots available right now. Reply *menu* to return.";
      }
      sessions.set(phone, { state: "PICK_SLOT", choices });
      const list = choices.map((s, i) => `${i + 1}. ${s}`).join("\n");
      return `🗓 *Available slots:*\n${list}\n\nReply with a number to book, or *0* to cancel.`;
    }
    case "2": {
      const slot = bookings.get(phone);
      return slot
        ? `✅ Your booking: *${slot}*\n\nReply *menu* for more options.`
        : "You don't have a booking yet.\n\nReply *menu* to see options.";
    }
    case "3": {
      const slot = bookings.get(phone);
      if (!slot) return "You don't have a booking to cancel.\n\nReply *menu* for options.";
      bookings.delete(phone);
      availableSlots.add(slot);
      return `❌ Cancelled: *${slot}*\nThe slot is available again.\n\nReply *menu* for options.`;
    }
    case "4":
      return "👤 A team member will reply soon. In the meantime, reply *menu* to keep using the bot.";
    default:
      return `I didn't catch that.\n\n${MENU}`;
  }
}

function handlePickSlot(phone, text) {
  const session = getSession(phone);
  const input = text.trim();

  if (input === "0") {
    sessions.set(phone, { state: "MAIN" });
    return `Cancelled.\n\n${MENU}`;
  }

  const idx = Number(input) - 1;
  const choice = session.choices?.[idx];
  if (!Number.isInteger(idx) || !choice) {
    return "Please reply with a valid slot number, or *0* to cancel.";
  }

  if (!availableSlots.has(choice)) {
    sessions.set(phone, { state: "MAIN" });
    return `Sorry, *${choice}* was just taken. Reply *menu* to try another.`;
  }

  const existing = bookings.get(phone);
  if (existing) availableSlots.add(existing);
  bookings.set(phone, choice);
  availableSlots.delete(choice);
  sessions.set(phone, { state: "MAIN" });
  return `✅ Booked: *${choice}*\n\nReply *menu* for more options.`;
}

function route(phone, text) {
  const normalized = text.trim().toLowerCase();
  if (normalized === "menu" || normalized === "hi" || normalized === "hello" || normalized === "start") {
    sessions.set(phone, { state: "MAIN" });
    return MENU;
  }

  const session = getSession(phone);
  if (session.state === "PICK_SLOT") return handlePickSlot(phone, text);
  return handleMain(phone, text);
}

async function sendText(to, body) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Reply failed:", res.status, JSON.stringify(data));
    return;
  }
  console.log(`↩️  replied to ${to}: ${body.split("\n")[0]}…`);
}

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

      if (message) {
        const from = message.from;
        const type = message.type;
        const text = message.text?.body ?? "";
        console.log(`📩 from ${from}: ${text || `[${type}]`}`);

        if (type === "text" && text) {
          const reply = route(from, text);
          await sendText(from, reply);
        } else {
          await sendText(from, MENU);
        }
      } else if (change?.statuses) {
        const s = change.statuses[0];
        console.log(`📊 status: ${s.status} (msg ${s.id})`);
      } else {
        console.log("📦 event:", JSON.stringify(body));
      }
    } catch (err) {
      console.error("Failed to parse webhook body:", err.message);
    }

    res.writeHead(200);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(Number(WEBHOOK_PORT), () => {
  console.log(`🚀 Rezzy Booking bot on http://localhost:${WEBHOOK_PORT}/webhook`);
  console.log(`   Verify token: ${WEBHOOK_VERIFY_TOKEN}`);
});
