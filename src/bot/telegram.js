import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  generateReply,
  restaurant,
  extractPartySize,
  largePartyAnswer,
  composeMultiPartReply,
  composeEscalationReply,
  needsManagerEscalation,
  happyHourAnswer,
  hoursAnswer,
  asksHours,
  hoursReplyLanguage,
  asksHappyHour,
  asksKidsMeal,
  kidsMealReply,
  answerPastSpecialOrCustomMod,
  isLargeOnlineParty,
  MAX_ONLINE_PARTY,
} from "../engine/reply.js";
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
  getChatLang,
  setChatLang,
} from "../store.js";
import {
  specialsImageUrl,
  specialsCaption,
  answerSpecialsQuestion,
  formatBoardReading,
  readCachedBoard,
} from "../engine/specials.js";
import {
  startBoardRefreshLoop,
  loadSnapshotImageBuffer,
  refreshBoardReading as rereadBoardSnapshot,
} from "../board/read-board.js";
import {
  answerAvailability,
  answerMenuList,
  answerMenuGuide,
  findMenuItem,
} from "../engine/menu-check.js";
import { generateAiReply, translateToSpanish } from "../ai/chat.js";
import {
  resolveGuestLanguage,
  ES,
  seatingLabel,
  cleanGuestText,
  isPureGreeting,
} from "../engine/language.js";

function chatLanguage(chatId, text) {
  return resolveGuestLanguage(chatId, text, {
    getLang: getChatLang,
    setLang: setChatLang,
  });
}

/** English replies stay English; Spanish guests get Spanish (AI or translated FAQ). */
async function sendGuest(chatId, text, lang = "en") {
  let out = String(text || "");
  if (lang === "es") out = await translateToSpanish(out);
  await bot.sendMessage(chatId, out.slice(0, 4000));
  return out;
}

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
    "  After 86: bot asks if you want a restock order (YES → qty + notes).",
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
  const label = `${item}${detail}`;
  await bot.sendMessage(
    msg.chat.id,
    `86'd: ${label}\nGuests will hear we're sold out.`
  );
  await notifyManagers(`📣 ${displayName(msg)} 86'd: ${label}`);

  // Ask manager if they want to place a restock / vendor order ASAP
  setSession(msg.chat.id, {
    type: "restock",
    step: "ask",
    data: {
      item,
      label,
      by: displayName(msg),
      managerChatId: msg.chat.id,
    },
  });
  await bot.sendMessage(
    msg.chat.id,
    `Want to place a restock order for ${label} so we can receive it ASAP and restock for guest orders?\n\nReply YES to start a restock request, or NO to skip.`
  );
}

function formatRestock(r) {
  return [
    `Restock request ${r.id}`,
    `Item: ${r.label || r.item}`,
    `Qty: ${r.qty}`,
    r.notes ? `Notes: ${r.notes}` : null,
    `Requested by: ${r.by}`,
    "Goal: receive ASAP and restock for orders",
  ]
    .filter(Boolean)
    .join("\n");
}

