import "dotenv/config";

const {
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_RECIPIENT,
  WHATSAPP_TOKEN,
  WHATSAPP_API_VERSION = "v25.0",
} = process.env;

if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_RECIPIENT || !WHATSAPP_TOKEN) {
  console.error("Missing env vars. Check your .env file.");
  process.exit(1);
}

const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

const body = {
  messaging_product: "whatsapp",
  to: WHATSAPP_RECIPIENT,
  type: "template",
  template: { name: "hello_world", language: { code: "en_US" } },
};

const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const data = await res.json();

if (!res.ok) {
  console.error("FAILED", res.status, JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log("SENT", data.messages?.[0]?.id);
