import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const restaurant = JSON.parse(
  readFileSync(join(__dirname, "../knowledge/restaurant.json"), "utf8")
);
const faq = JSON.parse(
  readFileSync(join(__dirname, "../knowledge/faq.json"), "utf8")
);

const MAX_ONLINE_PARTY =
  restaurant.policies?.maxOnlinePartySize ??
  restaurant.reservations?.maxOnlinePartySize ??
  6;

const ALLERGY_DISCLAIMER =
  restaurant.policies?.allergyDisclaimer ||
  "Please notify your server of severe allergies upon arrival so our kitchen can take extra precautions against cross-contamination.";

const MANAGER_OPTION =
  restaurant.policies?.managerOption ||
  `If you need something custom, ask for a manager when you call or arrive — or call ${restaurant.phone}.`;

const ALLERGY_FAQ_IDS = new Set([
  "allergies",
  "shellfish-allergy",
  "gluten",
  "vegetarian",
  "vegan",
  "dairy",
  "nut-allergy",
]);

function nowInRestaurantTz() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: restaurant.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const day = parts.weekday.toLowerCase();
  const h = Number(parts.hour === "24" ? "0" : parts.hour);
  const m = Number(parts.minute);
  return { day, minutes: h * 60 + m };
}

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isOpenNow() {
  const { day, minutes } = nowInRestaurantTz();
  const hours = restaurant.hours[day];
  if (!hours) return { open: false, day };
  const open = parseHHMM(hours.open);
  const close = parseHHMM(hours.close);
  return { open: minutes >= open && minutes < close, day, hours };
}

function hoursAnswer() {
  const status = isOpenNow();
  const openLine = status.open
    ? `We're OPEN now (${status.day}).`
    : `We're CLOSED right now (${status.day}).`;
  return `${openLine} Hours: ${restaurant.hours.display} Phone: ${restaurant.phone}`;
}

function largePartyAnswer(partySize = null) {
  const base =
    restaurant.reservations?.largePartyAnswer ||
    `Parties larger than ${MAX_ONLINE_PARTY} are outside our usual online booking size, but we may be able to accommodate your request. You’re welcome to speak with a manager at ${restaurant.phone}, or leave the details here and we’ll have a manager follow up.`;
  if (partySize && partySize > MAX_ONLINE_PARTY) {
    return `For a party of ${partySize}, we may be able to accommodate your request. Our usual online booking size is ${MAX_ONLINE_PARTY} or fewer — you’re welcome to speak with a manager at ${restaurant.phone}, or leave the details here and we’ll have a manager follow up.`;
  }
  return base;
}

/** Score FAQ hits — longer phrase matches win. */
function scoreFaqItem(lower, item) {
  let bestScore = 0;
  let bestPhrase = "";
  for (const phrase of item.includes || []) {
    const p = phrase.toLowerCase();
    if (lower.includes(p)) {
      const score = p.length + (p.includes(" ") ? 5 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestPhrase = p;
      }
    }
  }
  return bestScore ? { item, score: bestScore, phrase: bestPhrase } : null;
}

