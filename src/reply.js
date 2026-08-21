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
const happyHour = JSON.parse(
  readFileSync(join(__dirname, "../knowledge/happy-hour.json"), "utf8")
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
  else if (item.type === "happy-hour" || item.id === "happy-hour" || item.id === "hh-food")
    answer = happyHourAnswer();
  else if (item.id === "party-size-max") answer = largePartyAnswer();
  else if (item.id === "parking" || item.id === "parking-fee")
    answer = parkingAnswer();
  else answer = item.answer || restaurant.callUs;
  return withAllergyDisclaimer(answer, item);
}

function parkingAnswer(lang = "en") {
  if (lang === "es") {
    return "Tenemos bastante estacionamiento frente a nuestro local.";
  }
  return (
    restaurant.parking ||
    "We have plenty of parking in front of our store."
  );
}

/** Happy Hour menu (NOT chalkboard specials). */
function happyHourAnswer(lang = "en") {
  const days = happyHour.days || restaurant.happyHour?.days || "Sunday–Friday";
  const hours = happyHour.hours || restaurant.happyHour?.hours || "3pm–6pm";
  const drinks = (happyHour.drinks || [])
    .map((d) => `• ${d.name}${d.price ? ` — ${d.price}` : ""}`)
    .join("\n");
  const food = (happyHour.food || [])
    .map((d) => `• ${d.name}${d.price ? ` — ${d.price}` : ""}`)
    .join("\n");

  if (lang === "es") {
    return [
      `Happy Hour: ${days}, ${hours}.`,
      "(Esto es el menú de Happy Hour — diferente de los especiales del pizarrón.)",
      "",
      "Bebidas:",
      drinks || "• Pregunta a tu mesero por la lista de hoy",
      "",
      "Comida / small plates:",
      food || "• Pregunta a tu mesero por la lista de hoy",
      "",
      `Más info: ${happyHour.sourceUrl || restaurant.website}`,
    ].join("\n");
  }

  return [
    `Happy Hour: ${days}, ${hours}.`,
    "(This is the Happy Hour menu — separate from chalkboard specials.)",
    "",
    "Drinks:",
    drinks || "• Ask your server for today’s HH list",
    "",
    "Food / small plates:",
    food || "• Ask your server for today’s HH list",
    "",
    `More: ${happyHour.sourceUrl || restaurant.website}`,
  ].join("\n");
}

function asksHappyHour(text) {
  return /\b(happy\s*hour|hh\b|drink specials?|half off wine)\b/i.test(text);
}

function asksParking(text) {
  return /\b(parking|park nearby|estacionamiento|where (do|can) i park)\b/i.test(
    text
  );
}

function extractPartySize(text) {
  const m =
    String(text).match(
      /\b(?:party of|table for|group of|grupo de|party for|reservation for|reservations? for|mesa para|reservaci[oó]n para)\s*(\d{1,2})\b/i
    ) ||
    String(text).match(/\b(?:make a reservation|book(?:ing)?|reservar)\s+for\s+(\d{1,2})\b/i) ||
    String(text).match(/\b(\d{1,2})\s*(?:people|guests|of us|personas)\b/i);
  return m ? Number(m[1]) : null;
}

function isSeatingPreference(text) {
  return /\b(booth|window seat|bar seat|specific (table|booth|seat)|quiet (corner|table|spot)|near the (tv|bar|kitchen|window)|prefer to sit|seating preference|high top|high-top|cabina)\b/i.test(
    text
  );
}

function isSideSwap(text) {
  const t = String(text || "");
  if (
    /\b(change|changed|swap|swapped|switch|switched|substitut|replace|replaced|different|another|switch out|change out|swap out).{0,40}\bsides?\b|\bsides?\b.{0,40}\b(change|changed|swap|swapped|switch|switched|substitut|replace|replaced|different|another)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(cambiar|cambiamos|cambien|cambio|sustituir|substituir|reemplazar)\b/i.test(t) &&
    /\b(papas?|papa|fries|potato|potatoes|ensalada|salad|sides?|guarnici[oó]n|guarniciones|pure|pur[eé]|arroz|frijoles|spinach|espinaca|broccoli|br[oó]coli|mac)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(papas?|fries|potato|potatoes).{0,40}\b(por|for|con)\s+(ensalada|salad|vegetable|verdura)/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function sideSwapAnswer(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.sideSubstitutionsEs ||
      "Sí — podemos cambiar cualquier guarnición (side) por otras guarniciones que tengamos listadas. Dile a tu mesero cuál prefieres."
    );
  }
  return (
    restaurant.policies?.sideSubstitutions ||
    "Yes — we can change out any side item for our other side items that we have listed. Tell your server (or note it on your to-go order) which listed side you’d like instead."
  );
}

