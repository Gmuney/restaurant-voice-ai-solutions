import { restaurant } from "./reply.js";
import { getSpecialsText } from "../store.js";
import {
  getBoardReading,
  formatBoardReading,
  readCachedBoard,
  isBoardCacheFresh,
  looksGenericMenuFallback,
  getVerifiedBoardPayload,
} from "../board/read-board.js";
import {
  parseBoardDishes,
  getActiveSpecialsPayload,
  findPayloadDish,
  spokenPayloadDishDetail,
} from "./board-payload.js";

export {
  parseBoardDishes,
  getActiveSpecialsPayload,
  findPayloadDish,
  spokenPayloadDishDetail,
};

function listSpokenItems(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function featuredDishPhrase(dishes, lang = "en") {
  const list = (Array.isArray(dishes) ? dishes : [])
    .filter((d) => d?.name && d?.price)
    .slice(0, 3);
  return list.map((d, i) => {
    if (lang === "es") {
      return i === 0 ? `el ${d.name} por $${d.price}` : `${d.name} por $${d.price}`;
    }
    return i === 0 ? `the ${d.name} for $${d.price}` : `${d.name} for $${d.price}`;
  });
}

/**
 * Voice readout bound to active_specials_payload dishes only (2–3 featured).
 * Landline — never mention photos or everyday-menu fillers.
 */
export function spokenSpecialsReadout(dishes, lang = "en") {
  const items = featuredDishPhrase(dishes, lang);
  const followUp =
    lang === "es"
      ? "¿Quiere que le cuente más sobre alguno de esos?"
      : "Would you like me to tell you more about any of those?";
  if (!items.length) {
    return lang === "es"
      ? "Los especiales del pizarrón cambian diario. ¿Quiere que le revise algún otro platillo del menú?"
      : "Our chalkboard specials change daily. Would you like me to check on any other menu items for you?";
  }
  if (lang === "es") {
    return `Nuestros especiales del pizarrón incluyen ${listSpokenItems(items)}. ${followUp}`;
  }
  return `Our chalkboard specials feature ${listSpokenItems(items)}. ${followUp}`;
}

/** Same payload-bound script (after-hours / unreadable OCR still speak the JSON). */
export function spokenUpdatingBoardReadout(dishes, lang = "en") {
  return spokenSpecialsReadout(dishes, lang);
}

export function guestSpecialsSpeech(board, lang = "en") {
  const payload = getActiveSpecialsPayload(board);
  const dishes = payload?.dishes || [];
  return {
    mode: dishes.length ? "payload" : "empty",
    text: spokenSpecialsReadout(dishes, lang),
    payload,
  };
}

export function boardSpecialsReadout(boardText, lang = "en", board = null) {
  if (board) return guestSpecialsSpeech(board, lang).text;
  return spokenSpecialsReadout(parseBoardDishes(boardText), lang);
}

function payloadSourceText(board, payload) {
  const verified = getVerifiedBoardPayload(board);
  if (verified?.text && !looksGenericMenuFallback(verified.text)) return verified.text;
  return (payload?.dishes || [])
    .map((d) => {
      const bits = [d.toppings, d.sides].filter(Boolean).join("; ");
      return `${d.name} — $${d.price}${bits ? `\n  ${bits}` : ""}`;
    })
    .join("\n");
}

function askedGenericMissingFromPayload(query, payload) {
  const q = String(query || "").toLowerCase();
  const names = (payload?.dishes || []).map((d) => d.name.toLowerCase());
  const probes = [
    ["fish tacos", /\bfish\s+tacos?\b/i],
    ["shrimp tacos", /\bshrimp\s+tacos?\b/i],
    ["crab cakes", /\bcrab\s+cakes?\b/i],
  ];
  return probes.some(
    ([label, re]) => re.test(q) && !names.some((n) => n.includes(label))
  );
}

/** Pull a dish block (name + following small ingredient/sides lines) from payload-bound text. */
function extractDishBlock(boardText, query, payload) {
  if (!boardText) return null;
  if (askedGenericMissingFromPayload(query, payload)) return null;
  const lines = boardText.split(/\n/).map((l) => l.trimEnd());
  const words = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          "what",
          "about",
          "special",
          "specials",
          "chalkboard",
          "today",
          "todays",
          "have",
          "tell",
          "ingredients",
          "describe",
          "description",
        ].includes(w)
    );
  if (!words.length) return null;

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const score = words.reduce((s, w) => (lower.includes(w) ? s + w.length : s), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 4) return null;

  const heading = lines[bestIdx].trim();
  const onPayload = (payload?.dishes || []).some((d) =>
    heading.toLowerCase().includes(d.name.toLowerCase())
  );
  if (payload?.dishes?.length && !onPayload) return null;
  if (looksGenericMenuFallback(heading)) return null;

  const block = [lines[bestIdx]];
  for (let j = bestIdx + 1; j < lines.length && j < bestIdx + 5; j++) {
    const line = lines[j];
    if (!line.trim()) break;
    if (/\$?\d{2,3}\b/.test(line) && !/^\s/.test(line) && j > bestIdx) break;
    if (/^[A-Z][A-Za-z].{8,}/.test(line) && /\$?\d{2}/.test(line) && j > bestIdx) break;
    block.push(line);
  }
  return block.join("\n").trim();
}

