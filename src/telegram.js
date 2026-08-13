import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  generateReply,
  restaurant,
  extractPartySize,
  largePartyAnswer,
  MAX_ONLINE_PARTY,
} from "./reply.js";
import {
  unlockManager,
  listManagerIds,
  getSoldOut,
  addSoldOut,
  removeSoldOut,
  findSoldOutMatch,
  getSession,
  setSession,
  saveReservation,
  updateReservation,
  getReservation,
  getReservations,
  reservationsForGuest,
  pendingReservations,
  getSpecialsText,
  setSpecialsText,
  saveOrder,
  updateOrder,
  getOrder,
  pendingOrders,
  newId,
  clearChatMessages,
  appendChatMessage,
} from "./store.js";
import {
  specialsImageUrl,
  specialsCaption,
  answerSpecialsQuestion,
  formatBoardReading,
  readCachedBoard,
} from "./specials.js";
import {
  startBoardRefreshLoop,
  loadSnapshotImageBuffer,
  refreshBoardReading as rereadBoardSnapshot,
} from "./read-board.js";
import {
  answerAvailability,
  answerMenuList,
  answerMenuGuide,
  findMenuItem,
} from "./menu-check.js";
import { generateAiReply } from "./ai-chat.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log(`${restaurant.name} Telegram bot is live.`);
console.log("DEMO: full manager access + expanded FAQ knowledge.");

function uid(msg) {
  return msg.from?.id;
}
function displayName(msg) {
  return msg.from?.username || msg.from?.first_name || "someone";
}
function rememberManager(msg) {
  unlockManager(uid(msg), displayName(msg));
}

async function notifyManagers(text, extra = {}) {
  const ids = listManagerIds();
  if (!ids.length) {
    console.log("[warn] No managers registered yet.");
    return 0;
  }
  let sent = 0;
  for (const id of ids) {
    try {
      await bot.sendMessage(id, text, extra);
      sent++;
    } catch (err) {
      console.error(`Notify manager ${id} failed:`, err.message || err);
    }
  }
  return sent;
}

