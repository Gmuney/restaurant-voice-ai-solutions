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

function cleanSidesText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[-•*,.;:\s]+|[-•*,.;:\s]+$/g, "")
    .trim();
}

function dishSides(d) {
  return cleanSidesText(d?.sides);
}

function dishToppings(d) {
  return cleanSidesText(d?.toppings);
}

function dishSubLine(d) {
  return cleanSidesText(d?.subLine || d?.notes || "");
}

/** Dish name + price + indented sub-line (ingredients / sides). */
export function parseBoardDishes(boardText) {
  const dishes = [];
  const seen = new Set();
  let last = null;
  for (const raw of String(boardText || "").split(/\n/)) {
    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    if (!line) continue;
    if (/^drinks?\b/i.test(line)) break;
    if (indented && !/\$\d{2,3}\b/.test(line)) {
      if (last && !/\[unclear\]/i.test(line) && !looksGenericMenuFallback(line)) {
        last.sides = last.sides
          ? `${last.sides}, ${cleanSidesText(line)}`
          : cleanSidesText(line);
      }
      continue;
    }
    const m =
      line.match(/^[-•*]?\s*(.+?)\s*[—–\-:]+\s*\$?\s*(\d{2,3})\b/) ||
      line.match(/^[-•*]?\s*(.+?)\s+\$\s*(\d{2,3})\b/);
    if (!m) continue;
    let name = m[1].replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
    name = name.replace(/^the\s+/i, "");
    if (name.length < 4) continue;
    if (/\[unclear\]/i.test(name)) continue;
    if (looksGenericMenuFallback(name)) {
      last = null;
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    last = { name, price: String(m[2]) };
    dishes.push(last);
  }
  return dishes;
}

export function sanitizeActiveSpecialsPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dishes = (Array.isArray(raw.dishes) ? raw.dishes : [])
    .map((d) => {
      const toppings = dishToppings(d);
      let sides = dishSides(d);
      const subLine = dishSubLine(d);
      if (!sides && !toppings && subLine) sides = subLine;
      return {
        name: String(d?.name || "").replace(/\s+/g, " ").trim(),
        price: String(d?.price || "").replace(/^\$/, "").trim(),
        ...(toppings ? { toppings } : {}),
        ...(sides ? { sides } : {}),
      };
    })
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

function mergeSeedSides(payload) {
  const seed = loadSeedPayload();
  if (!payload?.dishes?.length || !seed?.dishes?.length) return payload;
  const byName = new Map(seed.dishes.map((d) => [d.name.toLowerCase(), d]));
  return {
    ...payload,
    dishes: payload.dishes.map((d) => {
      const fromSeed = byName.get(d.name.toLowerCase());
      if (!fromSeed) return d;
      return {
        ...d,
        toppings: fromSeed.toppings || d.toppings,
        sides: fromSeed.sides || d.sides,
      };
    }),
  };
}

/**
 * Bind guest specials speech to the verified JSON only.
 * Never use unverified / generic OCR as the active payload.
 */
export function buildActiveSpecialsPayload(board) {
  const stored = sanitizeActiveSpecialsPayload(board?.active_specials_payload);
  if (stored) return mergeSeedSides(stored);

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
    return mergeSeedSides({
      dishes,
      meal: mealFromBoard(board),
      readAt: board?.verified?.readAt || board?.readAt || null,
      boardWindow: board?.verified?.boardWindow || board?.boardWindow || null,
      source: "verified",
    });
  }
  return loadSeedPayload();
}

export function getActiveSpecialsPayload(board) {
  return buildActiveSpecialsPayload(board);
}

const QUERY_STOP = new Set([
  "what",
  "whats",
  "about",
  "come",
  "comes",
  "with",
  "that",
  "this",
  "your",
  "today",
  "todays",
  "side",
  "sides",
  "topping",
  "toppings",
  "sauce",
  "sauces",
  "ingredient",
  "ingredients",
  "special",
  "specials",
  "chalkboard",
  "board",
  "dish",
  "item",
  "please",
  "tell",
  "more",
  "served",
  "have",
  "does",
  "the",
  "our",
  "any",
  "those",
  "them",
  "and",
]);

