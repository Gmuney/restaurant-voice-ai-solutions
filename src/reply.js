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
    `Our maximum party size for booking here is ${MAX_ONLINE_PARTY}. For parties larger than ${MAX_ONLINE_PARTY}, I’ll transfer you to a manager — please call ${restaurant.phone} and ask for a manager.`;
  if (partySize && partySize > MAX_ONLINE_PARTY) {
    return `A party of ${partySize} is over our maximum booking size of ${MAX_ONLINE_PARTY}. I’ll transfer you to a manager — please call ${restaurant.phone} and ask for a manager, and I’ll also flag a manager here to follow up.`;
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
      /\b(?:party of|table for|group of|party for|reservation for|reservations? for|mesa para|reservaci[oó]n para)\s*(\d{1,2})\b/i
    ) ||
    String(text).match(/\b(?:make a reservation|book(?:ing)?|reservar)\s+for\s+(\d{1,2})\b/i) ||
    String(text).match(/\b(\d{1,2})\s*(?:people|guests|of us|personas)\b/i);
  return m ? Number(m[1]) : null;
}

function isSeatingPreference(text) {
  return /\b(booth|window seat|bar seat|specific (table|booth|seat)|quiet (corner|table|spot)|near the (tv|bar|kitchen|window)|prefer to sit|seating preference|high top|high-top)\b/i.test(
    text
  );
}

function isSideSwap(text) {
  return /\b(change|changed|swap|swapped|switch|switched|substitut|replace|replaced|different|another|switch out|change out|swap out).{0,40}\bsides?\b|\bsides?\b.{0,40}\b(change|changed|swap|swapped|switch|switched|substitut|replace|replaced|different|another)\b/i.test(
    text
  );
}

function sideSwapAnswer() {
  return (
    restaurant.policies?.sideSubstitutions ||
    "Yes — we can change out any side item for our other side items that we have listed. Tell your server (or note it on your to-go order) which listed side you’d like instead."
  );
}

function isCustomKitchenMod(text) {
  if (isSideSwap(text)) return false;
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
 * Pass { language: "es" } for Spanish greetings / unsure fallbacks (FAQ answers may still be EN; caller can translate).
 */
export function generateReply(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  if (!text) {
    return lang === "es"
      ? `¡Hola! Has contactado a ${restaurant.name}. Pregunta por horarios, menú, especiales, alergias, reservaciones, para llevar, catering y más. Escribe AYUDA para opciones.`
      : `Hey! You've reached ${restaurant.name}. Ask about hours, menu, specials, allergies, reservations, to-go, catering, and more. Text HELP for options.`;
  }

  const lower = text.toLowerCase();

  // Only pure greetings — NOT "hey we have a party of 10…"
  if (
    /^(hi|hey|hello|yo|good (morning|afternoon|evening)|hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)([.!?]*)?$/i.test(
      lower
    )
  ) {
    return lang === "es"
      ? `¡Hola! Gracias por escribir a ${restaurant.name}. Puedo ayudar con horarios, dirección, menú, especiales, alergias, happy hour, reservaciones, para llevar, catering y eventos privados. ¿En qué te ayudo?`
      : `Hi! Thanks for texting ${restaurant.name}. I can help with hours, address, menu, specials, allergies, happy hour, reservations, to-go, catering & private events. What do you need?`;
  }

  if (
    /^help\b/.test(lower) ||
    /^ayuda\b/.test(lower) ||
    lower.includes("what can you") ||
    lower.includes("qué puedes") ||
    lower.includes("que puedes")
  ) {
    if (lang === "es") {
      return [
        `Asistente de ${restaurant.name}:`,
        "• HORARIO / ABIERTO",
        "• DIRECCIÓN / ESTACIONAMIENTO",
        "• MENÚ / ESPECIALES",
        "• ALERGIAS / GLUTEN / MARISCOS",
        "• HAPPY HOUR / BEBIDAS",
        "• RESERVACIÓN / CAMBIAR / CANCELAR",
        "• PARA LLEVAR",
        "• CATERING / EVENTO PRIVADO",
        "• GRUPOS GRANDES",
        "• HUMANO (llamar al restaurante)",
      ].join("\n");
    }
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

  if (isSideSwap(text)) {
    const otherHits = findAllFaq(lower).filter((i) => i.id !== "side-swap");
    const parts = [sideSwapAnswer()];
    for (const hit of otherHits) parts.push(resolveAnswer(hit));
    if (isSeatingPreference(text)) parts.push(MANAGER_OPTION);
    return parts.join("\n\n");
  }

  const partySize = extractPartySize(text);
  const askingLargeParty =
    /\b(how big|max party|largest party|party size limit|how many people can|how large|big group|large group|large party|grupo grande|cu[aá]ntas personas|mesa para (1[3-9]|[2-9]\d))\b/i.test(
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

  return lang === "es"
    ? `¡Gracias por escribir a ${restaurant.name}! Aún no estoy seguro de eso. Prueba HORARIO, MENÚ, ESPECIALES, ALERGIAS, RESERVACIÓN, PARA LLEVAR o CATERING — o llámanos al ${restaurant.phone}.`
    : `Thanks for texting ${restaurant.name}! I'm not sure on that one yet. Try HOURS, MENU, SPECIALS, ALLERGIES, RESERVATION, TO-GO, or CATERING — or call us at ${restaurant.phone}.`;
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
