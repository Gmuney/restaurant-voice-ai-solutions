import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_DIR } from "../paths.js";

/** Everyday-menu guesses the OCR model uses when chalk is hard to read. */
const GENERIC_MENU_FALLBACK =
  /\blobster\s*rolls?|angel\s*hair(\s*pasta)?|chicken\s*alfredo|fettuccine\s*alfredo|caesar\s*salad|pulled pork|chicken fajitas|chicken tenders|loaded fries|bbq ribs|ribeye steak|burger\s*&\s*fries|shrimp po'? ?boy|bbq pulled pork|poker shrimp|fish tasty|hushpuppy|polo shrimp|cevich|angelhauser|big fish platter|seafood shack|coconut rice,\s*grilled asparagus|\bfish\s+tacos?\b|\bshrimp\s+tacos?\b|\bcrab\s+cakes?\b|\bcrab\s+cake\s+sandwich|\bsteak\s+fries\b|\bchicken\s+fries\b/i;

const SEED_FILE = join(KNOWLEDGE_DIR, "active-specials.json");

export function looksGenericMenuFallback(text) {
  return GENERIC_MENU_FALLBACK.test(String(text || ""));
}

export function isGenericBoardDishName(name) {
  return looksGenericMenuFallback(String(name || ""));
}

/** Dish name + price lines copied from chalkboard OCR — never everyday-menu filler. */
export function parseBoardDishes(boardText) {
  const dishes = [];
  const seen = new Set();
  for (const raw of String(boardText || "").split(/\n/)) {
    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    if (!line) continue;
    if (/^drinks?\b/i.test(line)) break;
    if (indented && !/\$\d{2,3}\b/.test(line)) continue;
    const m =
      line.match(/^[-•*]?\s*(.+?)\s*[—–\-:]+\s*\$?\s*(\d{2,3})\b/) ||
      line.match(/^[-•*]?\s*(.+?)\s+\$\s*(\d{2,3})\b/);
    if (!m) continue;
    let name = m[1].replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
    name = name.replace(/^the\s+/i, "");
    if (name.length < 4) continue;
    if (/\[unclear\]/i.test(name)) continue;
    if (looksGenericMenuFallback(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dishes.push({ name, price: String(m[2]) });
  }
  return dishes;
}

export function sanitizeActiveSpecialsPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dishes = (Array.isArray(raw.dishes) ? raw.dishes : [])
    .map((d) => ({
      name: String(d?.name || "").replace(/\s+/g, " ").trim(),
      price: String(d?.price || "").replace(/^\$/, "").trim(),
      notes: d?.notes ? String(d.notes).trim() : undefined,
    }))
    .filter((d) => d.name && d.price && !looksGenericMenuFallback(d.name));
  if (!dishes.length) return null;
  return {
    dishes,
    meal: raw.meal === "lunch" ? "lunch" : "dinner",
    readAt: raw.readAt || null,
    boardWindow: raw.boardWindow || null,
    source: raw.source || "verified",
  };
}

function loadSeedPayload() {
  try {
    if (!existsSync(SEED_FILE)) return null;
    return sanitizeActiveSpecialsPayload(JSON.parse(readFileSync(SEED_FILE, "utf8")));
  } catch {
    return null;
  }
}

function mealFromBoard(board) {
  const win =
    board?.verified?.boardWindow?.window ||
    board?.boardWindow?.window;
  return win === "lunch" ? "lunch" : "dinner";
}

/**
 * Bind guest specials speech to the verified JSON only.
 * Never use unverified / generic OCR as the active payload.
 */
export function buildActiveSpecialsPayload(board) {
  const stored = sanitizeActiveSpecialsPayload(board?.active_specials_payload);
  if (stored) return stored;

  const verifiedText = board?.verified?.text || "";
  let dishes = parseBoardDishes(verifiedText);
  if (
    !dishes.length &&
    board?.ocrFallback !== true &&
    board?.text &&
    !looksGenericMenuFallback(board.text)
  ) {
    dishes = parseBoardDishes(board.text);
  }
  if (dishes.length) {
    return {
      dishes,
      meal: mealFromBoard(board),
      readAt: board?.verified?.readAt || board?.readAt || null,
      boardWindow: board?.verified?.boardWindow || board?.boardWindow || null,
      source: "verified",
    };
  }
  return loadSeedPayload();
}

export function getActiveSpecialsPayload(board) {
  return buildActiveSpecialsPayload(board);
}

export function payloadHasDish(payload, name) {
  const q = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return false;
  return (payload?.dishes || []).some((d) => d.name.toLowerCase() === q);
}
