# Restaurant Voice AI Solutions

AI guest messaging for restaurants — so no to-go order gets missed when the floor is slammed.

**Pilot:** [Fish City Grill — Culebra](https://www.fishcitygrill.com/locations/culebra) (San Antonio, TX)  
**Channels:** Telegram guest assistant · HTTP `POST /chat`  
**Repo:** [github.com/Gmuney/restaurant-voice-ai-solutions](https://github.com/Gmuney/restaurant-voice-ai-solutions)

---

## What it does

Guests get fast, policy-aware answers. Staff keep control of sold-out items and chalkboard specials.

- Hours, location, parking, menu, and Happy Hour
- Allergy and dietary answers with a safety disclaimer
- Chalkboard specials (photo snapshot + OCR at 11:00am and 4:30pm America/Chicago)
- Demo reservations (adults/kids, time, booth / table / patio)
- To-go intake with manager approve / decline
- Live 86 board (`86 redfish`, `un86 …`, `86 list`)
- English / Spanish auto-switch
- Large parties and catering → manager transfer

---

## Repository layout

```
src/
  bot/          Telegram guest assistant + manager tools
  api/          Express POST /chat
  engine/       FAQ, menu, specials, and language rules
  ai/           Model prompt + conversation history
  board/        Chalkboard snapshot + OCR
  store.js      Sessions, orders, reservations, 86 board
  cli.js        Local FAQ demo
  paths.js      Knowledge and data directories
knowledge/      Restaurant facts (hours, FAQ, menu, Happy Hour)
tests/          Reply smoke tests
scripts/        Optional chalkboard cron installer
```

Runtime files (`data/`), secrets (`.env`), and `node_modules/` are gitignored.

---

## Quick start

```bash
git clone https://github.com/Gmuney/restaurant-voice-ai-solutions.git
cd restaurant-voice-ai-solutions
npm install
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN
```

| Command | What it runs |
|---------|----------------|
| `npm run telegram` | Telegram assistant |
| `npm start` | Chat API |
| `npm run demo` | Local CLI |
| `npm run test:replies` | FAQ / policy smoke tests |
| `npm run check` | Syntax check |

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot auth |
| `GEMINI_API_KEY` | Optional Gemini chat / board OCR |
| `GEMINI_CHAT_MODEL` | Chat model (default `gemini-flash-latest`) |
| `PORT` | Chat API port |

---

## Guest demo

> I wanted to make a reservation for 4 today at 5pm

The bot collects adults / kids, date and time, seating preference, then confirms with the guest.

### Manager tools

| Command | What it does |
|---------|----------------|
| `86 redfish` | Mark item sold out |
| `un86 redfish` | Put item back on |
| `86 list` | Show today’s 86 board |
| `/reservations` | Recent bookings |
| `/orders` | Pending to-go requests |
| `/specials` · `/setspecials` · `/rereadboard` | Chalkboard photo / text |
| `/clearchat` | Reset AI history for this chat |
| `/managerhelp` | Command list |

---

## Chat API

`POST /chat`

```json
{
  "message": "Party of 10, booth seating, and gluten-free options?"
}
```

Or send full history with `"messages": [{ "role": "user", "content": "..." }]`.

---

## Pilot policies

- **Max party size:** 12 online; larger groups transfer to a manager
- **Sides:** swap any listed side for another listed side
- **Patio:** dog-friendly; service animals welcome
- **Specials board:** lunch snapshot 11:00am, dinner 4:30pm (Chicago)
- **Reservations (demo):** guest confirmation; managers review with `/reservations`

Optional chalkboard cron (the bot also schedules in-process):

```bash
sudo bash scripts/install-board-cron.sh
```

---

## Roadmap

1. SMS channel parity with Telegram
2. Voice / phone agent for inbound to-go and FAQ calls
3. CRM lead capture
4. POS / inventory sync for real-time 86
5. Multi-location config + manager dashboard

---

## License

Private project — Restaurant Voice AI Solutions. All rights reserved.