function findFaq(lower) {
  let best = null;
  for (const item of faq.items) {
    const hit = scoreFaqItem(lower, item);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best?.item || null;
}

/** Multi-part: collect distinct FAQ topics from one message. */
function findAllFaq(lower) {
  const hits = [];
  for (const item of faq.items) {
    const hit = scoreFaqItem(lower, item);
    if (hit && hit.score >= 5) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);

  const kept = [];
  const usedIds = new Set();
  const usedPhrases = [];
  for (const hit of hits) {
    if (usedIds.has(hit.item.id)) continue;
    // Skip if this phrase is fully contained in an already-used longer phrase
    if (usedPhrases.some((p) => p.includes(hit.phrase))) continue;
    // Prefer more specific allergy FAQ over generic "allerg"
    if (
      hit.item.id === "allergies" &&
      hits.some(
        (h) => ALLERGY_FAQ_IDS.has(h.item.id) && h.item.id !== "allergies"
      )
    ) {
      continue;
    }
    kept.push(hit);
    usedIds.add(hit.item.id);
    usedPhrases.push(hit.phrase);
    if (kept.length >= 4) break;
  }
  return kept.map((h) => h.item);
}

function withAllergyDisclaimer(text, item) {
  if (!item || !ALLERGY_FAQ_IDS.has(item.id)) return text;
  if (text.includes(ALLERGY_DISCLAIMER)) return text;
  return `${text}\n\n${ALLERGY_DISCLAIMER}`;
}

function resolveAnswer(item) {
  let answer;
  if (item.type === "hours") answer = hoursAnswer();
  else if (item.id === "party-size-max") answer = largePartyAnswer();
  else answer = item.answer || restaurant.callUs;
  return withAllergyDisclaimer(answer, item);
}

function extractPartySize(text) {
  const m =
    String(text).match(
      /\b(?:party of|table for|group of|party for)\s*(\d{1,2})\b/i
    ) || String(text).match(/\b(\d{1,2})\s*(?:people|guests|of us)\b/i);
  return m ? Number(m[1]) : null;
}

function isSeatingPreference(text) {
  return /\b(booth|window seat|bar seat|specific (table|booth|seat)|quiet (corner|table|spot)|near the (tv|bar|kitchen|window)|prefer to sit|seating preference|high top|high-top)\b/i.test(
    text
  );
}

function isCustomKitchenMod(text) {
  return /\b(substitut|modify|modification|custom (order|request)|special request|leave off|hold the|no onions?|extra crispy|make it without|can you (make|do|prepare))\b/i.test(
    text
  );
}

function managerFallbackAnswer(knownBits = []) {
  const parts = [];
  if (knownBits.length) parts.push(...knownBits);
  parts.push(
    `For seating preferences or custom kitchen requests that aren’t in our standard info: ${MANAGER_OPTION}`
  );
  return parts.join("\n\n");
}

/**
 * Generate a guest-facing reply from the uploaded knowledge base.
 * Rules: multi-part answers, large-party routing, allergy disclaimer, manager fallback.
 */
export function generateReply(rawMessage) {
  const text = String(rawMessage || "").trim();
  if (!text) {
    return `Hey! You've reached ${restaurant.name}. Ask about hours, menu, specials, allergies, reservations, to-go, catering, and more. Text HELP for options.`;
  }

  const lower = text.toLowerCase();

  // Only pure greetings — NOT "hey we have a party of 10…"
  if (
    /^(hi|hey|hello|yo|good (morning|afternoon|evening))([.!?]*)?$/i.test(
      lower
    )
  ) {
    return `Hi! Thanks for texting ${restaurant.name}. I can help with hours, address, menu, specials, allergies, happy hour, reservations, to-go, catering & private events. What do you need?`;
  }

  if (/^help\b/.test(lower) || lower.includes("what can you")) {
    return [
      `${restaurant.name} text helper:`,
      "• HOURS / OPEN",
      "• ADDRESS / PARKING",
      "• MENU / SPECIALS",
      "• ALLERGIES / GLUTEN / SHELLFISH",
      "• HAPPY HOUR / DRINKS",
      "• RESERVATION / CHANGE / CANCEL",
      "• TO-GO ORDER",
      "• CATERING / PRIVATE EVENT",
      "• LARGE PARTY questions",
      "• HUMAN (call the restaurant)",
    ].join("\n");
  }

  const partySize = extractPartySize(text);
  const askingLargeParty =
    /\b(how big|max party|largest party|party size limit|how many people can|how large|big group|large group|large party)\b/i.test(
      text
    ) ||
    (partySize != null && partySize > MAX_ONLINE_PARTY);

  if (askingLargeParty && (partySize == null || partySize > MAX_ONLINE_PARTY)) {
    // Still attach other FAQ parts (e.g. allergy + party in one message)
    const otherHits = findAllFaq(lower).filter(
      (i) => !["party-size-max", "party-of-6", "reservations-yes"].includes(i.id)
    );
    const parts = [largePartyAnswer(partySize)];
    for (const hit of otherHits) {
      parts.push(resolveAnswer(hit));
    }
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    return parts.join("\n\n");
  }

  const hits = findAllFaq(lower);
  if (hits.length >= 2) {
    const parts = hits.map((h) => resolveAnswer(h));
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    // If any allergy topic appeared, ensure disclaimer once at end
    if (
      hits.some((h) => ALLERGY_FAQ_IDS.has(h.id)) &&
      !parts.join("\n").includes(ALLERGY_DISCLAIMER)
    ) {
      parts.push(ALLERGY_DISCLAIMER);
    }
    return parts.join("\n\n");
  }

  if (hits.length === 1) {
    let answer = resolveAnswer(hits[0]);
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      answer = managerFallbackAnswer([answer]);
    }
    return answer;
  }

  // No FAQ hit — seating / custom kitchen still get a useful fallback
  if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
    return managerFallbackAnswer([
      `I can help with hours, menu, specials, allergies, and reservations from our knowledge base.`,
    ]);
  }

  return `Thanks for texting ${restaurant.name}! I'm not sure on that one yet. Try HOURS, MENU, SPECIALS, ALLERGIES, RESERVATION, TO-GO, or CATERING — or call us at ${restaurant.phone}.`;
}

export {
  restaurant,
  faq,
  findFaq,
  findAllFaq,
  isOpenNow,
  extractPartySize,
  largePartyAnswer,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
  MANAGER_OPTION,
  withAllergyDisclaimer,
};