function formatRes(r) {
  const adults = r.adults != null ? r.adults : null;
  const kids = r.kids != null ? r.kids : null;
  const partyLine =
    adults != null || kids != null
      ? `Party: ${r.partySize} (${adults ?? 0} adults, ${kids ?? 0} kids)`
      : `Party: ${r.partySize}`;
  return [
    `Reservation ${r.id}`,
    `Status: ${r.status}`,
    `Name: ${r.name}`,
    partyLine,
    r.seating ? `Seating: ${r.seating}` : null,
    `When: ${r.date} ${r.time}`,
    r.phone ? `Phone: ${r.phone}` : null,
    r.demoAutoConfirm ? "Demo: auto-confirmed (no manager ping)" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOrder(o) {
  return [
    `To-go order ${o.id}`,
    `Status: ${o.status}`,
    `Name: ${o.name}`,
    `Phone: ${o.phone}`,
    `Pickup: ${o.pickupTime}`,
    `Items:\n${o.items}`,
    o.notes ? `Notes: ${o.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function managerHelp() {
  return [
    "Manager commands (DEMO — open access):",
    '86 board (type with or without /):',
    '  86 redfish   — mark item sold out (off menu for guests)',
    "  un86 redfish — put it back on",
    "  86 list      — show today's 86 board",
    "/specials · /setspecials <text> · /rereadboard",
    "/reservations — view recent bookings (demo auto-confirms, no ping) · /orders",
    "/clearchat — reset AI conversation memory for this chat",
    "/managerhelp",
    "",
    'Guests: "appetizers", "entrees", "full menu", "today\'s specials", "do y\'all have trout?"',
    "Chalkboard: auto refresh 11:00am lunch + 4:30pm dinner (America/Chicago).",
    "/rereadboard — new chalkboard photo + full text read",
    "/rereadtext — re-read small ingredient/sides text from saved photo",
    "86 board = real-time sold-out (later can sync from POS/count system).",
    "AI replies use full chat history (not a single prompt).",
  ].join("\n");
}

/** Prefer a short menu alias so guest matching works (e.g. "redfish"). */
function resolve86ItemName(raw) {
  const typed = String(raw || "").trim().replace(/\s+/g, " ");
  if (!typed) return "";
  const hit = findMenuItem(typed);
  if (!hit?.item) return typed;
  const aliases = (hit.item.aliases || []).map((a) => String(a).trim()).filter(Boolean);
  const compact = typed.toLowerCase().replace(/\s+/g, "");
  const sameThing = aliases.filter(
    (a) => a.toLowerCase().replace(/\s+/g, "") === compact
  );
  if (sameThing.length) {
    const nospace = sameThing.find((a) => !/\s/.test(a));
    return nospace || sameThing[0];
  }
  // Prefer shortest alias for the matched dish (usually the everyday name)
  if (aliases.length) {
    return [...aliases].sort((a, b) => a.length - b.length)[0];
  }
  return hit.item.name || typed;
}

async function apply86(msg, itemRaw) {
  const item = resolve86ItemName(itemRaw);
  if (!item) {
    await bot.sendMessage(
      msg.chat.id,
      'Tell me what to 86 — example: 86 redfish'
    );
    return;
  }
  addSoldOut(item, displayName(msg));
  const catalog = findMenuItem(item);
  const detail = catalog?.item?.name ? ` (${catalog.item.name})` : "";
  await bot.sendMessage(msg.chat.id, `86'd: ${item}${detail}\nGuests will hear we're sold out.`);
  await notifyManagers(`📣 ${displayName(msg)} 86'd: ${item}${detail}`);
}

async function applyUn86(msg, itemRaw) {
  const item = resolve86ItemName(itemRaw);
  if (!item) {
    await bot.sendMessage(
      msg.chat.id,
      "Tell me what to put back — example: un86 redfish"
    );
    return;
  }
  const ok = removeSoldOut(item) || removeSoldOut(itemRaw.trim());
  await bot.sendMessage(
    msg.chat.id,
    ok ? `Back on menu: ${item}` : `Wasn't on 86 board: ${item}`
  );
  if (ok) await notifyManagers(`📣 ${displayName(msg)} restored: ${item}`);
}

async function send86List(msg) {
  const { items } = getSoldOut();
  await bot.sendMessage(
    msg.chat.id,
    items.length
      ? `86 board:\n${items.map((i) => `• ${i.name} (by ${i.by})`).join("\n")}`
      : "86 board is clear."
  );
}

/** Plain-text manager 86 commands: "86 redfish", "un86 redfish", "86 list" */
async function handlePlain86(msg) {
  const text = String(msg.text || "").trim();
  let m = text.match(/^86\s+list$/i) || text.match(/^86list$/i);
  if (m) {
    await send86List(msg);
    return true;
  }
  m = text.match(/^86\s+(.+)$/i);
  if (m) {
    await apply86(msg, m[1]);
    return true;
  }
  m = text.match(/^un86\s+(.+)$/i);
  if (m) {
    await applyUn86(msg, m[1]);
    return true;
  }
  if (/^86$/i.test(text) || /^un86$/i.test(text)) {
    await bot.sendMessage(
      msg.chat.id,
      'Usage:\n86 redfish — mark sold out\nun86 redfish — put back on\n86 list — show board'
    );
    return true;
  }
  return false;
}

async function fetchSpecialsBuffer(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "FishCityCulebraBot/1.0" },
  });
  if (!res.ok) throw new Error(`specials image HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type && !type.includes("image") && !type.includes("octet-stream")) {
    throw new Error(`specials URL is not an image (${type})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("specials image too small");
  return buf;
}

async function sendSpecials(chatId, extraText = "") {
  const cached = readCachedBoard();
  const autoText = extraText || formatBoardReading(cached);

  await bot.sendMessage(
    chatId,
    `${autoText || "Here's today's chalkboard specials."}\n\nSending the board snapshot photo next…`.slice(
      0,
      4000
    )
  );

  const caption = specialsCaption().slice(0, 1024);
  try {
    let buf = loadSnapshotImageBuffer(cached);
    if (!buf) {
      console.log("[specials] no local snapshot — fetching feed once");
      buf = await fetchSpecialsBuffer(specialsImageUrl());
    } else {
      console.log(`[specials] using local snapshot ${cached.snapshotPath}`);
    }
    await bot.sendPhoto(
      chatId,
      buf,
      { caption },
      { filename: "culebra-specials.jpg", contentType: "image/jpeg" }
    );
    console.log(`[specials] photo sent to ${chatId} (${buf.length} bytes)`);
  } catch (err) {
    console.error("specials photo failed", err.message || err);
    const saved = getSpecialsText();
    await bot.sendMessage(
      chatId,
      [
        "Couldn't load the chalkboard snapshot photo right now.",
        saved.text ? `\nManager notes:\n${saved.text}` : null,
        `\nYou can also call ${restaurant.phone}.`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  rememberManager(msg);
  await bot.sendMessage(
    msg.chat.id,
    `${generateReply("hi")}\n\n${generateReply("help")}\n\nTry: "how big can my party be?", "today's specials", "to go order".\n\n---\n${managerHelp()}`
  );
});

bot.onText(/^\/help(?:@\w+)?$/, async (msg) => {
  rememberManager(msg);
  await bot.sendMessage(
    msg.chat.id,
    `${generateReply("help")}\n\n---\n${managerHelp()}`
  );
});

bot.onText(/^\/managerhelp(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  await bot.sendMessage(msg.chat.id, managerHelp());
});

bot.onText(/^\/manager(?:@\w+)?/i, async (msg) => {
  rememberManager(msg);
  await bot.sendMessage(msg.chat.id, `Demo mode — manager access open.\n\n${managerHelp()}`);
});

bot.onText(/^\/clearchat(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  clearChatMessages(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "Cleared AI conversation history for this chat.");
});

bot.onText(/^\/86list(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  await send86List(msg);
});

bot.onText(/^\/86(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  rememberManager(msg);
  await apply86(msg, match[1]);
});

bot.onText(/^\/un86(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  rememberManager(msg);
  await applyUn86(msg, match[1]);
});

bot.onText(/^\/reservations(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const list = getReservations()
    .reservations.filter((r) => r.status !== "cancelled")
    .slice(-15)
    .reverse();
  if (!list.length) {
    await bot.sendMessage(msg.chat.id, "No reservation requests yet.");
    return;
  }
  await bot.sendMessage(
    msg.chat.id,
    `Showing ${list.length} recent reservation(s). Demo bookings auto-confirm (no ping).`
  );
  for (const r of list) {
    const extra =
      r.status === "pending"
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Confirm", callback_data: `res:ok:${r.id}` },
                  { text: "❌ Decline", callback_data: `res:no:${r.id}` },
                ],
              ],
            },
          }
        : {};
    await bot.sendMessage(msg.chat.id, formatRes(r), extra);
  }
});

