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
        ...(d?.spokenIntro === false ? { spokenIntro: false } : {}),
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

/** Retired board lines — never guest-facing even if old cache or OCR revives them. */
const REMOVED_CHALKBOARD_DISHES =
  /^(voodoo seafood pasta|low country porkchop)$/i;

function dropRemovedChalkboardDishes(dishes) {
  return (dishes || []).filter((d) => !REMOVED_CHALKBOARD_DISHES.test(String(d?.name || "").trim()));
}

/**
 * knowledge/active-specials.json is the canonical roster.
 * Cached/OCR payloads may only update prices or sub-lines for those names.
 */
function reconcilePayloadWithSeed(payload) {
  const seed = loadSeedPayload();
  const cleaned = dropRemovedChalkboardDishes(payload?.dishes || []);
  if (!seed?.dishes?.length) {
    return payload?.dishes?.length ? { ...payload, dishes: cleaned } : payload;
  }
  const storedByName = new Map(cleaned.map((d) => [d.name.toLowerCase(), d]));
  const dishes = seed.dishes.map((seedDish) => {
    const stored = storedByName.get(seedDish.name.toLowerCase());
    if (!stored) return seedDish;
    return {
      ...seedDish,
      price: stored.price || seedDish.price,
      toppings: stored.toppings || seedDish.toppings,
      sides: stored.sides || seedDish.sides,
    };
  });
  return {
    ...payload,
    meal: seed.meal || payload?.meal || "dinner",
    source: seed.source || payload?.source || "verified",
    dishes,
  };
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
  if (stored) return reconcilePayloadWithSeed(mergeSeedSides(stored));

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
    return reconcilePayloadWithSeed(
      mergeSeedSides({
        dishes,
        meal: mealFromBoard(board),
        readAt: board?.verified?.readAt || board?.readAt || null,
        boardWindow: board?.verified?.boardWindow || board?.boardWindow || null,
        source: "verified",
      })
    );
  }
  return loadSeedPayload();
}

/** Guest-facing chalkboard line — name, price, and a written sub-line (sides and/or toppings). */
export function isChalkboardListedDish(dish) {
  if (!dish?.name || !dish?.price) return false;
  return Boolean(dishSides(dish) || dishToppings(dish));
}

export function chalkboardFeaturedDishes(dishes) {
  return (Array.isArray(dishes) ? dishes : []).filter(isChalkboardListedDish);
}

/** Full chalkboard list for “what are today’s specials?” (seed file order). */
export function chalkboardIntroDishes(dishes) {
  const listed = chalkboardFeaturedDishes(dishes);
  const introOnly = listed.filter((d) => d.spokenIntro !== false);
  return introOnly.length ? introOnly : listed;
}