function asksGluten(text) {
  return /\b(gluten|celiac|cel[ií]aco|sin gluten)\b/i.test(text);
}

function asksFryerCrossContact(text) {
  return /\b(fryer|freidora|same oil|shared oil|aceite|cross[- ]?contam|contaminaci[oó]n|empanizado|breaded chicken|pollo empanizado|same fryer|misma freidora)\b/i.test(
    text
  );
}

function glutenFryerAnswer(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.glutenFryerEs ||
      "Tenemos menú sin gluten. Para freidora / contaminación cruzada, avisa a tu mesero o llama a un manager."
    );
  }
  return (
    restaurant.policies?.glutenFryer ||
    "We offer a gluten-free menu. For fryer / cross-contact questions, tell your server or call a manager."
  );
}

function allergyDisclaimer(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.allergyDisclaimerEs ||
      "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada."
    );
  }
  return ALLERGY_DISCLAIMER;
}

function partyBookingAnswer(partySize, text, lang = "en") {
  const tonight = /\b(tonight|esta noche|esta\s+noche|hoy en la noche)\b/i.test(text);
  if (partySize != null && partySize > MAX_ONLINE_PARTY) {
    return largePartyAnswer(partySize);
  }
  if (partySize != null && partySize >= 1) {
    if (lang === "es") {
      return tonight
        ? `Un grupo de ${partySize} está bien para reservar aquí (máximo ${MAX_ONLINE_PARTY}). Para esta noche, escribe “quiero una reservación” y te tomo adultos/niños, hora, y booth / mesa / patio.`
        : `Un grupo de ${partySize} está bien para reservar aquí (máximo ${MAX_ONLINE_PARTY}). Escribe “quiero una reservación” y te ayudo a completar los detalles.`;
    }
    return tonight
      ? `A party of ${partySize} works for booking here (max ${MAX_ONLINE_PARTY}). For tonight, say “I want a reservation” and I’ll take adults/kids, time, and booth / table / patio.`
      : `A party of ${partySize} works for booking here (max ${MAX_ONLINE_PARTY}). Say “I want a reservation” and I’ll help finish the details.`;
  }
  return null;
}

/**
 * Compose a reliable multi-part answer (party + sides + gluten/fryer + HH + parking)
 * in English or Spanish without waiting on AI.
 */
function composeMultiPartReply(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  if (!text) return null;

  const parts = [];
  const partySize = extractPartySize(text);
  const partyBit = partyBookingAnswer(partySize, text, lang);
  if (partyBit) parts.push(partyBit);

  if (isSideSwap(text)) parts.push(sideSwapAnswer(lang));
  if (asksHappyHour(text)) parts.push(happyHourAnswer(lang));
  if (asksParking(text)) parts.push(parkingAnswer(lang));

  if (asksGluten(text) || asksFryerCrossContact(text)) {
    parts.push(glutenFryerAnswer(lang));
    parts.push(allergyDisclaimer(lang));
  }

  const lower = text.toLowerCase();
  const skip = new Set([
    "side-swap",
    "gluten",
    "party-size-max",
    "party-of-6",
    "happy-hour",
    "hh-food",
    "parking",
    "parking-fee",
  ]);
  const extra = findAllFaq(lower).filter((i) => {
    if (skip.has(i.id)) return false;
    if (asksHappyHour(text) && (i.type === "hours" || i.id === "hours" || i.id === "open-now")) {
      return false;
    }
    return true;
  });
  for (const hit of extra.slice(0, 2)) {
    const ans = resolveAnswer(hit);
    if (ans && !parts.some((p) => p.includes(ans.slice(0, 40)))) {
      parts.push(ans);
    }
  }

  if (!parts.length) return null;
  return parts.join("\n\n");
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
      ? `¡Hola! ¿En qué puedo ayudarte hoy?`
      : `Hello! How can I help you today?`;
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
    const parts = [sideSwapAnswer(lang)];
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
  composeMultiPartReply,
  happyHourAnswer,
  parkingAnswer,
  asksHappyHour,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
  MANAGER_OPTION,
  withAllergyDisclaimer,
};
