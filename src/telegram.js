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
  return [
    `Reservation ${r.id}`,
    `Status: ${r.status}`,
    `Name: ${r.name}`,
    `Party: ${r.partySize}`,
    `When: ${r.date} ${r.time}`,
    `Phone: ${r.phone}`,
  ].join("\n");
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
    "/86 <item> · /un86 <item> · /86list",
    "/specials · /setspecials <text> · /rereadboard",
    "/reservations · /orders",
    "/clearchat — reset AI conversation memory for this chat",
    "/managerhelp",
    "",
    'Guests: "appetizers", "entrees", "full menu", "today\'s specials", "do y\'all have trout?"',
    "Chalkboard: auto snapshot ~11:00am lunch + ~4:30pm dinner (not live camera).",
    "/rereadboard — new chalkboard photo + full text read",
    "/rereadtext — re-read small ingredient/sides text from saved photo",
    "Demo 86 board = temporary inventory (later: real count system).",
    "AI replies use full chat history (not a single prompt).",
  ].join("\n");
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
  const { items } = getSoldOut();
  await bot.sendMessage(
    msg.chat.id,
    items.length
      ? `86 board:\n${items.map((i) => `• ${i.name} (by ${i.by})`).join("\n")}`
      : "86 board is clear."
  );
});

bot.onText(/^\/86(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  rememberManager(msg);
  const item = match[1].trim();
  addSoldOut(item, displayName(msg));
  await bot.sendMessage(msg.chat.id, `86'd: ${item}`);
  await notifyManagers(`📣 ${displayName(msg)} 86'd: ${item}`);
});

bot.onText(/^\/un86(?:@\w+)?\s+(.+)$/i, async (msg, match) => {
  rememberManager(msg);
  const item = match[1].trim();
  const ok = removeSoldOut(item);
  await bot.sendMessage(
    msg.chat.id,
    ok ? `Back on menu: ${item}` : `Wasn't on 86 board: ${item}`
  );
  if (ok) await notifyManagers(`📣 ${displayName(msg)} restored: ${item}`);
});

bot.onText(/^\/reservations(?:@\w+)?$/i, async (msg) => {
  rememberManager(msg);
  const pending = pendingReservations();
  if (!pending.length) {
    await bot.sendMessage(msg.chat.id, "No pending reservation requests.");
    return;
  }
  for (const r of pending.slice(0, 10)) {
    await bot.sendMessage(msg.chat.id, formatRes(r), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `res:ok:${r.id}` },
            { text: "❌ Decline", callback_data: `res:no:${r.id}` },
          ],
        ],
      },
    });
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
  /\b(reserv|book a table|book(ing)?|party of|table for)\b/i;
const CANCEL_TRIGGERS =
  /\b(cancel (my )?reserv|cancel (my )?booking|cancel table)\b/i;
const CHANGE_TRIGGERS =
  /\b(change (my )?reserv|modify (my )?reserv|reschedule)\b/i;
const ORDER_TRIGGERS =
  /\b(to[- ]?go|takeout|take out|place an order|order food|to go order)\b/i;
const SPECIALS_TRIGGERS =
  /\b(specials?|chalk\s*-?\s*boards?|daily special|specials photo|today'?s special|what'?s on (the )?board)\b/i;

async function startReservationWizard(chatId) {
  setSession(chatId, { type: "reservation", step: "name", data: {} });
  await bot.sendMessage(chatId, "Reservation request — name for the reservation?");
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
  if (step === "name") {
    data.name = text;
    setSession(chatId, { type: "reservation", step: "party", data });
    await bot.sendMessage(chatId, "Party size? (number)");
    return true;
  }
  if (step === "party") {
    const n = parseInt(text.replace(/[^\d]/g, ""), 10);
    if (!n || n < 1 || n > 100) {
      await bot.sendMessage(chatId, "Please send a number, like 2 or 6.");
      return true;
    }
    data.partySize = n;
    data.largeParty = n > MAX_ONLINE_PARTY;
    setSession(chatId, { type: "reservation", step: "date", data });
    if (data.largeParty) {
      await bot.sendMessage(
        chatId,
        `${largePartyAnswer(n)}\n\nI can still take your details here for a manager to review. Date? (ex: Friday, 8/15, tomorrow)\nOr call ${restaurant.phone} anytime to speak with a manager.`
      );
    } else {
      await bot.sendMessage(chatId, "Date? (ex: Friday, 8/15, tomorrow)");
    }
    return true;
  }
  if (step === "date") {
    data.date = text;
    setSession(chatId, { type: "reservation", step: "time", data });
    await bot.sendMessage(chatId, "Time? (ex: 6:30pm)");
    return true;
  }
  if (step === "time") {
    data.time = text;
    setSession(chatId, { type: "reservation", step: "phone", data });
    await bot.sendMessage(chatId, "Callback phone?");
    return true;
  }
  if (step === "phone") {
    data.phone = text;
    setSession(chatId, null);
    const res = saveReservation({
      id: newId("res"),
      status: "pending",
      guestChatId: chatId,
      guestName: displayName(msg),
      ...data,
      createdAt: new Date().toISOString(),
      channel: "telegram",
    });
    const largeNote = data.largeParty
      ? `\n⚠️ Large party (over usual online size of ${MAX_ONLINE_PARTY}) — may accommodate; manager review`
      : "";
    const sent = await notifyManagers(
      `🍽️ NEW reservation${largeNote}\n${formatRes(res)}`,
      {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `res:ok:${res.id}` },
            { text: "❌ Decline", callback_data: `res:no:${res.id}` },
          ],
        ],
      },
    });
    await bot.sendMessage(
      chatId,
      sent
        ? data.largeParty
          ? `Thanks — request sent for ${data.name}, party of ${data.partySize}, ${data.date} ${data.time}. We may be able to accommodate; a manager will follow up here. You’re also welcome to call ${restaurant.phone} to speak with a manager.`
          : `Request sent: ${data.name}, party of ${data.partySize}, ${data.date} ${data.time}. We'll update you here.`
        : `Got it — please also call ${restaurant.phone} (no managers online in bot yet).`
    );
    return true;
  }
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
        return;
      }
      // Deterministic fallback (never the bare "hi/hey" welcome for real questions)
      const fallback =
        partySizeHint != null && partySizeHint > MAX_ONLINE_PARTY
          ? generateReply(msg.text)
          : generateReply(msg.text);
      appendChatMessage(chatId, { role: "model", content: fallback });
      await bot.sendMessage(chatId, fallback);
      return;
    }

    if (RES_TRIGGERS.test(msg.text)) {
      if (partySizeHint != null && partySizeHint > MAX_ONLINE_PARTY) {
        const aiRes = await generateAiReply(chatId, msg.text);
        await bot.sendMessage(
          chatId,
          (aiRes || largePartyAnswer(partySizeHint)).slice(0, 4000)
        );
        return;
      }
      await startReservationWizard(chatId);
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
