import { createServer } from "node:http";

const {
  WEBHOOK_VERIFY_TOKEN,
  WEBHOOK_PORT = "3000",
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TOKEN,
  WHATSAPP_API_VERSION = "v25.0",
} = process.env;

if (!WEBHOOK_VERIFY_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
  console.error("Missing env vars. Run with: node --env-file=.env webhook.js");
  process.exit(1);
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
  console.log(`↩️  replied to ${to}: ${body}`);
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
        const text = message.text?.body ?? `[${type}]`;
        console.log(`📩 from ${from}: ${text}`);

        if (type === "text") {
          await sendText(from, `Got your message: "${text}"`);
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
  console.log(`🚀 Webhook listening on http://localhost:${WEBHOOK_PORT}/webhook`);
  console.log(`   Verify token: ${WEBHOOK_VERIFY_TOKEN}`);
});