export function specialsImageUrl() {
  return `${restaurant.dailySpecialsImageUrl}?t=${Date.now()}`;
}

export function specialsCaption() {
  const saved = getSpecialsText();
  const board = readCachedBoard();
  const lines = [
    `Chalkboard specials — ${restaurant.name}`,
    board?.boardWindow?.label || "Scheduled board snapshot",
  ];
  const spoken = guestSpecialsSpeech(board).text;
  if (spoken) lines.push("", spoken);
  if (saved.text) {
    lines.push("", "Manager notes:", saved.text);
  }
  return lines.join("\n");
}

export async function answerSpecialsQuestion(question, opts = {}) {
  const saved = getSpecialsText();
  const q = String(question || "").toLowerCase();
  const lang = opts.language === "es" ? "es" : "en";

  const board = await getBoardReading({ force: false, forceAwait: false });
  const managerText = saved.text || "";
  const speech = guestSpecialsSpeech(board, lang);
  const payload = speech.payload || getActiveSpecialsPayload(board);
  const named = findPayloadDish(q, payload);
  if (named) {
    return {
      kind: "text",
      text: spokenPayloadDishDetail(named, lang, q),
      board,
      needsRefreshFollowUp: false,
    };
  }
  const sourceText = payloadSourceText(board, payload);
  const combined = `${sourceText}\n${(payload?.dishes || [])
    .map((d) => d.name)
    .join("\n")}`.toLowerCase();

  const words = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          "what",
          "todays",
          "today",
          "special",
          "specials",
          "chalkboard",
          "chalk",
          "board",
          "daily",
          "have",
          "about",
          "your",
          "whats",
        ].includes(w)
    );

  const hits = words.filter((w) => combined.includes(w));
  const dishBlock = extractDishBlock(sourceText, q, payload);
  const askingOneDish =
    dishBlock &&
    (hits.length ||
      /\b(ingredient|side|describe|about|what'?s in|come with)\b/i.test(q));

  if (askingOneDish) {
    return {
      kind: "text",
      text: [`From today's chalkboard:`, "", dishBlock].join("\n"),
      board,
      needsRefreshFollowUp: false,
    };
  }

  if (askedGenericMissingFromPayload(q, payload) || (hits.length && !dishBlock && words.length)) {
    const missing = hits.length ? hits.join(", ") : "that";
    return {
      kind: "text",
      text: `I don't see "${missing}" written on today's chalkboard. ${speech.text}`,
      board,
      needsRefreshFollowUp: false,
    };
  }

  return {
    kind: "text",
    text: managerText ? `${speech.text}\n\nManager notes:\n${managerText}` : speech.text,
    board,
    needsRefreshFollowUp: false,
    stale: !isBoardCacheFresh(board),
  };
}

export { getBoardReading, formatBoardReading, readCachedBoard };