bot.onText(/^\/orders(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const pending = pendingOrders();
  if (!pending.length) {
    await bot.sendMessage(msg.chat.id, "No pending to-go orders.");
    return;
  }
  for (const o of pending.slice(0, 10)) {
    await bot.sendMessage(msg.chat.id, formatOrder(o), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `ord:ok:${o.id}` },
            { text: "🍳 Working", callback_data: `ord:cook:${o.id}` },
          ],
          [
            { text: "📦 Ready", callback_data: `ord:ready:${o.id}` },
            { text: "❌ Decline", callback_data: `ord:no:${o.id}` },
          ],
        ],
      },
    });
  }
});

bot.onText(/^\/specials(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const ans = await answerSpecialsQuestion("today's specials");
  await sendSpecials(msg.chat.id, ans.text);
});

bot.onText(/^\/rereadboard(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    "Capturing a fresh chalkboard snapshot and reading large + small text (ingredients/sides). This can take a couple minutes…"
  );
  try {
    const board = await rereadBoardSnapshot();
    await bot.sendMessage(
      chatId,
      `Snapshot saved.\n\n${formatBoardReading(board)}`.slice(0, 4000)
    );
    await sendSpecials(chatId, formatBoardReading(board));
  } catch (err) {
    console.error(err);
    await bot.sendMessage(
      chatId,
      `Couldn't snapshot the board right now. Try again, or call ${restaurant.phone}.`
    );
  }
});

bot.onText(/^\/rereadtext(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    "Re-reading small chalkboard text (ingredients & sides) from the saved snapshot…"
  );
  try {
    const { reocrSnapshot } = await import("./read-board.js");
    const board = await reocrSnapshot();
    await bot.sendMessage(chatId, formatBoardReading(board).slice(0, 4000));
  } catch (err) {
    console.error(err);
    await bot.sendMessage(
      chatId,
      `Couldn't re-read the snapshot. Try /rereadboard, or call ${restaurant.phone}.`
    );
  }
});

