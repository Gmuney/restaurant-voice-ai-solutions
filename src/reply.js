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
const pastSpecials = JSON.parse(
  readFileSync(join(__dirname, "../knowledge/past-specials.json"), "utf8")
);

const MAX_ONLINE_PARTY =
  restaurant.policies?.maxOnlinePartySize ??
  restaurant.reservations?.maxOnlinePartySize ??
  6;

const ALLERGY_DISCLAIMER =
  restaurant.policies?.allergyDisclaimer ||
  "Please notify your server of severe allergies upon arrival so our kitchen can take extra precautions against cross-contamination.";

const ALLERGY_DISCLAIMER_ES =
  restaurant.policies?.allergyDisclaimerEs ||
  "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada.";

const MANAGER_OPTION =
  restaurant.policies?.managerOption ||
  `If you need something custom, ask for a manager when you call or arrive — or call ${restaurant.phone}.`;

/** Online booking allowed for parties of 1..MAX; parties of (MAX+1)+ must call management. */
const LARGE_PARTY_MIN = MAX_ONLINE_PARTY + 1; // 8 when max online is 7

function isLargeOnlineParty(partySize) {
  return partySize != null && Number(partySize) >= LARGE_PARTY_MIN;
}

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

function largePartyAnswer(partySize = null, lang = "en") {
  return managerEscalationLine(lang);
}

function managerEscalationLine(lang = "en") {
  // Guest-facing only — never include phones, alert banners, or internal log text
  if (lang === "es") {
    return (
      restaurant.reservations?.managerEscalationEs ||
      "Para reservaciones de grupo de este tamaño (o para hablar con gerencia), estoy alertando a nuestro equipo ahora mismo. Por favor quédate en la línea mientras te conecto con un manager."
    );
  }
  return (
    restaurant.reservations?.managerEscalation ||
    "For group reservations of this size (or to speak with management), I am alerting our team right now. Please stay on the line while I connect you to a manager."
  );
}

function asksManagerEscalation(text) {
  const t = String(text || "");
  return (
    /\b(speak (to|with)|talk to|ask for|get me|need|want|can i (speak|talk)|quisiera hablar|quiero hablar|hablar con|puedo hablar).{0,30}\b(manager|owner|gerente|due[nñ]o|dueña|management)\b/i.test(
      t
    ) ||
    /\b(manager|owner|gerente|due[nñ]o|dueña)\s+(please|por favor|now|ahora)\b/i.test(
      t
    ) ||
    /\b(manager please|owner please|ask (for )?a manager|get (a |the )?manager|real person|talk to (a )?human|humano|una persona)\b/i.test(
      t
    ) ||
    /\b(manager|owner|gerente)\b.{0,20}\b(please|por favor|now|ahora)\b/i.test(t)
  );
}

function needsManagerEscalation(text) {
  return isLargeOnlineParty(extractPartySize(text)) || asksManagerEscalation(text);
}

function hasAllergyDisclaimer(text) {
  const t = String(text || "");
  if (!t) return false;
  if (t.includes(ALLERGY_DISCLAIMER) || t.includes(ALLERGY_DISCLAIMER_ES)) {
    return true;
  }
  return (
    /notify your server of severe allergies/i.test(t) ||
    /avise a su mesero de alergias graves/i.test(t)
  );
}

/**
 * Keep allergy/fryer safety language once, woven into menu copy —
 * never leave a second standalone disclaimer block at the end.
 */
