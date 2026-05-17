# Tenants

Each salon has one JSON file here describing their configuration. Adding a
salon = create a new file + `pm2 restart rezzy-bot`.

## File naming

- `<salon-id>.json` — the salon's config (committed to git)
- `<salon-id>-data.json` — runtime state: bookings, sessions, available slots
  (created automatically, gitignored, contains customer phone numbers)

## Config schema

```json
{
  "id": "glamour-dubai",
  "name": "Glamour Salon Dubai",
  "whatsapp_number": "+971501234567",
  "slots": [
    "Today 2:00 PM",
    "Today 4:00 PM",
    "Tomorrow 10:00 AM",
    "Tomorrow 02:00 PM"
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | URL-safe slug. Used as filename and internal key. Must be unique. |
| `name` | yes | Customer-facing salon name. Shown in the welcome message. |
| `whatsapp_number` | yes | The salon's WhatsApp number in E.164 format. Must match the `To` number Twilio sends on inbound webhooks. |
| `slots` | yes | Initial array of bookable slot labels. After first message, the live set lives in `<id>-data.json`. |

## Onboarding playbook

1. Lead messages `+971541721640` → Signup Bot captures their info in `leads.jsonl`.
2. You contact the lead, agree on pricing.
3. Register their WhatsApp number as a Twilio Sender (Senders Hub → Create new sender →
   their number, their salon name as display name, link to Eloquent FZE LLC WABA).
4. Wait for Meta display-name approval (hours to ~3 days).
5. Configure the Twilio sender's webhook URL: `https://bot.eloquentservice.com/twilio`
6. Create `tenants/<salon-id>.json` with their config.
7. `git add tenants/<salon-id>.json && git commit && git push`
8. On the droplet: `cd /var/www/bot && git pull && pm2 restart rezzy-bot`
9. Bot logs should show `Loaded N tenant(s): ...,<salon-id>→+97150XXXXXXX`.
10. Test: message their number from your WhatsApp, confirm the menu appears with their salon name.