bot.onText(/^\/setspecials(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  rememberManager(msg);
  const text = (match?.[1] || "").trim();
  if (!text) {
    const cur = getSpecialsText();
    await bot.sendMessage(
      msg.chat.id,
      cur.text
        ? `Current summary:\n${cur.text}\n\nUpdate: /setspecials ...`
        : "Usage: /setspecials Blackened redfish $28 · Shrimp étouffée $22"
    );
    return;
  }
  setSpecialsText(text, displayName(msg));
  await bot.sendMessage(msg.chat.id, `Specials summary saved ✅\n${text}`);
  await notifyManagers(`📣 ${displayName(msg)} updated specials:\n${text}`);
});

bot.on("callback_query", async (query) => {
  unlockManager(
    query.from.id,
    query.from.username || query.from.first_name || "manager"
  );
  const [kind, action, id] = (query.data || "").split(":");
  if (!id || (kind !== "res" && kind !== "ord")) {
    await bot.answerCallbackQuery(query.id);
    return;
  }
  const managerName = query.from.username || query.from.first_name || "manager";

  if (kind === "ord") {
    const order = getOrder(id);
    if (!order) {
      await bot.answerCallbackQuery(query.id, { text: "Not found" });
      return;
    }
    const map = { ok: "confirmed", cook: "preparing", ready: "ready", no: "declined" };
    const status = map[action];
    if (!status) {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    updateOrder(id, { status, decidedBy: managerName, decidedAt: new Date().toISOString() });
    await bot.answerCallbackQuery(query.id, { text: status });
    await bot.sendMessage(
      query.message.chat.id,
      `${status.toUpperCase()} by ${managerName}\n${formatOrder({ ...order, status })}\n\nEnter in Toast if needed.`
    );
    const guestNotes = {
      confirmed: `To-go confirmed under ${order.name}. Pickup: ${order.pickupTime}.`,
      preparing: `Kitchen is working on your order (${order.name}). Pickup: ${order.pickupTime}.`,
      ready: `Your to-go order is READY under ${order.name}. See you soon!`,
      declined: `We couldn't take that to-go order. Call ${restaurant.phone} or try ${restaurant.orderOnlineUrl}`,
    };
    try {
      await bot.sendMessage(order.guestChatId, guestNotes[status]);
    } catch (e) {
      console.error(e.message);
    }
    return;
  }

  const res = getReservation(id);
  if (!res) {
    await bot.answerCallbackQuery(query.id, { text: "Not found" });
    return;
  }

  if (action === "ok") {
    updateReservation(id, {
      status: "confirmed",
      decidedBy: managerName,
      decidedAt: new Date().toISOString(),
    });
    await bot.answerCallbackQuery(query.id, { text: "Confirmed" });
    await bot.sendMessage(
      query.message.chat.id,
      `✅ Confirmed by ${managerName}\n${formatRes({ ...res, status: "confirmed" })}\n\nEnter in OpenTable/Toast if needed.`
    );
    try {
      await bot.sendMessage(
        res.guestChatId,
        `You're confirmed!\n${res.date} ${res.time} · party of ${res.partySize} · ${res.name}\nCall ${restaurant.phone} if needed.`
      );
    } catch (e) {
      console.error(e.message);
    }
  } else if (action === "no") {
    updateReservation(id, {
      status: "declined",
      decidedBy: managerName,
      decidedAt: new Date().toISOString(),
    });
    await bot.answerCallbackQuery(query.id, { text: "Declined" });
    try {
      await bot.sendMessage(
        res.guestChatId,
        `We couldn't confirm that time. Call ${restaurant.phone} or send a new request here.`
      );
    } catch (e) {
      console.error(e.message);
    }
  } else if (action === "cancel") {
    updateReservation(id, {
      status: "cancelled",
      decidedBy: managerName,
      decidedAt: new Date().toISOString(),
    });
    await bot.answerCallbackQuery(query.id, { text: "Cancelled" });
    try {
      await bot.sendMessage(
        res.guestChatId,
        `Your reservation for ${res.date} ${res.time} was cancelled. Call ${restaurant.phone} to rebook.`
      );
    } catch (e) {
      console.error(e.message);
    }
  }
});

const RES_TRIGGERS =
  /\b(i wanted to make a reserv|want(ed)? to (make a )?reserv|make a reserv|book a table|book(ing)?\b.{0,20}\btable|party of\s*\d|table for\s*\d|\breservation\b)/i;

/** Start booking flow — not pure FAQ like "do you take reservations?" */
function wantsToBookReservation(text) {
  const t = String(text || "");
  const infoOnly =
    /\b(do you (take|accept)|can i|taking|accept)\b.{0,20}\breserv/i.test(t) &&
    !/\b(for\s*\d|today|tomorrow|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i.test(
      t
    );
  if (infoOnly) return false;
  return RES_TRIGGERS.test(t);
}
const CANCEL_TRIGGERS =
  /\b(cancel (my )?reserv|cancel (my )?booking|cancel table)\b/i;
const CHANGE_TRIGGERS =
  /\b(change (my )?reserv|modify (my )?reserv|reschedule)\b/i;
const ORDER_TRIGGERS =
  /\b(to[- ]?go|takeout|take out|place an order|order food|to go order)\b/i;
const SPECIALS_TRIGGERS =
  /\b(specials?|chalk\s*-?\s*boards?|daily special|specials photo|today'?s special|what'?s on (the )?board)\b/i;

function parseReservationHints(text) {
  const t = String(text || "");
  const partySize = extractPartySize(t);
  const timeM = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i);
  let date = null;
  if (/\btoday\b/i.test(t)) date = "today";
  else if (/\btomorrow\b/i.test(t)) date = "tomorrow";
  else {
    const d = t.match(
      /\b((?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i
    );
    if (d) date = d[1];
  }
  let seating = null;
  if (/\bpatio\b/i.test(t)) seating = "patio";
  else if (/\bbooth\b/i.test(t)) seating = "booth";
  else if (/\btable\b/i.test(t) && !/\btable for\b/i.test(t)) seating = "table";
  return {
    partySize: partySize || null,
    time: timeM ? timeM[1].replace(/\s+/g, "").toLowerCase() : null,
    date,
    seating,
  };
}

function parseAdultsKids(text) {
  const t = String(text || "").trim();
  const adultsM = t.match(/(\d+)\s*adults?/i);
  const kidsM = t.match(/(\d+)\s*(?:kids?|children|child)\b/i);
  if (adultsM || kidsM) {
    return {
      adults: adultsM ? Number(adultsM[1]) : 0,
      kids: kidsM ? Number(kidsM[1]) : 0,
    };
  }
  const pair = t.match(/^(\d+)\s*(?:and|&|\/|,)\s*(\d+)\s*$/i);
  if (pair) return { adults: Number(pair[1]), kids: Number(pair[2]) };
  if (/^(all\s+)?adults?\s*$/i.test(t)) return null; // need party size context
  return null;
}

function parseSeatingChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/\bpatio\b/.test(t)) return "patio";
  if (/\bbooth\b/.test(t)) return "booth";
  if (/\btable\b/.test(t)) return "table";
  return null;
}

async function transferLargeParty(msg, n) {
  const chatId = msg.chat.id;
  setSession(chatId, null);
  await bot.sendMessage(chatId, largePartyAnswer(n));
  await notifyManagers(
    `📞 TRANSFER TO MANAGER — party of ${n} (max ${MAX_ONLINE_PARTY})\nGuest: ${displayName(msg)} (chat ${chatId})\nThey want a reservation larger than our booking max. Please call/text them back.`
  );
}

function nextReservationPrompt(data) {
  if (data.adults == null || data.kids == null) {
    if (data.partySize) {
      return `Got it — party of ${data.partySize}${data.date ? ` ${data.date}` : ""}${data.time ? ` at ${data.time}` : ""}.\n\nHow many adults and how many kids? (ex: 3 adults, 1 kid)`;
    }
    return "How many adults and how many kids? (ex: 2 adults, 1 kid)";
  }
  if (!data.date) return "What day? (ex: today, Friday, 8/15)";
  if (!data.time) return "What time? (ex: 5pm, 6:30pm)";
  if (!data.seating) {
    return "Would you like a booth, a table, or a patio table?";
  }
  if (!data.name) return "Name for the reservation?";
  return null;
}

function reservationStepFor(data) {
  if (data.adults == null || data.kids == null) return "adults_kids";
  if (!data.date) return "date";
  if (!data.time) return "time";
  if (!data.seating) return "seating";
  if (!data.name) return "name";
  return "done";
}

async function finalizeDemoReservation(msg, data) {
  const chatId = msg.chat.id;
  const adults = Number(data.adults) || 0;
  const kids = Number(data.kids) || 0;
  const partySize = adults + kids;
  const name = data.name || displayName(msg);
  const res = saveReservation({
    id: newId("res"),
    status: "confirmed",
    demoAutoConfirm: true,
    guestChatId: chatId,
    guestName: displayName(msg),
    name,
    adults,
    kids,
    partySize,
    date: data.date,
    time: data.time,
    seating: data.seating,
    phone: data.phone || "",
    createdAt: new Date().toISOString(),
    channel: "telegram",
  });
  setSession(chatId, null);
  // Demo: confirm with guest only — no manager ping. Managers can /reservations.
  await bot.sendMessage(
    chatId,
    [
      "✅ You're confirmed!",
      "",
      `Name: ${name}`,
      `Party: ${adults} adult${adults === 1 ? "" : "s"}, ${kids} kid${kids === 1 ? "" : "s"} (${partySize} total)`,
      `When: ${data.date} at ${data.time}`,
      `Seating: ${data.seating}`,
      "",
      "See you then — if you need to change anything, just message us here.",
      `(Ref ${res.id})`,
    ].join("\n")
  );
}

async function startReservationWizard(chatId, hints = {}, msg = null) {
  const data = {
    name: null,
    adults: null,
    kids: null,
    partySize: hints.partySize || null,
    date: hints.date || null,
    time: hints.time || null,
    seating: hints.seating || null,
  };
  if (data.partySize && data.partySize > MAX_ONLINE_PARTY && msg) {
    await transferLargeParty(msg, data.partySize);
    return;
  }
  const step = reservationStepFor(data);
  setSession(chatId, { type: "reservation", step, data });
  const prompt = nextReservationPrompt(data);
  await bot.sendMessage(
    chatId,
    `${prompt}\n\n(Demo reservation — I'll confirm with you here. Type cancel to stop.)`
  );
}

async function startOrderWizard(chatId) {
  setSession(chatId, { type: "order", step: "name", data: {} });
  await bot.sendMessage(
    chatId,
    `To-go order — name for the order?\n(Or order online: ${restaurant.orderOnlineUrl})\nType cancel to stop.`
  );
}

async function handleReservationSession(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.type !== "reservation") return false;
  const text = msg.text.trim();
  if (/^(cancel|stop|nevermind)$/i.test(text)) {
    setSession(chatId, null);
    await bot.sendMessage(chatId, "Reservation request cancelled.");
    return true;
  }
  const { step, data } = session;

  if (step === "adults_kids") {
    const parsed = parseAdultsKids(text);
    if (!parsed) {
      await bot.sendMessage(
        chatId,
        "Please send adults and kids, like: 3 adults, 1 kid"
      );
      return true;
    }
    const total = parsed.adults + parsed.kids;
    if (total < 1) {
      await bot.sendMessage(chatId, "Need at least 1 guest — try again?");
      return true;
    }
    if (data.partySize && total !== data.partySize) {
      // Guest gave a breakdown; trust the breakdown and update total
    }
    if (total > MAX_ONLINE_PARTY) {
      await transferLargeParty(msg, total);
      return true;
    }
    data.adults = parsed.adults;
    data.kids = parsed.kids;
    data.partySize = total;
  } else if (step === "date") {
    data.date = text;
  } else if (step === "time") {
    data.time = text;
  } else if (step === "seating") {
    const seat = parseSeatingChoice(text);
    if (!seat) {
      await bot.sendMessage(
        chatId,
        "Please choose one: booth, table, or patio"
      );
      return true;
    }
    data.seating = seat;
  } else if (step === "name") {
    data.name = text;
  } else {
    await bot.sendMessage(chatId, nextReservationPrompt(data) || "One moment…");
    return true;
  }

  const next = reservationStepFor(data);
  if (next === "done") {
    await finalizeDemoReservation(msg, data);
    return true;
  }
  setSession(chatId, { type: "reservation", step: next, data });
  await bot.sendMessage(chatId, nextReservationPrompt(data));
  return true;
}