const WEAK_DISH_WORDS = new Set([
  "taco",
  "tacos",
  "pasta",
  "grilled",
  "fried",
  "seared",
  "bacon",
  "fish",
  "shrimp",
]);

function queryTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !QUERY_STOP.has(w));
}

/** Match "Mahi Tacos" to a payload dish before the everyday menu. */
export function findPayloadDish(query, payload = getActiveSpecialsPayload()) {
  const tokens = queryTokens(query);
  if (!tokens.length) return null;
  const dishes = payload?.dishes || [];
  if (!dishes.length) return null;

  let best = null;
  let bestScore = 0;
  for (const dish of dishes) {
    const name = dish.name.toLowerCase();
    const score = tokens.reduce((s, t) => (name.includes(t) ? s + t.length : s), 0);
    if (score > bestScore) {
      bestScore = score;
      best = dish;
    }
  }
  if (!best || bestScore < 4) return null;

  const strong = tokens.filter((t) => !WEAK_DISH_WORDS.has(t));
  if (strong.length) {
    if (!strong.some((t) => best.name.toLowerCase().includes(t))) return null;
  } else if (tokens.length < 2) {
    return null;
  }

  const q = String(query || "").toLowerCase();
  const names = dishes.map((d) => d.name.toLowerCase());
  if (/\bfish\s+tacos?\b/i.test(q) && !names.some((n) => n.includes("fish tacos"))) {
    return null;
  }
  if (/\bshrimp\s+tacos?\b/i.test(q) && !names.some((n) => n.includes("shrimp tacos"))) {
    return null;
  }
  if (/\bcrab\s+cakes?\b/i.test(q) && !names.some((n) => /\bcrab\b/.test(n))) {
    return null;
  }
  return best;
}

function listSpokenItems(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function splitSides(sides) {
  return String(sides || "")
    .split(/,|;|\s+\+\s+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

function subLineParts(dish) {
  return {
    toppings: splitSides(dish?.toppings),
    sides: splitSides(dish?.sides),
  };
}

export function asksSidesOrToppings(text) {
  return /\b(sides?|toppings?|sauces?|ingredients?|come with|comes with|served with|on (the )?side|what'?s (on|in) (it|them|that))\b/i.test(
    String(text || "")
  );
}

/**
 * Host-style readout of every topping and side in the payload sub-line.
 * Never answer a sides/toppings ask with only the name and price.
 */
export function spokenPayloadDishDetail(dish, lang = "en", query = "") {
  if (!dish?.name) return "";
  const { toppings, sides } = subLineParts(dish);
  const all = [...toppings, ...sides];
  const askedSub = asksSidesOrToppings(query);

  if (!all.length) {
    if (askedSub) {
      return lang === "es"
        ? `No tengo escritas las guarniciones ni los toppings de nuestros ${dish.name} en el pizarrón de hoy. ¿Quiere que le cuente de otro especial?`
        : `I don't have the sides and toppings written for our ${dish.name} on today's chalkboard. Would you like me to tell you about another special?`;
    }
    return lang === "es"
      ? `¡Nuestros ${dish.name} están en el pizarrón especial!`
      : `Our ${dish.name} is on the chalkboard special tonight!`;
  }

  if (lang === "es") {
    if (toppings.length && sides.length) {
      return `¡Nuestros ${dish.name} van cubiertos con ${listSpokenItems(toppings)}, y se sirven con ${listSpokenItems(sides)} de guarnición!`;
    }
    return `¡Nuestros ${dish.name} se sirven con ${listSpokenItems(all)}!`;
  }

  if (toppings.length && sides.length) {
    return `Our ${dish.name} comes topped with ${listSpokenItems(toppings)}, and it's served with ${listSpokenItems(sides)} on the side!`;
  }
  return `Our ${dish.name} comes served with ${listSpokenItems(all)}!`;
}

export function payloadHasDish(payload, name) {
  const q = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return false;
  return (payload?.dishes || []).some((d) => d.name.toLowerCase() === q);
}