/** After 86: YES → qty → notes → notify managers; NO → skip. */
async function handleRestockSession(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.type !== "restock") return false;

  const text = String(msg.text || "").trim();
  if (/^(cancel|stop|nevermind|nope)$/i.test(text)) {
    setSession(chatId, null);
    await bot.sendMessage(
      chatId,
      "Restock request cancelled. Item stays 86'd until you un86 it."
    );
    return true;
  }

  const { step, data } = session;

  if (step === "ask") {
    if (/^(y|yes|yeah|yep|sure|ok|okay)$/i.test(text)) {
      setSession(chatId, { type: "restock", step: "qty", data });
      await bot.sendMessage(
        chatId,
        `How much ${data.label || data.item} should we order?\n(e.g. "2 cases", "1 box", "10 lb", "1 each")`
      );
      return true;
    }
    if (/^(n|no|nah|skip)$/i.test(text)) {
      setSession(chatId, null);
      await bot.sendMessage(
        chatId,
        "Got it — no restock request. Item stays 86'd. You can un86 when stock arrives."
      );
      return true;
    }
    await bot.sendMessage(
      chatId,
      "Please reply YES to place a restock order, or NO to skip."
    );
    return true;
  }

  if (step === "qty") {
    data.qty = text;
    setSession(chatId, { type: "restock", step: "notes", data });
    await bot.sendMessage(
      chatId,
      'Any notes for the restock? (vendor, urgency, delivery window)\nOr type "none".'
    );
    return true;
  }

  if (step === "notes") {
    data.notes = /^(none|n\/a|na|-)$/i.test(text) ? "" : text;
    setSession(chatId, null);
    const restock = {
      id: newId("rst"),
      item: data.item,
      label: data.label,
      qty: data.qty,
      notes: data.notes,
      by: data.by || displayName(msg),
      status: "requested",
      createdAt: new Date().toISOString(),
    };
    const body = formatRestock(restock);
    await bot.sendMessage(
      chatId,
      `Restock request sent to managers:\n\n${body}`
    );
    await notifyManagers(
      `📦 RESTOCK REQUEST (after 86)\n${body}\n\nPlace vendor order ASAP so we can restock for guest orders.`
    );
    return true;
  }

  return false;
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
    const { reocrSnapshot } = await import("../board/read-board.js");
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
  /\b(i wanted to make a reserv|want(ed)? to (make a )?reserv|make a reserv|book a table|book(ing)?\b.{0,20}\btable|party of\s*\d|table for\s*\d|\breservation\b|reservaci[oó]n|quiero reservar|quisiera reservar|reservar (una )?mesa|mesa para\s*\d)\b/i;

/** Start booking flow — not pure FAQ like "do you take reservations?" */
function wantsToBookReservation(text) {
  const t = String(text || "");
  const infoOnly =
    /\b(do you (take|accept)|can i|taking|accept|aceptan|toman)\b.{0,24}\breserv/i.test(
      t
    ) &&
    !/\b(for\s*\d|para\s*\d|today|tomorrow|hoy|ma[nñ]ana|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i.test(
      t
    );
  if (infoOnly) return false;
  return RES_TRIGGERS.test(t);
}
const CANCEL_TRIGGERS =
  /\b(cancel (my )?reserv|cancel (my )?booking|cancel table|cancelar (mi )?reserv)/i;
const CHANGE_TRIGGERS =
  /\b(change (my )?reserv|modify (my )?reserv|reschedule|cambiar (mi )?reserv|reprogramar)\b/i;
const ORDER_TRIGGERS =
  /\b(to[- ]?go|takeout|take out|place an order|order food|to go order|para llevar|orden para llevar|quiero ordenar)\b/i;
const SPECIALS_TRIGGERS =
  /\b(specials?|chalk\s*-?\s*boards?|daily special|specials photo|today'?s special|what'?s on (the )?board|especiales|especiales de hoy|pizarra)\b/i;

function wantsChalkboardSpecials(text) {
  const t = String(text || "");
  if (asksHappyHour(t) && !/\b(chalk\s*-?\s*board|pizarra|daily special|especiales de hoy)\b/i.test(t)) {
    return false;
  }
  // Past specials / named prior board dishes → past-special handler, not today's board photo
  if (
    /\bpontchartrain\b/i.test(t) ||
    /\b(past|previous|last week'?s?|other day|other night)\b.{0,40}\bspecials?\b/i.test(t)
  ) {
    return false;
  }
  return SPECIALS_TRIGGERS.test(t);
}

function isSideSwapLike(text) {
  const t = String(text || "");
  return (
    /\b(change|swap|switch|substitut|replace).{0,40}\bsides?\b|\bsides?\b.{0,40}\b(change|swap|switch|substitut|replace)\b/i.test(
      t
    ) ||
    (/\b(cambiar|cambiamos|cambien|cambio|sustituir)\b/i.test(t) &&
      /\b(papas?|fries|ensalada|salad|sides?|guarnici)/i.test(t))
  );
}

function asksGlutenLike(text) {
  return /\b(gluten|celiac|cel[ií]aco|sin gluten|fryer|freidora|empanizado)\b/i.test(
    text
  );
}

function parseReservationHints(text) {
  const t = String(text || "");
  const partySize =
    extractPartySize(t) ||
    (() => {
      const m = t.match(/\b(?:mesa para|para)\s*(\d{1,2})\b/i);
      return m ? Number(m[1]) : null;
    })();
  const timeM = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i);
  let date = null;
  if (/\b(today|hoy)\b/i.test(t)) date = /\bhoy\b/i.test(t) ? "hoy" : "today";
  else if (/\b(tomorrow|ma[nñ]ana)\b/i.test(t))
    date = /\bma[nñ]ana\b/i.test(t) ? "mañana" : "tomorrow";
  else {
    const d = t.match(
      /\b((?:mon|tues|wednes|thurs|fri|satur|sun)day|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i
    );
    if (d) date = d[1];
  }
  let seating = null;
  if (/\bpatio\b/i.test(t)) seating = "patio";
  else if (/\bbooth\b/i.test(t) || /\bcabina\b/i.test(t)) seating = "booth";
  else if (
    /\b(table|mesa)\b/i.test(t) &&
    !/\b(table for|mesa para)\b/i.test(t)
  ) {
    seating = "table";
  }
  return {
    partySize: partySize || null,
    time: timeM ? timeM[1].replace(/\s+/g, "").toLowerCase() : null,
    date,
    seating,
  };
}

function parseAdultsKids(text) {
  const t = String(text || "").trim();
  const adultsM = t.match(/(\d+)\s*adultos?/i) || t.match(/(\d+)\s*adults?/i);
  const kidsM =
    t.match(/(\d+)\s*(?:ni[nñ]os?|niñas?|children|child|kids?)\b/i);
  if (adultsM || kidsM) {
    return {
      adults: adultsM ? Number(adultsM[1]) : 0,
      kids: kidsM ? Number(kidsM[1]) : 0,
    };
  }
  const pair = t.match(/^(\d+)\s*(?:and|&|\/|,|y)\s*(\d+)\s*$/i);
  if (pair) return { adults: Number(pair[1]), kids: Number(pair[2]) };
  if (/^(all\s+)?adults?\s*$/i.test(t) || /^solo adultos?\s*$/i.test(t))
    return null;
  return null;
}

function parseSeatingChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/\bpatio\b/.test(t)) return "patio";
  if (/\bbooth\b/.test(t) || /\bcabina\b/.test(t)) return "booth";
  if (/\btable\b/.test(t) || /\bmesa\b/.test(t)) return "table";
  return null;
}