async function handleOrderSession(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.type !== "order") return false;
  const text = msg.text.trim();
  if (/^(cancel|stop|nevermind)$/i.test(text)) {
    setSession(chatId, null);
    await bot.sendMessage(chatId, "To-go order cancelled.");
    return true;
  }
  const { step, data } = session;
  if (step === "name") {
    data.name = text;
    setSession(chatId, { type: "order", step: "phone", data });
    await bot.sendMessage(chatId, "Phone?");
    return true;
  }
  if (step === "phone") {
    data.phone = text;
    setSession(chatId, { type: "order", step: "pickup", data });
    await bot.sendMessage(chatId, "Pickup time? (30 min, 6:15pm, ASAP)");
    return true;
  }
  if (step === "pickup") {
    data.pickupTime = text;
    setSession(chatId, { type: "order", step: "items", data });
    await bot.sendMessage(chatId, "Items + quantities?");
    return true;
  }
  if (step === "items") {
    data.items = text;
    const hits = findSoldOutMatch(text);
    if (hits.length) {
      await bot.sendMessage(
        chatId,
        `Heads-up, may be 86'd: ${hits.map((h) => h.name).join(", ")}`
      );
    }
    setSession(chatId, { type: "order", step: "notes", data });
    await bot.sendMessage(chatId, 'Notes? Or type "none".');
    return true;
  }
  if (step === "notes") {
    data.notes = /^none$/i.test(text) ? "" : text;
    setSession(chatId, null);
    const order = saveOrder({
      id: newId("ord"),
      status: "pending",
      guestChatId: chatId,
      guestName: displayName(msg),
      ...data,
      createdAt: new Date().toISOString(),
      channel: "telegram",
    });
    const sent = await notifyManagers(`🥡 NEW to-go\n${formatOrder(order)}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `ord:ok:${order.id}` },
            { text: "🍳 Working", callback_data: `ord:cook:${order.id}` },
          ],
          [
            { text: "📦 Ready", callback_data: `ord:ready:${order.id}` },
            { text: "❌ Decline", callback_data: `ord:no:${order.id}` },
          ],
        ],
      },
    });
    await bot.sendMessage(
      chatId,
      sent
        ? `To-go request sent under ${data.name}. Pickup: ${data.pickupTime}.`
        : `Please call ${restaurant.phone} or use ${restaurant.orderOnlineUrl}`
    );
    return true;
  }
  return true;
}

async function handleCancelChange(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (CANCEL_TRIGGERS.test(text)) {
    const mine = reservationsForGuest(chatId).filter((r) =>
      ["pending", "confirmed"].includes(r.status)
    );
    if (!mine.length) {
      await bot.sendMessage(
        chatId,
        `No active reservation on this chat. Call ${restaurant.phone}.`
      );
      return true;
    }
    const latest = mine[mine.length - 1];
    updateReservation(latest.id, {
      status: "cancel_requested",
      cancelRequestedAt: new Date().toISOString(),
    });
    await notifyManagers(`⚠️ Cancel requested\n${formatRes(latest)}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑️ Mark cancelled", callback_data: `res:cancel:${latest.id}` }],
        ],
      },
    });
    await bot.sendMessage(chatId, "Cancel request sent to managers.");
    return true;
  }
  if (CHANGE_TRIGGERS.test(text)) {
    await bot.sendMessage(chatId, "Let's submit new details.");
    await startReservationWizard(chatId);
    return true;
  }
  return false;
}

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  rememberManager(msg);
  const chatId = msg.chat.id;
  console.log(`[TG] ${displayName(msg)}: ${msg.text}`);

  try {
    // Manager inventory: "86 redfish" / "un86 redfish" / "86 list" (no slash needed)
    if (await handlePlain86(msg)) return;

    if (await handleReservationSession(msg)) return;
    if (await handleOrderSession(msg)) return;
    if (await handleCancelChange(msg)) return;

    // Multi-part guest questions (party + booth + allergies, etc.) → AI with full history
    // Do NOT short-circuit to the FAQ welcome greeting.
    const partySizeHint = extractPartySize(msg.text);
    const multiPartAsk =
      (partySizeHint != null && partySizeHint > MAX_ONLINE_PARTY) ||
      (/\b(and|,)\b/i.test(msg.text) &&
        /\b(booth|gluten|allerg|patio|fryer|reserv|party|group of|table for)\b/i.test(
          msg.text
        )) ||
      /\b(how big|max party|largest party|party size limit|how many people can|how large|big group|large group|large party)\b/i.test(
        msg.text
      );

    if (multiPartAsk) {
      const aiMulti = await generateAiReply(chatId, msg.text);
      if (aiMulti) {
        await bot.sendMessage(chatId, aiMulti.slice(0, 4000));
        if (partySizeHint != null && partySizeHint > MAX_ONLINE_PARTY) {
          await notifyManagers(
            `📞 TRANSFER TO MANAGER — party of ${partySizeHint} (max ${MAX_ONLINE_PARTY})\nGuest: ${displayName(msg)} (chat ${chatId})\n"${msg.text}"`
          );
        }
        return;
      }
      // Deterministic fallback (never the bare "hi/hey" welcome for real questions)
      const fallback = generateReply(msg.text);
      appendChatMessage(chatId, { role: "model", content: fallback });
      await bot.sendMessage(chatId, fallback);
      if (partySizeHint != null && partySizeHint > MAX_ONLINE_PARTY) {
        await notifyManagers(
          `📞 TRANSFER TO MANAGER — party of ${partySizeHint} (max ${MAX_ONLINE_PARTY})\nGuest: ${displayName(msg)} (chat ${chatId})\n"${msg.text}"`
        );
      }
      return;
    }

    if (wantsToBookReservation(msg.text)) {
      const hints = parseReservationHints(msg.text);
      const size = hints.partySize ?? partySizeHint;
      if (size != null && size > MAX_ONLINE_PARTY) {
        await transferLargeParty(msg, size);
        return;
      }
      await startReservationWizard(chatId, hints, msg);
      return;
    }
    if (ORDER_TRIGGERS.test(msg.text)) {
      await startOrderWizard(chatId);
      return;
    }
    if (SPECIALS_TRIGGERS.test(msg.text)) {
      const ans = await answerSpecialsQuestion(msg.text);
      if (ans.kind === "text" && !/photo|picture|image|pic/i.test(msg.text)) {
        await bot.sendMessage(chatId, ans.text.slice(0, 4000));
        return;
      }
      await sendSpecials(chatId, ans.text);
      return;
    }

    // Menu section lists (appetizers, tacos, sandwiches, entrees…)
    const menuList = answerMenuList(msg.text);
    if (menuList) {
      await bot.sendMessage(chatId, menuList);
      return;
    }

    // Dietary / style guide (fried fish, non-fish + shellfish allergy, etc.)
    // Runs before FAQ so "allergic to shellfish" doesn't only return call-us copy.
    const menuGuide = answerMenuGuide(msg.text);
    if (menuGuide) {
      await bot.sendMessage(chatId, menuGuide);
      return;
    }

    // Availability / 86 demo (trout yes, broccoli sold out, etc.)
    const availability = answerAvailability(msg.text);
    if (availability) {
      await bot.sendMessage(chatId, availability);
      return;
    }

    const hits = findSoldOutMatch(msg.text);
    if (hits.length && /\b(have|got|serve|order|get|do y'?all|out of|sold out)\b/i.test(msg.text)) {
      await bot.sendMessage(
        chatId,
        `We're sold out of ${hits.map((h) => h.name).join(", ")} for the day.\n(Demo 86 board — later this can sync from the restaurant count system.)\nMenu: ${restaurant.menuUrl}`
      );
      return;
    }

    // Conversational AI with FULL message history (not a single prompt)
    const aiReply = await generateAiReply(chatId, msg.text);
    if (aiReply) {
      await bot.sendMessage(chatId, aiReply.slice(0, 4000));
      return;
    }

    // FAQ fallback if Gemini is unavailable.
    // generateAiReply already stored the user turn when it attempted AI.
    let reply = generateReply(msg.text);
    if (getSoldOut().items.length && /\bmenu\b/i.test(msg.text)) {
      reply += `\n\nCurrently 86'd today: ${getSoldOut()
        .items.map((i) => i.name)
        .join(", ")}`;
    }
    appendChatMessage(chatId, { role: "model", content: reply });
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Failed to reply:", err);
    await bot.sendMessage(
      chatId,
      `Sorry — something glitched. Call ${restaurant.phone}.`
    );
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message || err);
});

startBoardRefreshLoop();