function ensureSingleAllergyDisclaimer(text, lang = "en") {
  let body = String(text || "").trim();
  if (!body) return body;
  const both = [ALLERGY_DISCLAIMER, ALLERGY_DISCLAIMER_ES].filter(Boolean);

  for (const d of both) {
    let first = body.indexOf(d);
    while (first !== -1) {
      const second = body.indexOf(d, first + d.length);
      if (second === -1) break;
      body = (body.slice(0, second) + body.slice(second + d.length))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      first = body.indexOf(d);
    }
  }
  if (body.includes(ALLERGY_DISCLAIMER) && body.includes(ALLERGY_DISCLAIMER_ES)) {
    const drop = lang === "es" ? ALLERGY_DISCLAIMER : ALLERGY_DISCLAIMER_ES;
    body = body.replace(drop, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Strip a trailing standalone disclaimer paragraph (already said in menu section)
  const disc = lang === "es" ? ALLERGY_DISCLAIMER_ES : ALLERGY_DISCLAIMER;
  const trailing = new RegExp(
    `(?:\\n\\n)+${disc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`
  );
  const withoutTrailing = body.replace(trailing, "").trim();
  if (withoutTrailing !== body && hasAllergyDisclaimer(withoutTrailing)) {
    body = withoutTrailing;
  }
  return body;
}

/** Weave disclaimer into menu/allergy copy once — not a new trailing block. */
function withAllergyDisclaimer(text, item, lang = "en") {
  if (!item || !ALLERGY_FAQ_IDS.has(item.id)) return text;
  let body = String(text || "").trim();
  if (hasAllergyDisclaimer(body)) {
    return ensureSingleAllergyDisclaimer(body, lang);
  }
  const disc = lang === "es" ? ALLERGY_DISCLAIMER_ES : ALLERGY_DISCLAIMER;
  // Same section / same paragraph flow — no standalone footer block
  body = `${body.replace(/\s+$/, "")} ${disc}`;
  return ensureSingleAllergyDisclaimer(body, lang);
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

function resolveAnswer(item, lang = "en") {
  let answer;
  if (item.type === "hours") answer = hoursAnswer();
  else if (item.type === "happy-hour" || item.id === "happy-hour" || item.id === "hh-food")
    answer = happyHourAnswer(lang);
  else if (
    item.type === "large-party" ||
    item.id === "party-size-max"
  )
    answer = largePartyAnswer(null, lang);
  else if (item.id === "parking" || item.id === "parking-fee")
    answer = parkingAnswer(lang);
  else answer = item.answer || restaurant.callUs;
  return withAllergyDisclaimer(answer, item, lang);
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
  return lang === "es" ? ALLERGY_DISCLAIMER_ES : ALLERGY_DISCLAIMER;
}

function partyBookingAnswer(partySize, text, lang = "en") {
  const tonight = /\b(tonight|esta noche|esta\s+noche|hoy en la noche)\b/i.test(text);
  if (isLargeOnlineParty(partySize)) {
    return largePartyAnswer(partySize, lang);
  }
  if (partySize != null && partySize >= 1) {
    if (lang === "es") {
      return tonight
        ? `Un grupo de ${partySize} está bien para reservar aquí (máximo ${MAX_ONLINE_PARTY} en línea). Para esta noche, escribe “quiero una reservación” y te tomo adultos/niños, hora, y booth / mesa / patio.`
        : `Un grupo de ${partySize} está bien para reservar aquí (máximo ${MAX_ONLINE_PARTY} en línea). Escribe “quiero una reservación” y te ayudo a completar los detalles.`;
    }
    return tonight
      ? `A party of ${partySize} works for booking here (online max ${MAX_ONLINE_PARTY}). For tonight, say “I want a reservation” and I’ll take adults/kids, time, and booth / table / patio.`
      : `A party of ${partySize} works for booking here (online max ${MAX_ONLINE_PARTY}). Say “I want a reservation” and I’ll help finish the details.`;
  }
  return null;
}

/**
 * Dual-action escalation reply (GUEST chat only):
 * 1) Answer safe standard bits (hours, patio, sides, parking, HH)
 * 2) Smooth handoff line — no phones, no call-the-store, no internal alert text
 */
function composeEscalationReply(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  const parts = [];

  if (
    /\b(hours?|open|closed|horario|horarios|abiertos?|cerrados?)\b/i.test(text)
  ) {
    // Hours for guests on an active handoff — no phone (they're already on the line)
    const status = isOpenNow();
    const openLine = status.open
      ? lang === "es"
        ? `Estamos ABIERTOS ahora (${status.day}).`
        : `We're OPEN now (${status.day}).`
      : lang === "es"
        ? `Estamos CERRADOS ahora (${status.day}).`
        : `We're CLOSED right now (${status.day}).`;
    parts.push(
      `${openLine} ${lang === "es" ? "Horario" : "Hours"}: ${restaurant.hours.display}`
    );
  }
  if (asksParking(text)) parts.push(parkingAnswer(lang));
  if (asksHappyHour(text)) parts.push(happyHourAnswer(lang));
  if (isSideSwap(text)) parts.push(sideSwapAnswer(lang));
  if (/\b(patio|outdoor|outside seating|terraza)\b/i.test(text)) {
    parts.push(
      lang === "es"
        ? "Sí — podemos anotar preferencia de patio / terraza; la disponibilidad cambia con el clima y la demanda."
        : "Yes — we can note a patio preference; availability can change with weather and demand."
    );
  }

  parts.push(managerEscalationLine(lang));
  return sanitizeGuestEscalationReply(
    ensureSingleAllergyDisclaimer(parts.filter(Boolean).join("\n\n"), lang)
  );
}

/** Strip internal alert banners / store call prompts from guest-facing escalation text. */
function sanitizeGuestEscalationReply(text) {
  let body = String(text || "");
  body = body.replace(/^.*MANAGER ALERT.*$/gim, "");
  body = body.replace(/🚨/g, "");
  // Do not instruct the guest to call while already on the line
  body = body.replace(
    /\s*(Please call us directly at[^.\n]*\.?|Por favor llámanos directamente al[^.\n]*\.?|call us directly at\s*\(?\d[\d\s.()-]{7,}\)?[^.]*\.?)/gi,
    ""
  );
  body = body.replace(/\bPhone:\s*\(?\d[\d\s.()-]{7,}\)?/gi, "");
  body = body.replace(/\bTel[eé]fono:\s*\(?\d[\d\s.()-]{7,}\)?/gi, "");
  body = body.replace(/\(210\)\s*455-3474/g, "");
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return body;
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
    // glutenFryerAnswer already weaves shared-fryer + allergy safety once in the menu section
    parts.push(glutenFryerAnswer(lang));
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
    // Avoid a second allergy/gluten FAQ block when menu section already covered it
    if (
      (asksGluten(text) || asksFryerCrossContact(text)) &&
      ALLERGY_FAQ_IDS.has(i.id)
    ) {
      return false;
    }
    if (asksHappyHour(text) && (i.type === "hours" || i.id === "hours" || i.id === "open-now")) {
      return false;
    }
    return true;
  });
  for (const hit of extra.slice(0, 2)) {
    const ans = resolveAnswer(hit, lang);
    if (ans && !parts.some((p) => p.includes(ans.slice(0, 40)))) {
      parts.push(ans);
    }
  }

  if (!parts.length) return null;
  // Never add a standalone disclaimer footer — safety lives in the menu section only
  return ensureSingleAllergyDisclaimer(parts.join("\n\n"), lang);
}

function isCustomKitchenMod(text) {
  if (isSideSwap(text)) return false;
  return /\b(substitut|modify|modification|custom (order|request)|special request|leave off|hold the|no onions?|extra crispy|make it without|can you (make|do|prepare)|blacken|topped with|pontchartrain)\b/i.test(
    text
  );
}

function asksPastSpecial(text) {
  const t = String(text || "");
  if (
    /\b(past|previous|last week'?s?|other day|other night|that|old)\b.{0,40}\bspecials?\b|\bspecials?\b.{0,40}\b(past|previous|last week|other day|other night)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\bpontchartrain\b/i.test(t)) return true;
  for (const item of pastSpecials.items || []) {
    for (const m of item.match || []) {
      if (m && t.toLowerCase().includes(String(m).toLowerCase())) return true;
    }
  }
  return false;
}

function findPastSpecialMatch(text) {
  const lower = String(text || "").toLowerCase();
  for (const item of pastSpecials.items || []) {
    for (const m of item.match || []) {
      if (m && lower.includes(String(m).toLowerCase())) return item;
    }
  }
  return null;
}

/**
 * Past chalkboard specials — host matchmaking tone:
 * welcome that specials rotate → immediate concrete build (never ask for flavors)
 * → one smooth side-swap line. Keep to 3–4 sentences; no phones/links/disclaimers.
 */
function answerPastSpecialOrCustomMod(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  if (!text) return null;

  const hit = findPastSpecialMatch(text);
  const pastAsk = asksPastSpecial(text);
  const customAsk = isCustomKitchenMod(text) && !isSeatingPreference(text);

  if (
    !hit &&
    !pastAsk &&
    !(
      customAsk &&
      /\b(redfish|pontchartrain|salmon|pasta|blackboard|chalkboard|special)\b/i.test(
        text
      )
    )
  ) {
    return null;
  }

  if (hit) {
    const canned =
      lang === "es"
        ? hit.hostReplyEs || hit.hostReply
        : hit.hostReply;
    if (canned) return canned;
  }

  // Keyword-based proactive match when no catalog hit (still never ask them to guess)
  const proactive = proactivePastSpecialMatch(text, lang);
  if (proactive) return proactive;

  return lang === "es"
    ? pastSpecials.genericHostMatchEs || pastSpecials.genericHostMatch
    : pastSpecials.genericHostMatch;
}

/** Immediate concrete build from guest keywords — never “list your flavors.” */
function proactivePastSpecialMatch(text, lang) {
  const t = String(text || "").toLowerCase();
  const side =
    lang === "es"
      ? pastSpecials.sideSwapReminderEs || pastSpecials.sideSwapReminder
      : pastSpecials.sideSwapReminder;

  if (/\b(pasta|fettuccine|linguini|linguine|penne)\b/i.test(t) && /\bsalmon\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales de pasta del pizarrón rotan, así que ese plato exacto no está en el board de hoy. ¡Pero sí podemos blacken nuestro Salmon fresco y mezclarlo con pasta en salsa ajo-crema o cajún para esos mismos sabores. ${side}`
      : `Our chalkboard pasta specials rotate, so that exact dish isn’t on today’s board! However, we can blacken our fresh Salmon and toss it with pasta in a garlic-cream or Cajun sauce to match those exact flavors. ${side}`;
  }
  if (/\bpasta\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales de pasta del pizarrón rotan, así que ese plato exacto no está en el board de hoy. ¡Pero sí podemos preparar pescado o camarón blackened con pasta en salsa ajo-crema o estilo cajún. ${side}`
      : `Our chalkboard pasta specials rotate, so that exact dish isn’t on today’s board! However, we can do blackened fish or shrimp tossed with pasta in a garlic-cream or Cajun-style sauce. ${side}`;
  }
  if (/\bsalmon\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales del pizarrón rotan, así que ese salmon especial puede no estar hoy. ¡Pero sí podemos blacken o asar nuestro Salmon fresco con un acabado ajo-crema o cajún para acercarnos a esos sabores. ${side}`
      : `Our chalkboard specials rotate, so that exact salmon special may not be on today’s board! However, we can blacken or grill our fresh Salmon with a garlic-cream or Cajun finish to match those flavors. ${side}`;
  }
  if (/\bredfish|red fish\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales del pizarrón rotan, así que ese redfish especial puede no estar hoy. ¡Pero sí podemos blacken nuestro Texas Redfish y acompañarlo con camarón, mantequilla de crawfish o sazón cajún. ${side}`
      : `Our chalkboard specials rotate, so that exact redfish special may not be on today’s board! However, we can blacken our Texas Redfish and finish it with shrimp, crawfish butter, or Cajun seasoning. ${side}`;
  }
  return null;
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
    const pastCombo = answerPastSpecialOrCustomMod(text, { language: lang });
    if (pastCombo && asksPastSpecial(text)) return pastCombo;
    const otherHits = findAllFaq(lower).filter((i) => i.id !== "side-swap");
    const parts = [sideSwapAnswer(lang)];
    for (const hit of otherHits) parts.push(resolveAnswer(hit));
    if (isSeatingPreference(text)) parts.push(MANAGER_OPTION);
    return parts.join("\n\n");
  }

  const pastOrCustom = answerPastSpecialOrCustomMod(text, { language: lang });
  if (pastOrCustom) return pastOrCustom;

  const partySize = extractPartySize(text);
  const askingLargeParty =
    /\b(how big|max party|largest party|party size limit|how many people can|how large|big group|large group|large party|grupo grande|cu[aá]ntas personas|mesa para (8|9|[1-9]\d)|table for (8|9|[1-9]\d)|party of (8|9|[1-9]\d))\b/i.test(
      text
    ) || isLargeOnlineParty(partySize);

  if (askingLargeParty && (partySize == null || isLargeOnlineParty(partySize))) {
    const otherHits = findAllFaq(lower).filter(
      (i) => !["party-size-max", "party-of-6", "reservations-yes"].includes(i.id)
    );
    const parts = [largePartyAnswer(partySize, lang)];
    for (const hit of otherHits) {
      parts.push(resolveAnswer(hit, lang));
    }
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    return ensureSingleAllergyDisclaimer(parts.join("\n\n"), lang);
  }

  const hits = findAllFaq(lower);
  if (hits.length >= 2) {
    const parts = hits.map((h) => resolveAnswer(h, lang));
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    // Disclaimer is woven into allergy/menu FAQ answers — never a trailing standalone block
    return ensureSingleAllergyDisclaimer(parts.join("\n\n"), lang);
  }

  if (hits.length === 1) {
    let answer = resolveAnswer(hits[0], lang);
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      answer = managerFallbackAnswer([answer]);
    }
    return ensureSingleAllergyDisclaimer(answer, lang);
  }

  // No FAQ hit — seating still gets manager fallback; food custom mods try past-special rule first
  const pastFallback = answerPastSpecialOrCustomMod(text, { language: lang });
  if (pastFallback) return pastFallback;
  if (isSeatingPreference(text)) {
    return managerFallbackAnswer([
      `I can help with hours, menu, specials, allergies, and reservations from our knowledge base.`,
    ]);
  }
  if (isCustomKitchenMod(text)) {
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
  composeEscalationReply,
  needsManagerEscalation,
  asksManagerEscalation,
  managerEscalationLine,
  happyHourAnswer,
  parkingAnswer,
  asksHappyHour,
  answerPastSpecialOrCustomMod,
  asksPastSpecial,
  isLargeOnlineParty,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
  ALLERGY_DISCLAIMER_ES,
  ensureSingleAllergyDisclaimer,
  hasAllergyDisclaimer,
  MANAGER_OPTION,
  withAllergyDisclaimer,
};