async function transferLargeParty(msg, n) {
  await escalateToManagers(msg, {
    reason: "large_party",
    partySize: n,
  });
}

/**
 * Dual-intent manager transfer — one guest message only:
 * 1. [Standard answer] (menu/allergen + safety)
 * 2. [Handoff stay-on-the-line line]
 * 3. 🚨 PHONE RINGING: Transferring guest to Manager... (VERY END)
 * No separate standalone PHONE RINGING message before the reply.
 */
async function escalateToManagers(msg, meta = {}) {
  const chatId = msg.chat.id;
  const lang = getChatLang(chatId) || "en";
  const partySize =
    meta.partySize ?? extractPartySize(msg.text) ?? null;

  setSession(chatId, null);
  const reply = composeEscalationReply(msg.text, {
    language: lang,
    partySize,
  });
  appendChatMessage(chatId, { role: "user", content: msg.text });
  appendChatMessage(chatId, { role: "model", content: reply });
  await bot.sendMessage(chatId, reply.slice(0, 4000));

  // Managers get the same single transfer block once (not a prior standalone ringing ping)
  const managerIds = listManagerIds().map(String);
  if (!managerIds.includes(String(chatId))) {
    await notifyManagers(reply.slice(0, 4000));
  }
  return true;
}

function nextReservationPrompt(data, lang = "en") {
  if (lang === "es") {
    if (data.adults == null || data.kids == null) {
      if (data.partySize) {
        return ES.adultsKidsWithParty(data.partySize, data.date, data.time);
      }
      return ES.adultsKids;
    }
    if (!data.date) return ES.date;
    if (!data.time) return ES.time;
    if (!data.seating) return ES.seating;
    if (!data.name) return ES.name;
    return null;
  }
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
  const lang = getChatLang(chatId) || "en";
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
  if (lang === "es") {
    await bot.sendMessage(
      chatId,
      ES.confirmed(
        name,
        adults,
        kids,
        partySize,
        data.date,
        data.time,
        seatingLabel(data.seating, "es"),
        res.id
      )
    );
    return;
  }
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
  const lang = getChatLang(chatId) || "en";
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
  const prompt = nextReservationPrompt(data, lang);
  const note =
    lang === "es"
      ? ES.resDemoNote
      : "(Demo reservation — I'll confirm with you here. Type cancel to stop.)";
  await bot.sendMessage(chatId, `${prompt}\n\n${note}`);
}

