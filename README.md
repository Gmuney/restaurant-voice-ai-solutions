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

## Pilot status (messaging)

| Deliverable | Status |
|-------------|--------|
| Telegram guest assistant live | Done |
| Knowledge base (restaurant, FAQ, everyday menu) | Done |
| Chalkboard specials — auto refresh **11:00am** & **4:30pm** America/Chicago + OCR | Done |
| Demo reservations (adults/kids, time, booth/table/patio; guest confirm, **no manager ping**) | Done |
| To-go intake with manager approve/decline | Done |
| Real-time 86 board (`86 redfish`, `un86 …`, `86 list`) | Done |
| Side substitutions — yes, swap for other listed side items | Done |
| Allergy & dietary answers + safety disclaimer | Done |
| Large-party policy (max **12**; larger → transfer to manager) | Done |
| Multi-part questions in one reply | Done |
| Spanish / English auto-switch on greeting (`Hola` ↔ `Hi`) | Done |
| Gemini chat with **full message history** | Done |
| Express `POST /chat` API | Done |

### Guest demo — reservation

Say something like:

> I wanted to make a reservation for 4 today at 5pm

The bot asks for **adults / kids**, fills in date & time when provided, asks **booth / table / patio**, then **confirms with the guest**. No Telegram ping is sent to managers. Managers can still review with `/reservations`.

### Manager tools

| Command | What it does |
|---------|----------------|
| `86 redfish` | Mark item sold out (slash optional) |
| `un86 redfish` | Put item back on |
| `86 list` | Show today’s 86 board |
| `/reservations` | Recent bookings (demo auto-confirms) |
| `/orders` | Pending to-go requests |
| `/specials` · `/setspecials` · `/rereadboard` | Chalkboard photo / text |
| `/clearchat` | Reset AI history for this chat |
| `/managerhelp` | Command list |

---

## Architecture

```
src/
  telegram.js       Telegram bot + manager tools + reservation demo
  server.js         Express POST /chat API
  ai-chat.js        Gemini + conversation history
  system-prompt.js  Knowledge → system instructions
  reply.js          FAQ / policy engine
  menu-check.js     Menu availability & dietary guides
  specials.js       Chalkboard specials Q&A
  read-board.js     Snapshot scheduler + OCR pipeline
  store.js          Sessions, orders, reservations, chat history
knowledge/
  restaurant.json   Location, hours, policies
  faq.json          FAQ intents
  menu-items.json   Everyday menu catalog
scripts/
  install-board-cron.sh   Backup cron (11:00 / 16:30 Chicago)
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

Optional chalkboard cron (bot also schedules in-process):

```bash
sudo bash scripts/install-board-cron.sh
```

Systemd (this VPS): `fish-city-telegram.service`

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

## Policies (pilot)

- **Max party size:** 12 online; larger → transfer to manager  
- **Sides:** yes — change out any side item for our other listed side items  
- **86:** managers type `86 <item>` in Telegram for real-time sold-out  
- **Specials board:** snapshot at 11:00am lunch and 4:30pm dinner (Chicago)  
- **Reservations (demo):** guest confirmation only; managers poll `/reservations`

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
