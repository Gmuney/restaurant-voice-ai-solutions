import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshBoardActiveSpecialsFromSeed } from "../board/read-board.js";
import { KNOWLEDGE_DIR } from "../paths.js";
import {
  clearChalkboardTakenOff,
  getChalkboardTakenOff,
  recordChalkboardTakenOff,
} from "../store.js";
import { findPayloadDish, sanitizeActiveSpecialsPayload } from "./board-payload.js";

export const REMOVED_CHALKBOARD_GUEST_REPLY_EN =
  "I apologize, but our chef just sold out of that feature for the evening! Can I tell you about our other chalkboard specials?";

const SEED_FILE = join(KNOWLEDGE_DIR, "active-specials.json");

/**
 * Parse manager `/addspecial` payload (slash command only — never from free text).
 * Formats:
 *   Dish Name | 24 | toppings | sides
 *   Dish Name $24 toppings: ... sides: ...
 */
export function parseAddSpecialArg(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim());
    const name = parts[0]?.replace(/^["']|["']$/g, "").trim();
    const price = String(parts[1] || "")
      .replace(/^\$/, "")
      .match(/\d{2,3}/)?.[0];
    if (!name || !price) {
      throw new Error(
        "Use: /addspecial Dish Name | price | toppings (optional) | sides (optional)"
      );
    }
    return {
      name,
      price,
      ...(parts[2] ? { toppings: parts[2] } : {}),
      ...(parts[3] ? { sides: parts[3] } : {}),
    };
  }

  const labeled = text.match(
    /^(.+?)\s+(?:\$|for\s+\$?\s*)(\d{2,3})\b(?:\s+toppings?:\s*(.+?))?(?:\s+sides?:\s*(.+))?$/i
  );
  if (labeled) {
    return {
      name: labeled[1].replace(/\s+/g, " ").trim(),
      price: labeled[2],
      ...(labeled[3] ? { toppings: labeled[3].trim() } : {}),
      ...(labeled[4] ? { sides: labeled[4].trim() } : {}),
    };
  }

  const dashPrice = text.match(/^(.+?)\s*[—–-]\s*\$?\s*(\d{2,3})\b/);
  if (dashPrice) {
    return {
      name: dashPrice[1].replace(/\s+/g, " ").trim(),
      price: dashPrice[2],
    };
  }

  throw new Error(
    "Use: /addspecial Dish Name | price | toppings (optional) | sides (optional)"
  );
}

function readSeedDocument() {
  if (!existsSync(SEED_FILE)) {
    return { source: "verified", meal: "dinner", dishes: [] };
  }
  try {
    return JSON.parse(readFileSync(SEED_FILE, "utf8"));
  } catch {
    return { source: "verified", meal: "dinner", dishes: [] };
  }
}

function writeSeedDocument(doc) {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(SEED_FILE, JSON.stringify(doc, null, 2) + "\n");
}

function seedDishRow(parsed) {
  const row = {
    name: parsed.name,
    price: String(parsed.price).replace(/^\$/, "").trim(),
  };
  if (parsed.toppings) row.toppings = String(parsed.toppings).trim();
  if (parsed.sides) row.sides = String(parsed.sides).trim();
  return row;
}

/**
 * Append or update a chalkboard dish in knowledge/active-specials.json and refresh board cache.
 */
export function managerAddChalkboardSpecialFromParsed(parsed) {
  if (!parsed?.name || !parsed?.price) {
    throw new Error(
      "Use: /addspecial Dish Name | price | toppings (optional) | sides (optional)"
    );
  }

  const doc = readSeedDocument();
  const dishes = Array.isArray(doc.dishes) ? [...doc.dishes] : [];
  const key = parsed.name.toLowerCase();
  const idx = dishes.findIndex((d) => String(d?.name || "").toLowerCase() === key);
  const row = seedDishRow(parsed);
  if (idx >= 0) {
    dishes[idx] = { ...dishes[idx], ...row };
  } else {
    dishes.push(row);
  }

  writeSeedDocument({
    ...doc,
    source: doc.source || "verified",
    meal: doc.meal === "lunch" ? "lunch" : "dinner",
    dishes,
  });

  clearChalkboardTakenOff(parsed.name);
  refreshBoardActiveSpecialsFromSeed();

  const payload = sanitizeActiveSpecialsPayload(readSeedDocument());
  const dish =
    payload?.dishes?.find((d) => d.name.toLowerCase() === key) || row;
  return { dish, payload };
}

export function managerAddChalkboardSpecial(raw) {
  return managerAddChalkboardSpecialFromParsed(parseAddSpecialArg(raw));
}