async function startOrderWizard(chatId) {
  const lang = getChatLang(chatId) || "en";
  setSession(chatId, { type: "order", step: "name", data: {} });
  await bot.sendMessage(
    chatId,
    lang === "es"
      ? ES.orderStart(restaurant.orderOnlineUrl)
      : `To-go order — name for the order?\n(Or order online: ${restaurant.orderOnlineUrl})\nType cancel to stop.`
  );
}

const RESET_ACK =
  "Entendido / Got it — conversation reset. How can Fish City Grill help you?";

/** Explicit end/reset commands. */
function isExplicitReset(text) {
  return /^(end|reset|restart|start over|stop|cancel|nevermind|reiniciar|terminar|fin|olvidalo|olvídalo|cancelar todo)([.!?]*)?$/i.test(
    String(text || "").trim()
  );
}

/**
 * While a wizard is open, a new generic Q (hours/menu/etc.) that isn't answering
 * the current step abandons the uncompleted flow.
 */
function isUnrelatedGenericDuringFlow(text, session) {
  if (!session?.type) return false;
  const t = String(text || "").trim();
  if (!t) return false;

  // Still answering the wizard — keep the flow
  if (session.type === "reservation") {
    const step = session.step;
    if (step === "adults_kids" && parseAdultsKids(t)) return false;
    if (step === "seating" && parseSeatingChoice(t)) return false;
    if (step === "date" && /^(today|tomorrow|hoy|ma[nñ]ana|\d{1,2}\/\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i.test(t))
      return false;
    if (step === "time" && /\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?|\b(noon|midnight|mediod[ií]a)\b/i.test(t))
      return false;
    if (step === "name" && t.length <= 60 && !/\?/.test(t) && !isGenericTopicQuestion(t))
      return false;
  }
  if (session.type === "order") {
    // Short answers for name/phone/pickup/items/notes are expected
    if (!isGenericTopicQuestion(t) && t.length < 120 && !/\?/.test(t)) return false;
  }
  if (session.type === "restock") {
    if (/^(y|yes|yeah|yep|sure|ok|okay|n|no|nah|skip|none)$/i.test(t)) return false;
    if (session.step === "qty" || session.step === "notes") {
      if (!isGenericTopicQuestion(t) && !/\?/.test(t)) return false;
    }
  }

  return isGenericTopicQuestion(t) || isPureGreeting(t);
}

function isGenericTopicQuestion(text) {
  const t = String(text || "");
  return (
    /\b(hours?|open|closed|horario|menu|specials?|parking|happy\s*hour|allerg|gluten|dairy|patio|address|direcci[oó]n|phone|tel[eé]fono|what time|do you (have|serve)|tienen|estacionamiento|especiales)\b/i.test(
      t
    ) ||
    /\?/.test(t) ||
    isPureGreeting(t)
  );
}

async function resetGuestConversation(chatId, msg) {
  setSession(chatId, null);
  clearChatMessages(chatId);
  appendChatMessage(chatId, { role: "user", content: msg?.text || "reset" });
  appendChatMessage(chatId, { role: "model", content: RESET_ACK });
  await bot.sendMessage(chatId, RESET_ACK);
  console.log(`[TG] conversation reset for chat ${chatId}`);
  return true;
}

async function handleSessionReset(msg) {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  const session = getSession(chatId);

  // Hours intent must bypass reset ack and hit the HOURS handler
  if (asksHours(text)) return false;

  if (isExplicitReset(text)) {
    await resetGuestConversation(chatId, msg);
    return true;
  }

  if (
    session &&
    ["reservation", "order", "restock"].includes(session.type) &&
    isUnrelatedGenericDuringFlow(text, session)
  ) {
    await resetGuestConversation(chatId, msg);
    return true;
  }

  return false;
}

async function handleReservationSession(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.type !== "reservation") return false;
  const text = msg.text.trim();
  const lang = chatLanguage(chatId, text);
  if (/^(cancel|stop|nevermind|cancelar|detener)$/i.test(text)) {
    setSession(chatId, null);
    await bot.sendMessage(
      chatId,
      lang === "es" ? ES.resCancel : "Reservation request cancelled."
    );
    return true;
  }
  const { step, data } = session;

  if (step === "adults_kids") {
    const parsed = parseAdultsKids(text);
    if (!parsed) {
      await bot.sendMessage(
        chatId,
        lang === "es"
          ? ES.adultsKidsRetry
          : "Please send adults and kids, like: 3 adults, 1 kid"
      );
      return true;
    }
    const total = parsed.adults + parsed.kids;
    if (total < 1) {
      await bot.sendMessage(
        chatId,
        lang === "es" ? ES.needOneGuest : "Need at least 1 guest — try again?"
      );
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
        lang === "es" ? ES.seatingRetry : "Please choose one: booth, table, or patio"
      );
      return true;
    }
    data.seating = seat;
  } else if (step === "name") {
    data.name = text;
  } else {
    await bot.sendMessage(
      chatId,
      nextReservationPrompt(data, lang) ||
        (lang === "es" ? "Un momento…" : "One moment…")
    );
    return true;
  }

  const next = reservationStepFor(data);
  if (next === "done") {
    await finalizeDemoReservation(msg, data);
    return true;
  }
  setSession(chatId, { type: "reservation", step: next, data });
  await bot.sendMessage(chatId, nextReservationPrompt(data, lang));
  return true;
}

