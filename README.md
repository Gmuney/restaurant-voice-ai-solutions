# Restaurant Voice AI Solutions

**AI guest messaging for restaurants — so no to-go order gets missed.**

[github.com/Gmuney/restaurant-voice-ai-solutions](https://github.com/Gmuney/restaurant-voice-ai-solutions)

---

## The problem

Restaurants miss out on roughly **30% of to-go orders** when call volume is high and staff are busy. Bartenders and hosts end up taking every call — often several at once — which slows service and loses revenue.

## The solution

An **AI-powered guest agent** that answers FAQs, hours, location, and menu questions, handles allergy-aware replies, captures reservation and to-go leads, and frees staff to focus on guests in the building.

**Pilot:** Fish City Grill — Culebra (San Antonio, TX) on Telegram + HTTP chat API.

---

## Day 1 progress (completed)

Built and demoed the full messaging pilot on the VPS:

| Deliverable | Status |
|-------------|--------|
| Telegram guest assistant live | Done |
| Knowledge base (restaurant, FAQ, everyday menu) | Done |
| Chalkboard specials — scheduled snapshots (~11am / ~4:30pm) + OCR text | Done |
| Reservations & to-go intake with manager approve/decline | Done |
| Demo 86 / sold-out board (`/86`, `/un86`, `/86list`) | Done |
| Allergy & dietary answers + safety disclaimer | Done |
| Multi-part questions in one reply (party + seating + allergens) | Done |
| Large-party policy (usual online size **8**; “may accommodate” + manager option) | Done |
| Gemini chat with **full message history** (not single-prompt) | Done |
| Express `POST /chat` API | Done |
| Clean git repo + professional project README | Done |

### Manager tools shipped
`/specials` · `/setspecials` · `/rereadboard` · `/reservations` · `/orders` · `/clearchat` · `/86` family

---

## Architecture

```
src/
  telegram.js       Telegram bot + manager tools
  server.js         Express POST /chat API
  ai-chat.js        Gemini + conversation history
  system-prompt.js  Knowledge → system instructions
  reply.js          FAQ / policy engine
  menu-check.js     Menu availability & dietary guides
  specials.js       Chalkboard specials Q&A
  read-board.js     Snapshot + OCR pipeline
  store.js          Sessions, orders, chat history
knowledge/
  restaurant.json   Location, hours, policies
  faq.json          FAQ intents
  menu-items.json   Everyday menu catalog
scripts/
  install-board-cron.sh
```

Secrets (`.env`), runtime `data/`, and `node_modules/` are gitignored.

---

## Quick start

```bash
git clone https://github.com/Gmuney/restaurant-voice-ai-solutions.git
cd restaurant-voice-ai-solutions
npm install
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN

npm run telegram      # Telegram assistant
npm start             # Chat API
npm run demo          # Local CLI
npm run test:replies
```

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot auth |
| `GEMINI_CHAT_MODEL` | Chat model (default `gemini-flash-latest`) |
| `PORT` | Chat API port |

Optional chalkboard cron:

```bash
sudo bash scripts/install-board-cron.sh
```

---

## Chat API

`POST /chat`

```json
{
  "message": "Party of 10, booth seating, and gluten-free options?"
}
```

Or full history:

```json
{
  "messages": [
    { "role": "user", "content": "Do you take reservations?" },
    { "role": "model", "content": "Yes — we do." },
    { "role": "user", "content": "What about a party of 12?" }
  ]
}
```

---

## Roadmap (next)

1. SMS channel parity with Telegram  
2. Voice / phone agent for inbound to-go and FAQ calls  
3. CRM lead capture from conversations  
4. POS / inventory sync for real-time 86  
5. Multi-location tenant config + manager dashboard  

---

## License

Private project — Restaurant Voice AI Solutions. All rights reserved unless otherwise noted.

**Restaurant Voice AI Solutions** · Pilot: Fish City Grill — Culebra