/** Match a manager or guest query to a dish on the current seed roster. */
export function resolveChalkboardSeedDish(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const doc = readSeedDocument();
  const payload = sanitizeActiveSpecialsPayload(doc);
  if (!payload?.dishes?.length) return null;
  const exact = payload.dishes.find(
    (d) => d.name.toLowerCase() === text.toLowerCase()
  );
  if (exact) return exact;
  return findPayloadDish(text, payload);
}

function dishesMatchingTakeoffQuery(text, payload) {
  const resolved = resolveChalkboardSeedDish(text);
  if (resolved?.name) return [resolved];

  const needle = String(text || "").trim().toLowerCase();
  if (!needle || !payload?.dishes?.length) return [];
  return payload.dishes.filter((d) =>
    String(d?.name || "").toLowerCase().includes(needle)
  );
}

/**
 * Remove one or more chalkboard specials (slash `/takeoffspecial` only).
 * Records names so guest asks get the sold-out-for-the-evening script.
 */
export function managerRemoveChalkboardSpecial(raw, by = "manager") {
  const text = String(raw || "").trim();
  if (!text) {
    throw new Error("Tell me which chalkboard special to remove — example: /takeoffspecial Salmon Cakes");
  }

  const doc = readSeedDocument();
  const payload = sanitizeActiveSpecialsPayload(doc);
  const matches = dishesMatchingTakeoffQuery(text, payload);
  if (!matches.length) {
    throw new Error("NOT_FOUND");
  }

  const removeKeys = new Set(matches.map((d) => d.name.toLowerCase()));
  const dishes = (Array.isArray(doc.dishes) ? doc.dishes : []).filter(
    (d) => !removeKeys.has(String(d?.name || "").toLowerCase())
  );

  writeSeedDocument({
    ...doc,
    source: doc.source || "verified",
    meal: doc.meal === "lunch" ? "lunch" : "dinner",
    dishes,
  });

  for (const dish of matches) {
    recordChalkboardTakenOff(dish.name, by);
  }
  refreshBoardActiveSpecialsFromSeed();

  return {
    dish: matches[0],
    removedDishes: matches,
    removed: getChalkboardTakenOff().removed,
  };
}

/** Parse `/takeoffspecial Dish` or `/takeoffspecial [Dish]` — null if not this command. */
export function parseTakeoffSpecialCommand(userMessage) {
  const input = String(userMessage || "").trim();
  if (!/^\/takeoffspecial(?:@\w+)?\s+/i.test(input)) return null;
  let item = input.replace(/^\/takeoffspecial(?:@\w+)?\s+/i, "").trim();
  if (item.startsWith("[") && item.endsWith("]")) {
    item = item.slice(1, -1).trim();
  }
  return item.replace(/^["']|["']$/g, "").trim();
}

/**
 * Middleware: only runs when input starts with `/takeoffspecial`.
 * Mutates live chalkboard (seed + cache) via managerRemoveChalkboardSpecial.
 */
export function handleRemoveSpecialCommand(userMessage, by = "manager") {
  const itemToRemove = parseTakeoffSpecialCommand(userMessage);
  if (itemToRemove === null) return null;
  if (!itemToRemove) {
    return {
      handled: true,
      ok: false,
      text: "Usage: /takeoffspecial Dish Name\nExample: /takeoffspecial Salmon Cakes",
    };
  }

  try {
    const { dish, removedDishes } = managerRemoveChalkboardSpecial(
      itemToRemove,
      by
    );
    const label =
      removedDishes?.length > 1
        ? removedDishes.map((d) => d.name).join('", "')
        : dish.name;
    return {
      handled: true,
      ok: true,
      text: `[MANAGER OVERRIDE: Successfully removed "${label}" from live Chalkboard Specials.]`,
      dish,
      removedDishes,
    };
  } catch (err) {
    if (String(err?.message) !== "NOT_FOUND") throw err;
    return {
      handled: true,
      ok: false,
      text: `[MANAGER OVERRIDE: "${itemToRemove}" was not found in active Chalkboard Specials.]`,
    };
  }
}

/** Guest asked about a special the manager removed from the chalkboard tonight. */
export function findRemovedChalkboardDish(query) {
  const removed = getChalkboardTakenOff().removed;
  if (!removed.length) return null;
  const payload = {
    dishes: removed.map((r) => ({
      name: r.name,
      price: "00",
      toppings: "removed",
    })),
  };
  const hit = findPayloadDish(query, payload);
  if (!hit) return null;
  return removed.find((r) => r.name.toLowerCase() === hit.name.toLowerCase()) || null;
}

export function removedChalkboardGuestReply(lang = "en") {
  if (lang === "es") {
    return "Lo siento, pero el chef acaba de agotar esa especialidad de la noche. ¿Le cuento sobre nuestras otras especialidades del pizarrón?";
  }
  return REMOVED_CHALKBOARD_GUEST_REPLY_EN;
}