async function handleOrderSession(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (!session || session.type !== "order") return false;
  const text = msg.text.trim();
  const lang = chatLanguage(chatId, text);
  if (/^(cancel|stop|nevermind|cancelar|detener)$/i.test(text)) {
    setSession(chatId, null);
    await bot.sendMessage(
      chatId,
      lang === "es" ? ES.orderCancel : "To-go order cancelled."
    );
    return true;
  }
  const { step, data } = session;
  if (step === "name") {
    data.name = text;
    setSession(chatId, { type: "order", step: "phone", data });
    await bot.sendMessage(chatId, lang === "es" ? ES.orderPhone : "Phone?");
    return true;
  }
  if (step === "phone") {
    data.phone = text;
    setSession(chatId, { type: "order", step: "pickup", data });
    await bot.sendMessage(
      chatId,
      lang === "es" ? ES.orderPickup : "Pickup time? (30 min, 6:15pm, ASAP)"
    );
    return true;
  }
  if (step === "pickup") {
    data.pickupTime = text;
    setSession(chatId, { type: "order", step: "items", data });
    await bot.sendMessage(
      chatId,
      lang === "es" ? ES.orderItems : "Items + quantities?"
    );
    return true;
  }
  if (step === "items") {
    data.items = text;
    const hits = findSoldOutMatch(text);
    if (hits.length) {
      await bot.sendMessage(
        chatId,
        lang === "es"
          ? `Aviso: puede estar 86'd: ${hits.map((h) => h.name).join(", ")}`
          : `Heads-up, may be 86'd: ${hits.map((h) => h.name).join(", ")}`
      );
    }
    setSession(chatId, { type: "order", step: "notes", data });
    await bot.sendMessage(
      chatId,
      lang === "es" ? ES.orderNotes : 'Notes? Or type "none".'
    );
    return true;
  }
  if (step === "notes") {
    data.notes = /^(none|ninguna|ninguno)$/i.test(text) ? "" : text;
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
        ? lang === "es"
          ? ES.orderSent(data.name, data.pickupTime)
          : `To-go request sent under ${data.name}. Pickup: ${data.pickupTime}.`
        : lang === "es"
          ? `Por favor llama al ${restaurant.phone} o usa ${restaurant.orderOnlineUrl}`
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
  msg.text = cleanGuestText(msg.text);
  if (!msg.text) return;
  const lang = chatLanguage(chatId, msg.text);
  console.log(`[TG] ${displayName(msg)} [${lang}]: ${msg.text}`);

  try {
    // State reset: "end" / "reset" or abandon incomplete flow with a new generic question
    if (await handleSessionReset(msg)) return;

    // Restock follow-up after 86 (YES/NO → qty → notes)
    if (await handleRestockSession(msg)) return;

    // Manager inventory: "86 redfish" / "un86 redfish" / "86 list" (no slash needed)
    if (await handlePlain86(msg)) return;

    // Spanish/English HOURS intent — bypass wizards, multipart, AI, and help/options menu
    if (asksHours(msg.text) && !needsManagerEscalation(msg.text)) {
      setSession(chatId, null);
      const hoursLang = hoursReplyLanguage(msg.text, lang);
      setChatLang(chatId, hoursLang);
      const hoursReply = hoursAnswer(hoursLang);
      appendChatMessage(chatId, { role: "user", content: msg.text });
      appendChatMessage(chatId, { role: "model", content: hoursReply });
      console.log(`[TG] HOURS intent → ${hoursLang}`);
      await bot.sendMessage(chatId, hoursReply.slice(0, 4000));
      return;
    }

    // Kids menu: exactly ONE side; don't volunteer 86'd sides
    if (asksKidsMeal(msg.text) && !needsManagerEscalation(msg.text)) {
      const kidsReply = kidsMealReply(msg.text, lang);
      appendChatMessage(chatId, { role: "user", content: msg.text });
      appendChatMessage(chatId, { role: "model", content: kidsReply });
      console.log(`[TG] KIDS meal/sides intent → ${lang}`);
      await bot.sendMessage(chatId, kidsReply.slice(0, 4000));
      return;
    }

    if (await handleReservationSession(msg)) return;
    if (await handleOrderSession(msg)) return;
    if (await handleCancelChange(msg)) return;

    // Escalation: party of 8+ (incl. 25+) OR explicit manager/owner ask → alert managers immediately
    if (needsManagerEscalation(msg.text)) {
      await escalateToManagers(msg);
      return;
    }

    // Greeting switches language instantly: "Hola" → Spanish, "Hi/Hey/Hello" → English
    if (isPureGreeting(msg.text)) {
      const welcome = generateReply(msg.text, { language: lang });
      appendChatMessage(chatId, { role: "user", content: msg.text });
      appendChatMessage(chatId, { role: "model", content: welcome });
      console.log(`[TG] language switch → ${lang} (greeting)`);
      await bot.sendMessage(chatId, welcome);
      return;
    }

    // Multi-part guest questions (party + sides + gluten/fryer, etc.)
    // Prefer structured compose so Spanish answers don't hang on AI timeout.
    // (Large-party / manager asks already handled by escalateToManagers above.)
    const partySizeHint = extractPartySize(msg.text);
    const multiPartAsk =
      (/\b(and|,|y|también|tambien)\b/i.test(msg.text) &&
        /\b(booth|gluten|allerg|patio|fryer|freidora|reserv|party|group of|table for|mesa|ni[nñ]os?|sides?|papas?|ensalada|cambiar)\b/i.test(
          msg.text
        )) ||
      /\b(how big|max party|largest party|party size limit|how many people can|how large|big group|large group|large party|grupo grande|cu[aá]ntas personas)\b/i.test(
        msg.text
      ) ||
      (isSideSwapLike(msg.text) &&
        (asksGlutenLike(msg.text) || partySizeHint != null));

    if (multiPartAsk) {
      const structured = composeMultiPartReply(msg.text, { language: lang });
      if (structured) {
        appendChatMessage(chatId, { role: "user", content: msg.text });
        appendChatMessage(chatId, { role: "model", content: structured });
        await bot.sendMessage(chatId, structured.slice(0, 4000));
        return;
      }
      const aiMulti = await generateAiReply(chatId, msg.text, { language: lang });
      if (aiMulti) {
        await bot.sendMessage(chatId, aiMulti.slice(0, 4000));
        return;
      }
      const fallback = generateReply(msg.text, { language: lang });
      const localized = lang === "es" ? await translateToSpanish(fallback) : fallback;
      appendChatMessage(chatId, { role: "model", content: localized });
      await bot.sendMessage(chatId, localized);
      return;
    }

    if (asksHappyHour(msg.text)) {
      const hh = happyHourAnswer(lang);
      appendChatMessage(chatId, { role: "user", content: msg.text });
      appendChatMessage(chatId, { role: "model", content: hh });
      await bot.sendMessage(chatId, hh);
      return;
    }

    // Past chalkboard specials / custom builds (e.g. Redfish Pontchartrain)
    const pastSpecialReply = answerPastSpecialOrCustomMod(msg.text, {
      language: lang,
    });
    if (pastSpecialReply) {
      appendChatMessage(chatId, { role: "user", content: msg.text });
      appendChatMessage(chatId, { role: "model", content: pastSpecialReply });
      await bot.sendMessage(chatId, pastSpecialReply.slice(0, 4000));
      return;
    }

    if (wantsToBookReservation(msg.text)) {
      const hints = parseReservationHints(msg.text);
      const size = hints.partySize ?? extractPartySize(msg.text);
      if (size != null && isLargeOnlineParty(size)) {
        await escalateToManagers(msg, { reason: "large_party", partySize: size });
        return;
      }
      await startReservationWizard(chatId, hints, msg);
      return;
    }
    if (ORDER_TRIGGERS.test(msg.text)) {
      await startOrderWizard(chatId);
      return;
    }
    if (wantsChalkboardSpecials(msg.text)) {
      const ans = await answerSpecialsQuestion(msg.text);
      if (ans.kind === "text" && !/photo|picture|image|pic|foto\b/i.test(msg.text)) {
        await sendGuest(chatId, ans.text, lang);
        return;
      }
      await sendSpecials(chatId, ans.text);
      return;
    }

    // Menu section lists (appetizers, tacos, sandwiches, entrees…)
    const menuList = answerMenuList(msg.text);
    if (menuList) {
      await sendGuest(chatId, menuList, lang);
      return;
    }

    // Dietary / style guide (fried fish, non-fish + shellfish allergy, etc.)
    // Runs before FAQ so "allergic to shellfish" doesn't only return call-us copy.
    const menuGuide = answerMenuGuide(msg.text);
    if (menuGuide) {
      await sendGuest(chatId, menuGuide, lang);
      return;
    }

    // Availability / 86 demo (trout yes, broccoli sold out, etc.)
    const availability = answerAvailability(msg.text);
    if (availability) {
      await sendGuest(chatId, availability, lang);
      return;
    }

    const hits = findSoldOutMatch(msg.text);
    if (
      hits.length &&
      /\b(have|got|serve|order|get|do y'?all|out of|sold out|tienen|hay|agotad)/i.test(
        msg.text
      )
    ) {
      const soldMsg =
        lang === "es"
          ? ES.soldOut(hits.map((h) => h.name).join(", "), restaurant.menuUrl)
          : `We're sold out of ${hits.map((h) => h.name).join(", ")} for the day.\n(Demo 86 board — later this can sync from the restaurant count system.)\nMenu: ${restaurant.menuUrl}`;
      await bot.sendMessage(chatId, soldMsg);
      return;
    }

    // Conversational AI with FULL message history (not a single prompt)
    const aiReply = await generateAiReply(chatId, msg.text, { language: lang });
    if (aiReply) {
      await bot.sendMessage(chatId, aiReply.slice(0, 4000));
      return;
    }

    // FAQ fallback if Gemini is unavailable.
    // generateAiReply already stored the user turn when it attempted AI.
    let reply = generateReply(msg.text, { language: lang });
    if (getSoldOut().items.length && /\b(menu|men[uú])\b/i.test(msg.text) && !asksKidsMeal(msg.text)) {
      reply += `\n\nCurrently 86'd today: ${getSoldOut()
        .items.map((i) => i.name)
        .join(", ")}`;
    }
    if (lang === "es") reply = await translateToSpanish(reply);
    appendChatMessage(chatId, { role: "model", content: reply });
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Failed to reply:", err);
    await bot.sendMessage(
      chatId,
      lang === "es"
        ? ES.glitch(restaurant.phone)
        : `Sorry — something glitched. Call ${restaurant.phone}.`
    );
  }
});

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message || err);
});

startBoardRefreshLoop();