export function getActiveSpecialsPayload(board) {
  const payload = buildActiveSpecialsPayload(board);
  if (!payload?.dishes?.length) return payload;
  const dishes = chalkboardFeaturedDishes(payload.dishes);
  if (dishes.length === payload.dishes.length) return payload;
  return { ...payload, dishes };
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

function payloadDishFromAlias(query, payload) {
  const q = String(query || "").toLowerCase();
  const dishes = payload?.dishes || [];
  if (/\b(the\s+)?nola\b/.test(q)) {
    return dishes.find((d) => /redfish nola/i.test(d.name)) || null;
  }
  if (/\b(the\s+)?mahi\s+tacos?\b/.test(q) && !/\bfish\s+tacos?\b/.test(q)) {
    return dishes.find((d) => /mahi tacos/i.test(d.name)) || null;
  }
  if (/\bsalmon\s+cakes?\b/.test(q)) {
    return dishes.find((d) => /salmon cakes/i.test(d.name)) || null;
  }
  if (
    /\b(low country shrimp|shrimp\s*(and|&|with)\s*grits?|grits?\s*(and|&|with)\s*shrimp)\b/.test(
      q
    )
  ) {
    return dishes.find((d) => /shrimp.*grits/i.test(d.name)) || null;
  }
  return null;
}

/** Match "Mahi Tacos" to a payload dish before the everyday menu. */
export function findPayloadDish(query, payload = getActiveSpecialsPayload()) {
  const dishes = payload?.dishes || [];
  if (!dishes.length) return null;

  const aliasHit = payloadDishFromAlias(query, payload);
  if (aliasHit) return aliasHit;

  const tokens = queryTokens(query);
  if (!tokens.length) return null;

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
  if (/\bsalmon\s+cakes?\b/i.test(q) && !names.some((n) => /\bsalmon cakes/i.test(n))) {
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

/** Guest asked what sides come with a dish — toppings-only asks do not count. */
export function asksSidesOnly(text) {
  const t = String(text || "");
  if (/\btoppings?\b/i.test(t) && !/\bsides?\b/i.test(t)) return false;
  if (/\b(sauces?|ingredients?)\b/i.test(t) && !/\bsides?\b/i.test(t)) {
    return false;
  }
  if (
    /\b(chang(?:e|es|ed|ing)|swap(?:ped|ping)?|switch(?:ed|ing)?|substitut\w*|replac(?:e|ed|ing)|switch out|change out|swap out).{0,40}\b(sides?|fries|papas?|potatoes)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return /\b(sides?|side options?|come with|comes with|served with|on the side)\b/i.test(
    t
  );
}

export function asksToppingsOnly(text) {
  const t = String(text || "");
  return (
    /\b(toppings?|sauces?)\b/i.test(t) &&
    !/\bsides?\b/i.test(t) &&
    !/\b(come with|comes with|served with)\b/i.test(t)
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

  if (asksSidesOnly(query) && sides.length) {
    const portionTopping =
      /salmon cakes/i.test(dish.name) &&
      toppings.some((t) => /\b\d+\s+salmon cakes?\b/i.test(t));
    if (portionTopping) {
      return lang === "es"
        ? `¡${dish.name} incluye ${listSpokenItems(toppings)}, servidos con ${listSpokenItems(sides)} de guarnición!`
        : `The ${dish.name} comes with ${listSpokenItems(toppings)}, served with ${listSpokenItems(sides)} on the side!`;
    }
    return lang === "es"
      ? `¡${dish.name} se sirve con ${listSpokenItems(sides)} de guarnición!`
      : `The ${dish.name} comes served with ${listSpokenItems(sides)} on the side!`;
  }

  if (asksToppingsOnly(query) && toppings.length) {
    return lang === "es"
      ? `¡${dish.name} va cubierto con ${listSpokenItems(toppings)}!`
      : `The ${dish.name} comes topped with ${listSpokenItems(toppings)}!`;
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

function activeDishSidesIncludeFries(dishSides) {
  return dishSides.some((s) => /\bfries\b/i.test(String(s)));
}

function getEverydaySubstitutionSides() {
  try {
    const data = JSON.parse(
      readFileSync(join(KNOWLEDGE_DIR, "everyday-sides.json"), "utf8")
    );
    return Array.isArray(data.sides) ? data.sides : [];
  } catch {
    return [
      "Cuban Black Beans & Rice",
      "Buttermilk Mashed Potatoes",
      "Hush Puppies",
      "House-Seasoned Fries",
      "Virginia's Apple Cider Coleslaw",
    ];
  }
}

function spokenDishLabel(name) {
  const n = String(name || "").trim();
  if (/grilled redfish nola/i.test(n)) return "the Nola";
  if (/jalapeno bacon mahi tacos/i.test(n)) return "the Mahi Tacos";
  if (/maple chipotle seared halibut/i.test(n)) return "the Halibut";
  if (/salmon cakes/i.test(n)) return "the Salmon Cakes";
  if (/low country shrimp/i.test(n)) return "the Low Country Shrimp & Grits";
  if (/double bacon cheeseburger/i.test(n)) return "the Double Bacon Cheeseburger";
  return n.startsWith("the ") ? n : `the ${n}`;
}

function dishComesVerb(label) {
  return /\b(tacos|burgers?)\b/i.test(label) ? "come" : "comes";
}

function normalizeSideToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sidesOverlap(candidate, dishSide) {
  const a = normalizeSideToken(candidate);
  const b = normalizeSideToken(dishSide);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function phraseOrList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** Spoken shortenings so side lists sound natural on the phone. */
function spokenSideName(option) {
  const o = String(option || "");
  if (/virginia'?s apple cider coleslaw/i.test(o)) return "apple cider coleslaw";
  if (/cuban black beans/i.test(o)) return "Cuban black beans and rice";
  if (/buttermilk mashed/i.test(o)) return "buttermilk mashed potatoes";
  if (/house-seasoned fries/i.test(o)) return "house-seasoned fries";
  return o;
}

function spokenSideList(options) {
  return phraseOrList(options.map(spokenSideName));
}

function hashDishSeed(name) {
  let h = 2166136261;
  for (const c of String(name || "")) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function eligibleSubstitutionSides(dishSides) {
  const dishHasFries = activeDishSidesIncludeFries(dishSides);
  const out = [];
  for (const option of getEverydaySubstitutionSides()) {
    if (dishSides.some((s) => sidesOverlap(option, s))) continue;
    if (dishHasFries && /\bfries\b/i.test(option)) continue;
    out.push(option);
  }
  return out;
}

/** Per-dish swap ideas (3 each) so Halibut / Nola / Mahi don't share the same script. */
const DISH_SIDE_SWAP_PICKS = [
  {
    match: /redfish nola/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Cuban Black Beans & Rice",
      "Hush Puppies",
    ],
  },
  {
    match: /halibut/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Cuban Black Beans & Rice",
      "House-Seasoned Fries",
    ],
  },
  {
    match: /salmon cakes/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Cuban Black Beans & Rice",
      "Hush Puppies",
    ],
  },
  {
    match: /shrimp.*grits/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Cuban Black Beans & Rice",
      "Hush Puppies",
    ],
  },
  {
    match: /mahi tacos/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Hush Puppies",
      "Cuban Black Beans & Rice",
    ],
  },
  {
    match: /double bacon cheeseburger/i,
    picks: [
      "Virginia's Apple Cider Coleslaw",
      "Cuban Black Beans & Rice",
      "Buttermilk Mashed Potatoes",
    ],
  },
];

function pickSideAlternatives(dishSides, dishName = "") {
  const eligible = eligibleSubstitutionSides(dishSides);
  if (!eligible.length) return [];

  const name = String(dishName || "");
  const profile = DISH_SIDE_SWAP_PICKS.find((p) => p.match.test(name));
  const picked = [];
  const seen = new Set();
  for (const option of profile?.picks || []) {
    if (!eligible.includes(option)) continue;
    const key = normalizeSideToken(option);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(option);
  }

  const targetCount = 3;
  if (picked.length < targetCount) {
    const seed = hashDishSeed(name || dishSides.join("|"));
    const rest = eligible.filter((o) => !seen.has(normalizeSideToken(o)));
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = (seed + i * 2654435761) % (i + 1);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    for (const option of rest) {
      if (picked.length >= targetCount) break;
      picked.push(option);
    }
  }

  return picked.slice(0, targetCount);
}

/**
 * Shelly side swap (max 3 sentences): restate `{active_dish.sides}`, then everyday_sides alternates.
 */
export function conversationalSideSubstitutionReply(dish, lang = "en", _query = "") {
  const sides = subLineParts(dish).sides;
  if (!sides.length) return null;

  const alternatives = pickSideAlternatives(sides, dish.name);
  if (!alternatives.length) return null;

  const label = spokenDishLabel(dish.name);
  const sidesListed = listSpokenItems(sides);
  const swapScope = sides.length > 1 ? "either or both" : "that";
  const swapTo = spokenSideList(alternatives);
  const variant = hashDishSeed(dish.name) % 3;
  const verb = dishComesVerb(label);

  if (lang === "es") {
    const esAlts = swapTo;
    if (variant === 0) {
      return `¡Por supuesto! ${label} se sirve con ${sidesListed}. Puedes cambiar ${swapScope === "that" ? "eso" : "uno o ambos"} por ${esAlts}. ¿Qué prefieres?`;
    }
    if (variant === 1) {
      return `Claro — ${label} va con ${sidesListed}. Podemos cambiar ${swapScope === "that" ? "esa guarnición" : "cualquiera de esas guarniciones"} por ${esAlts}. ¿Cuál te gustaría?`;
    }
    return `Con gusto — las guarniciones de ${label} son ${sidesListed}. Si quieres, cambiamos ${swapScope === "that" ? "eso" : "uno o los dos"} por ${esAlts}. ¿Qué te provoca?`;
  }

  if (variant === 0) {
    return `Absolutely — ${label} ${verb} with ${sidesListed}. You can swap ${swapScope} for ${swapTo}. What would you like instead?`;
  }
  if (variant === 1) {
    return `Sure thing — ${label} ${verb} with ${sidesListed}. We can switch ${swapScope} out for ${swapTo}. Which swap sounds good?`;
  }
  return `Happy to help — ${label} ${verb} with ${sidesListed} on the side. Feel free to trade ${swapScope} for ${swapTo}. What are you in the mood for?`;
}

/** Resolve chalkboard dish from the current message, stored context, or recent turns. */
export function resolveActivePayloadDish(
  query,
  { recentMessages = [], activeDishName = null } = {}
) {
  const fromQuery = findPayloadDish(query);
  if (fromQuery) return fromQuery;

  const payload = getActiveSpecialsPayload();
  if (activeDishName) {
    const named = (payload?.dishes || []).find(
      (d) => d.name.toLowerCase() === String(activeDishName).toLowerCase()
    );
    if (named) return named;
  }

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const hit = findPayloadDish(recentMessages[i], payload);
    if (hit) return hit;
  }
  return null;
}
