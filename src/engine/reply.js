import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_DIR } from "../paths.js";
import { getSoldOut, findReinstatedMatch, findSoldOutMatch } from "../store.js";
import { hasClearSpanish, isPureGreeting, isTexasEnglishSlang } from "./language.js";
import { asksDishAllergen, dishAllergenReply } from "./dish-allergen.js";
import { findPayloadDish, spokenPayloadDishDetail } from "./board-payload.js";

const restaurant = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "restaurant.json"), "utf8")
);
const faq = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "faq.json"), "utf8")
);
const happyHour = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "happy-hour.json"), "utf8")
);
const pastSpecials = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "past-specials.json"), "utf8")
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

const HOST_NAME = restaurant.hostName || "Shelly";
const CALL_OPENING_TEXT =
  "Thank you for calling Fish City Grill Culebra, this is Shelly. How can I help you today?";
const CALL_OPENING = `(${CALL_OPENING_TEXT})`;
const CALL_OPENING_ES =
  restaurant.callOpeningEs || "¿En qué puedo ayudarle hoy?";
const CALL_SIGNOFF =
  "Thank you for calling Fish City Grill Culebra! Have a wonderful day!";
const SESSION_TERMINATED_FLAG = "[SESSION_TERMINATED]";

function asksSessionReset(text) {
  return /^(end|reset|restart|start over|clear session|clearsession|clear_session|cancelar todo|reiniciar sesi[oó]n)([.!?]*)?$/i.test(
    String(text || "").trim()
  );
}

function sessionTerminatedReply() {
  return `${CALL_SIGNOFF}\n\n${SESSION_TERMINATED_FLAG}`;
}

/** Automated line opening — exact English greeting in parentheses, then the host reply. */
function withCallOpening(reply) {
  const prefix = CALL_OPENING;
  const body = String(reply || "").trim();
  if (!body) return prefix;
  if (body.startsWith(prefix)) return body;
  if (body === CALL_OPENING_TEXT) return prefix;
  return `${prefix}\n\n${body}`;
}

/** Remove the mandated greeting if a later turn (or the model) repeated it. */
function stripCallOpening(reply) {
  let body = String(reply || "").trim();
  if (body.startsWith(CALL_OPENING)) {
    body = body.slice(CALL_OPENING.length).replace(/^\s+/, "").trim();
  }
  if (body.startsWith(CALL_OPENING_TEXT)) {
    body = body.slice(CALL_OPENING_TEXT.length).replace(/^\s+/, "").trim();
  }
  return body;
}

/** Landline voice — never read a URL, website, or inventory debug. */
function stripSpokenUrls(text) {
  let body = String(text || "");
  body = body.replace(/https?:\/\/\S+/gi, "");
  body = body.replace(/\bwww\.[^\s.,;:]+/gi, "");
  body = body.replace(/\b[\w-]*fishcitygrill\.[^\s.,;:]+/gi, "");
  body = body.replace(/\b[\w-]*olo\.com[^\s.,;:]*/gi, "");
  body = body.replace(/\b[\w-]*cardfoundry\.[^\s.,;:]+/gi, "");
  body = body.replace(/\(?\s*(?:demo\s+)?86 board[^.()\n]*/gi, "");
  body = body.replace(/\beveryday menu\b/gi, "menu");
  body = body.replace(/\bSide option\.?/gi, "");
  body = body.replace(/\bmarked sold out on today's[^.!\n]*/gi, "");
  body = body.replace(/\bun-?86\b/gi, "");
  body = body.replace(/\bmiddleware\b/gi, "");
  body = body.replace(/\bsystem flag\b/gi, "");
  body = body.replace(/[ \t]+\n/g, "\n");
  body = body.replace(/\n{3,}/g, "\n\n");
  body = body.replace(/[ \t]{2,}/g, " ");
  body = body.replace(/[ \t]+([.,!?;:])/g, "$1");
  return body.trim();
}

/** Turn 1: prefix. Later turns: never repeat the parenthetical greeting. */
function applyCallOpening(reply, initial) {
  const raw = stripSpokenUrls(String(reply || "").trim());
  if (raw.includes(SESSION_TERMINATED_FLAG)) return raw;
  const cleaned = stripCallOpening(raw);
  return initial ? withCallOpening(cleaned) : cleaned;
}

/** Turn-1 greeting uses the automated line; later greetings stay in the guest language only. */
function greetingReply(lang = "en", initial = true) {
  if (initial) {
    return lang === "es" ? withCallOpening(CALL_OPENING_ES) : CALL_OPENING;
  }
  return lang === "es" ? CALL_OPENING_ES : "How can I help you today?";
}

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

const WEEKEND_CLOSE_DAYS = new Set(["friday", "saturday"]);

/** Kitchen + restaurant close 10:00 PM Fri–Sat, 9:00 PM Sun–Thu. */
function closingClockForDay(day) {
  const d = String(day || "").toLowerCase();
  return WEEKEND_CLOSE_DAYS.has(d) ? "10:00 PM" : "9:00 PM";
}

function displayWeekday(day, lang = "en") {
  const d = String(day || "").toLowerCase();
  if (lang === "es") {
    return (
      {
        monday: "lunes",
        tuesday: "martes",
        wednesday: "miércoles",
        thursday: "jueves",
        friday: "viernes",
        saturday: "sábado",
        sunday: "domingo",
      }[d] || d
    );
  }
  if (!d) return "today";
  return d.charAt(0).toUpperCase() + d.slice(1);
}

function closingHoursAnswer(lang = "en", day = null) {
  const weekday = String(day || nowInRestaurantTz().day || "").toLowerCase();
  const clock = closingClockForDay(weekday);
  const name = displayWeekday(weekday, lang);
  if (lang === "es") {
    return `Como hoy es ${name}, nuestra cocina y restaurante cierran a las ${clock} esta noche.`;
  }
  return `Since today is ${name}, our kitchen and restaurant close at ${clock} tonight!`;
}

function foldForMatch(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** True for direct HOURS / open-now questions in EN or ES (typos/accents OK). */
function asksHours(text) {
  const t = foldForMatch(text);
  // Happy Hour alone is not restaurant hours
  if (
    /\b(happy\s*hour|hh)\b/.test(t) &&
    !/\b(horario|hours|abierto|cerrado|open|closed)\b/.test(t)
  ) {
    return false;
  }

  const en =
    /\b(what (are )?your hours|your hours|hours of operation|operating hours|store hours|restaurant hours)\b/.test(
      t
    ) ||
    /\b(is the restaurant open|is restaurant open|restaurant open|are you (guys |yall )?open|are yall open|yall open|you open|open right now|open now|open rn|still open|are we open)\b/.test(
      t
    ) ||
    /\b(when do you (open|close)|what time do you (open|close)|closing time|opening time)\b/.test(
      t
    ) ||
    /\b(what time do y'?all (open|close)|when do y'?all (open|close)|y'?all close)\b/.test(
      t
    ) ||
    /\b(what time does (the )?(kitchen|restaurant) close|kitchen close|close tonight|how late|open until)\b/.test(
      t
    ) ||
    /^(hours)\b/.test(t.trim());

  // Spanish + informal / missing accents: "esta abierto", "a que hora cierran", "horario"
  const es =
    /\b(horario|horarios)\b/.test(t) ||
    /\b(a que hora (abren|cierran)|que hora (abren|cierran)|hora de (apertura|cierre)|cuando (abren|cierran))\b/.test(
      t
    ) ||
    /\b(esta|estan|este|el)?\s*(el )?restaurante\s+(esta\s+)?(abierto|cerrado)\b/.test(
      t
    ) ||
    /\b(esta|estan)\s+(abierto|abiertos|cerrado|cerrados)\b/.test(t) ||
    /\b(abiertos?|abiertas?|cerrados?|cerradas?)\b/.test(t) ||
    /\b(abren|cierran)\b/.test(t) ||
    /\b(abiertos? ahora|cerrados? ahora)\b/.test(t) ||
    /\b(hasta que hora|a que hora tienen|tienen abierta|abierta la cocina|cocina (hoy|abierta)|hora tienen)\b/.test(
      t
    ) ||
    /^(horario|horarios|abierto|abiertos|cerrado|cerrados)\b/.test(t.trim());

  return en || es;
}

/** Close tonight / kitchen close — use today's weekday closing time. */
function asksClosingHours(text) {
  const t = foldForMatch(text);
  return (
    /\b(what time|when).{0,24}\b(do |does )?(y'?all |you |the )?(kitchen |restaurant )?(close|closing)\b/.test(
      t
    ) ||
    /\b(close|closing|cierran|cierre).{0,20}\b(tonight|today|esta noche|hoy)\b/.test(
      t
    ) ||
    /\b(kitchen|restaurante?).{0,24}\b(close|closing|cierran)\b/.test(t) ||
    /\b(closing time|hora de cierre|a que hora cierran|que hora cierran|cuando cierran)\b/.test(
      t
    ) ||
    /\b(y'?all|you) close\b/.test(t) ||
    /\b(how late|open until)\b/.test(t) ||
    /\b(hasta que hora|tienen abierta|abierta la cocina|cocina hoy|hora de la cocina)\b/.test(
      t
    ) ||
    (/\bcocina\b/.test(t) &&
      /\b(hora|abierta|hoy|cierran|cierre|hasta)\b/.test(t))
  );
}

/** Prefer the language of this hours question over sticky chat language. */
function hoursReplyLanguage(text, fallback = "en") {
  if (isTexasEnglishSlang(text) && !hasClearSpanish(text)) return "en";
  if (hasClearSpanish(text) && !isTexasEnglishSlang(text)) {
    const t = foldForMatch(text);
    if (
      /\b(horario|horarios|abierto|cerrado|abren|cierran|a que hora|que hora|hasta que hora|cocina)\b/.test(
        t
      )
    ) {
      return "es";
    }
  }

  const t = foldForMatch(text);
  const esCue =
    /\b(horario|horarios|abierto|abiertos|abierta|cerrado|cerrados|a que hora|hasta que hora|que hora abren|que hora cierran|cocina|hola|buenas)\b/.test(
      t
    );
  const enCue =
    /\b(hours|open|closed|restaurant open|are you|is the|what time|what are|yall|howdy)\b/.test(
      t
    );
  if (esCue && !enCue) return "es";
  if (enCue && !esCue) return "en";
  if (enCue && esCue) {
    return hasClearSpanish(text) ? "es" : "en";
  }
  return fallback === "es" ? "es" : "en";
}

/**
 * Direct HOURS reply — closing-tonight uses today's weekday; otherwise weekly schedule.
 */
function hoursAnswer(lang = "en", opts = {}) {
  const text = opts.text || "";
  if (opts.closing === true || (text && asksClosingHours(text))) {
    return closingHoursAnswer(lang, opts.day);
  }

  const status = isOpenNow();
  const withHints = opts.withHints === true;

  if (lang === "es") {
    // Required warm Spanish hours template (no help/options menu, no English mix)
    if (status.open) {
      return "¡Hola! Sí, estamos ABIERTOS hoy. Nuestro horario es de domingo a jueves de 11:00 AM a 9:00 PM, y viernes y sábado de 11:00 AM a 10:00 PM.";
    }
    return "¡Hola! Ahora mismo estamos CERRADOS. Nuestro horario es de domingo a jueves de 11:00 AM a 9:00 PM, y viernes y sábado de 11:00 AM a 10:00 PM.";
  }

  const display = restaurant.hours.display;
  const statusLine = status.open
    ? `We're OPEN right now (${status.day}).`
    : `We're CLOSED right now (${status.day}).`;
  let out = `Our hours are ${display}. ${statusLine}`;
  if (withHints) {
    out += ` I can also help with the menu or a reservation if you need.`;
  }
  return out;
}

function largePartyAnswer(partySize = null, lang = "en") {
  return managerEscalationLine(lang, partySize);
}

function managerEscalationLine(lang = "en", partySize = null) {
  // Guest handoff — no phones / call-the-store prompts
  const n = partySize != null && Number(partySize) >= 1 ? Number(partySize) : null;
  if (lang === "es") {
    if (n) {
      return `Para un evento de grupo de ${n} personas (o para hablar con gerencia), estoy alertando a nuestro equipo ahora mismo. Por favor quédate en la línea mientras te conecto con un gerente.`;
    }
    return (
      restaurant.reservations?.managerEscalationEs ||
      "Para hablar con gerencia, estoy alertando a nuestro equipo ahora mismo. Por favor quédate en la línea mientras te conecto con un gerente."
    );
  }
  if (n) {
    return `For a group event of ${n} guests (or to speak with management), I am alerting our team right now. Please stay on the line while I connect you to a manager.`;
  }
  return (
    restaurant.reservations?.managerEscalation ||
    "To speak with management, I am alerting our team right now. Please stay on the line while I connect you to a manager."
  );
}

const SIM_PHONE_RINGING = "🚨 PHONE RINGING: Transferring guest to Manager...";

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

function asksCateringEscalation(text) {
  return /\b(cater|catering|catered|banquet|private event|evento privado|banquete)\b/i.test(
    text
  );
}

function needsManagerEscalation(text) {
  return (
    isLargeOnlineParty(extractPartySize(text)) ||
    asksManagerEscalation(text) ||
    asksCateringEscalation(text)
  );
}

/** Concise 1–2 sentence answers for safe general/menu questions (before transfer). */
function standardEscalationAnswers(text, lang = "en") {
  const bits = [];
  const asksDog = /\b(dog|dogs|pet|pets|perro|perros|mascota)\b/i.test(text);
  const asksPatio =
    /\b(patio|outdoor|outside seating|terraza|dog-friendly|dog friendly)\b/i.test(
      text
    );

  // Closing / store hours FIRST when combined with manager or party booking
  if (asksHours(text)) {
    const hoursLang = hoursReplyLanguage(text, lang);
    bits.push(hoursAnswer(hoursLang, { text }));
  }

  if (asksDog) {
    bits.push(
      lang === "es"
        ? "¡Sí, nuestro patio admite perros!"
        : "Yes, our patio is dog-friendly!"
    );
  } else if (asksPatio) {
    bits.push(
      lang === "es"
        ? "Sí — podemos anotar preferencia de patio; la disponibilidad cambia con el clima y la demanda."
        : "Yes — we can note a patio preference; availability can change with weather and demand."
    );
  }

  if (asksDishAllergen(text)) {
    bits.push(dishAllergenReply(text, lang));
  } else if (asksGluten(text) || asksFryerCrossContact(text)) {
    bits.push(glutenFryerAnswer(lang));
  } else if (/\b(dairy|lactose|dairy[- ]?free|sin l[aá]cteos|lactosa)\b/i.test(text)) {
    bits.push(
      lang === "es"
        ? `Varios platos se pueden ajustar sin lácteos — avisa a tu mesero de tus necesidades de lácteos o lactosa. ${ALLERGY_DISCLAIMER_ES}`
        : `Many dishes can be adjusted dairy-free — tell your server about dairy or lactose needs when you order. ${ALLERGY_DISCLAIMER}`
    );
  } else if (/\b(shellfish|mariscos)\b/i.test(text)) {
    bits.push(
      lang === "es"
        ? `${restaurant.allergies?.shellfish || "Los mariscos tocan gran parte de la cocina."} ${ALLERGY_DISCLAIMER_ES}`
        : `${restaurant.allergies?.shellfish || "Shellfish touches most of our kitchen."} ${ALLERGY_DISCLAIMER}`
    );
  } else if (/\b(allerg|nut allergy|alergia)\b/i.test(text)) {
    bits.push(
      lang === "es"
        ? `Podemos ayudarte con alergias — avisa a tu mesero al llegar. ${ALLERGY_DISCLAIMER_ES}`
        : `We can help with allergy concerns — tell your server when you arrive. ${ALLERGY_DISCLAIMER}`
    );
  }
  if (asksDishAllergen(text)) bits.push(dishAllergenReply(text, lang));
  else if (asksKidsMeal(text)) bits.push(kidsMealReply(text, lang));
  if (asksParking(text)) bits.push(parkingAnswer(lang));
  if (asksHappyHourReadout(text)) bits.push(happyHourAnswer(lang));
  const hhBurgerEsc = happyHourBurgerReply(text, lang);
  if (hhBurgerEsc) bits.push(hhBurgerEsc);
  else if (isSideSwap(text) && !asksKidsMeal(text)) bits.push(sideSwapAnswer(lang));
  if (asksCateringEscalation(text) && !isLargeOnlineParty(extractPartySize(text))) {
    // Brief catering confirm before transfer — no phone/call prompt
    bits.push(
      lang === "es"
        ? "Sí — ofrecemos banquetes y eventos de grupo."
        : "Yes — we offer catering and group events."
    );
  }

  // Cap at 2 concise sentences/parts for the “standard query” block
  return bits.filter(Boolean).slice(0, 2);
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

function resolveAnswer(item, lang = "en", guestText = "") {
  let answer;
  if (item.type === "hours") answer = hoursAnswer(lang, { text: guestText });
  else if (item.type === "kids-meal" || item.id === "kids-menu")
    answer = kidsMealReply(guestText, lang);
  else if (item.type === "kids-sides" || item.id === "kids-sides")
    answer = kidsMealReply(guestText || "what sides come with that", lang);
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

/** Happy Hour — 2 spoken sentences, drinks and food. Never bullets or a URL. */
function happyHourAnswer(lang = "en") {
  if (lang === "es") {
    return (
      happyHour.spokenEs ||
      "¡La hora feliz es de domingo a viernes, de 3 a 6 de la tarde! Tenemos margaritas Gold y cervezas de barril a cinco dólares, vino por copa a mitad de precio, y especiales de comida como ostiones a dos dólares, calamari crujiente a once dólares, y nuestra hamburguesa doble con tocino y queso a diez dólares."
    );
  }
  return (
    happyHour.spokenEn ||
    "Happy Hour runs Sunday through Friday from 3 to 6 PM! We feature five-dollar Gold Margaritas and draft beers, half-off wine by the glass, plus food specials like two-dollar oysters, eleven-dollar Crispy Calamari, and our ten-dollar Double Bacon Cheeseburger."
  );
}

function asksHappyHour(text) {
  return /\b(happy\s*hour|hh\b|drink specials?|half off wine|hora feliz)\b/i.test(text);
}

/** True only when they asked about Happy Hour itself, not just "happy hour burger". */
function asksHappyHourReadout(text) {
  if (!asksHappyHour(text)) return false;
  const stripped = String(text || "").replace(
    /\b(happy\s*hour|hh)\s+(double\s+)?(bacon\s+)?(cheese)?burgers?\b/gi,
    " "
  );
  return /\b(happy\s*hour|hh\b|drink specials?|half off wine|hora feliz)\b/i.test(
    stripped
  );
}

/** Happy Hour Double Bacon Cheeseburger — not kids cheeseburger, not chalkboard. */
function mentionsHappyHourBurger(text) {
  const t = String(text || "");
  if (/\b(kids?|children|ni[nñ]os?)\b/i.test(t)) return false;
  return (
    /\bdouble\s+bacon\s+(cheese)?burgers?\b/i.test(t) ||
    /\b(happy\s*hour|hh)\s+(double\s+)?(bacon\s+)?(cheese)?burgers?\b/i.test(t) ||
    /\bbacon\s+cheeseburgers?\b/i.test(t)
  );
}

function asksHappyHourBurgerSideSwap(text) {
  const t = String(text || "");
  if (!mentionsHappyHourBurger(t)) return false;
  if (isSideSwap(t)) return true;
  return (
    /\b(change[ds]?|swap(?:ped)?|switch(?:ed)?|substitut\w*|replace[ds]?|different|another|instead)\b/i.test(
      t
    ) && /\b(sides?|fries|guarnici|papas?)\b/i.test(t)
  );
}

function asksHappyHourBurgerDefaultSide(text) {
  const t = String(text || "");
  if (!mentionsHappyHourBurger(t)) return false;
  if (asksHappyHourBurgerSideSwap(t)) return false;
  return /\b(sides?|fries|come with|comes with|served with|include[sd]?|guarnici|papas?)\b/i.test(
    t
  );
}

function happyHourBurgerDefaultSideAnswer(lang = "en") {
  if (lang === "es") {
    return (
      happyHour.burgerDefaultSideEs ||
      "¡Sí, nuestra hamburguesa doble con tocino y queso se sirve con papas fritas sazonadas de la casa!"
    );
  }
  return (
    happyHour.burgerDefaultSideEn ||
    "Yes, our Double Bacon Cheeseburger comes served with house-seasoned fries!"
  );
}

function happyHourBurgerSwapSideAnswer(lang = "en") {
  return sideSwapAnswer(lang);
}

/** Spoken HH burger side answer, or null if this is not that question. */
function happyHourBurgerReply(text, lang = "en") {
  if (asksHappyHourBurgerSideSwap(text)) return happyHourBurgerSwapSideAnswer(lang);
  if (asksHappyHourBurgerDefaultSide(text)) {
    return happyHourBurgerDefaultSideAnswer(lang);
  }
  return null;
}

function asksInventoryAvailability(text) {
  return /\b(do y'?all have|do you have|y'?all have|have any|got any|still have|out of|sold out|can i get|can we get|can my (kid|child)|available|in stock|back (in stock|tonight)|agotad)\b/i.test(
    String(text || "")
  );
}

export function reinstatedShipmentAnswer(itemName, lang = "en") {
  const name = String(itemName || "that").trim();
  if (lang === "es") {
    return `¡Qué buena noticia! Nuestro chef acaba de recibir un envío fresco de ${name}, así que ya está de vuelta y disponible esta noche!`;
  }
  return `Great news! Our chef just got a fresh shipment of ${name}, so that is back in stock and available tonight!`;
}

/** Previously 86'd, now back — host voice only. Never say un-86, 68, or system flags. */
export function reinstatedGuestReply(text, lang = "en") {
  const t = String(text || "");
  if (!asksInventoryAvailability(t)) return null;
  const hits = findReinstatedMatch(t);
  if (!hits.length) return null;
  if (findSoldOutMatch(t).length) return null;
  return reinstatedShipmentAnswer(hits[0].name, lang);
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
    /\b(change|changed|swap|swapped|switch|switched|substitut\w*|replace|replaced|different|another|switch out|change out|swap out|switch(?:ed)?\s+out).{0,40}\b(sides?|fries|papas?|potatoes)\b|\b(sides?|fries|papas?|potatoes)\b.{0,40}\b(change|changed|swap|swapped|switch|switched|substitut\w*|replace|replaced|different|another)\b/i.test(
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
      happyHour.burgerSwapSideEs ||
      restaurant.policies?.sideSubstitutionsEs ||
      "¡Por supuesto! Puedes cambiar esas papas por ensalada de col, puré de papa buttermilk, frijoles negros con arroz, o hush puppies. ¿Cuál prefieres?"
    );
  }
  return (
    happyHour.burgerSwapSideEn ||
    restaurant.policies?.sideSubstitutions ||
    "Absolutely! You can swap those fries for coleslaw, buttermilk mashed potatoes, black beans and rice, or hush puppies. What would you prefer?"
  );
}

const KIDS_ENTREE_CHOICES = [
  { name: "Kids Fish Sticks", aliases: ["fish sticks", "fishsticks", "kids fish sticks"] },
  { name: "Fried Shrimp", aliases: ["fried shrimp", "kids fried shrimp", "kids shrimp"] },
  { name: "Chicken Strips", aliases: ["chicken strips", "chicken tenders", "kids chicken", "kids tenders"] },
  { name: "Cheeseburgers", aliases: ["cheeseburger", "cheeseburgers", "kids cheeseburger"] },
  { name: "Hamburgers", aliases: ["hamburger", "hamburgers", "kids hamburger", "kids burger"] },
  {
    name: "Mac & Cheese",
    aliases: [
      "mac & cheese",
      "mac and cheese",
      "mac n cheese",
      "kids mac",
      "kids mac and cheese",
      "kids mac & cheese",
      "macaroni",
      "mac",
    ],
  },
];

const KIDS_SIDE_CHOICES = [
  { name: "Broccoli", aliases: ["broccoli", "brocolli", "brocoli", "broccolli", "brócoli"] },
  {
    name: "Virginia's Apple Cider Coleslaw",
    aliases: [
      "virginia's apple cider coleslaw",
      "apple cider coleslaw",
      "coleslaw",
      "cole slaw",
      "slaw",
    ],
  },
  { name: "Corn on the Cob", aliases: ["corn on the cob", "corn", "elote"] },
  { name: "White Rice", aliases: ["white rice", "rice", "arroz", "arroz blanco"] },
  { name: "Hush Puppies", aliases: ["hush puppies", "hushpuppy", "hush puppy"] },
  { name: "Fries", aliases: ["fries", "fry", "french fries", "papas", "papas fritas"] },
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Kids menu / kids meal questions (not reservation "how many kids"). */
function asksKidsMeal(text) {
  const t = String(text || "");
  if (
    /\b(how many kids|cu[aá]ntos ni[nñ]os|adults and kids|adultos y ni[nñ]os)\b/i.test(t)
  ) {
    return false;
  }
  return (
    /\b(kids?\s*menu|kid'?s\s*menu|children'?s\s*menu|menu infantil)\b/i.test(t) ||
    /\b(kids?\s*meals?|kid'?s\s*meals?|children'?s\s*meals?|kids?\s*plates?|kids?\s*portions?|kids?\s*entrees?|kids?\s*entr[eé]es?)\b/i.test(
      t
    ) ||
    /\b(sides?|options?|guarnici|acompañ).{0,40}\b(kids?|children|ni[nñ]os?)\b/i.test(t) ||
    /\b(kids?|children|ni[nñ]os?).{0,40}\b(sides?|options?|guarnici|acompañ)\b/i.test(t) ||
    /\b(for (a |the )?kids?|kid[- ]friendly (food|menu)|comida de ni[nñ]os?|para (los )?ni[nñ]os?)\b/i.test(
      t
    ) ||
    /\b(family options|family menu|options for (the )?(famil|children))\b/i.test(t) ||
    (/\b(my|our|the)\s+kids?\b/i.test(t) &&
      /\b(get|have|eat|order|meal|menu|side|fries|broccoli|corn|rice|slaw|hush|coleslaw)\b/i.test(
        t
      )) ||
    asksKidsSideList(t)
  );
}

/** List named kids sides only when the guest asks what sides / side options. */
function asksKidsSideList(text) {
  const t = String(text || "");
  return (
    /\bwhat sides come with(\s+(that|this|it|the kids?( meal| menu)?|a kids? meal))?\b/i.test(
      t
    ) ||
    /\bwhat (comes|come) with (a |the )?(kids?|that|this)\b/i.test(t) ||
    /\b(what|which) (are the |kids? )?(side options|sides)\b/i.test(t) ||
    /\b(side options|kids? (meal |menu )?sides|sides? (for|with) (the )?(kids?|children)|list (the )?sides)\b/i.test(
      t
    ) ||
    /\b(guarniciones|qu[eé] (sides|guarnici)|opciones de (side|guarnici))\b/i.test(t)
  );
}

function kidsEntreesLine(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.kidsMenuEntreesEs ||
      "¡Sí! Ofrecemos un menú infantil con palitos de pescado, camarón frito, tiras de pollo, hamburguesas con queso, hamburguesas y macarrones con queso."
    );
  }
  return (
    restaurant.policies?.kidsMenuEntrees ||
    "Yes! We offer a dedicated Kids Menu featuring Kids Fish Sticks, Fried Shrimp, Chicken Strips, Cheeseburgers, Hamburgers, and Mac & Cheese."
  );
}

function kidsSidesBrief(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.kidsMealSidesBriefEs ||
      "Todas las comidas infantiles incluyen tu elección de UNA guarnición, y podemos sustituir casi cualquier guarnición estándar si lo pides."
    );
  }
  return (
    restaurant.policies?.kidsMealSidesBrief ||
    "All kids meals include your choice of ONE side, and we can substitute pretty much any standard side upon request!"
  );
}

function kidsSidesList(lang = "en") {
  if (lang === "es") {
    return (
      restaurant.policies?.kidsMealSidesEs ||
      "Las guarniciones infantiles son brócoli, ensalada de col Virginia's Apple Cider, elote, arroz blanco, bolitas de maíz fritas o papas fritas."
    );
  }
  return (
    restaurant.policies?.kidsMealSides ||
    "Kids sides are Broccoli, Virginia's Apple Cider Coleslaw, Corn on the Cob, White Rice, Hush Puppies, or Fries."
  );
}

function namedKidsItems(text) {
  const t = String(text || "").toLowerCase();
  return [...KIDS_ENTREE_CHOICES, ...KIDS_SIDE_CHOICES].filter((item) =>
    item.aliases.some((a) => new RegExp(`\\b${escapeRe(a)}\\b`, "i").test(t))
  );
}

/** 86 a kids item only when the guest named it. */
function eightySixedNamedKidsItems(text) {
  const named = namedKidsItems(text);
  if (!named.length) return [];
  const sold = getSoldOut().items || [];
  const hits = [];
  for (const item of named) {
    const match = sold.find((s) => {
      const sn = String(s.name || "").toLowerCase();
      if (!sn) return false;
      if (sn.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(sn)) {
        return true;
      }
      return item.aliases.some((a) => sn.includes(a) || a.includes(sn));
    });
    if (match) hits.push(match.name || item.name);
  }
  return [...new Set(hits)];
}

function kidsMealReply(text, lang = "en") {
  let body = `${kidsEntreesLine(lang)}\n\n${kidsSidesBrief(lang)}`;
  if (asksKidsSideList(text)) {
    body += `\n\n${kidsSidesList(lang)}`;
  }

  const soldNamed = eightySixedNamedKidsItems(text);
  if (soldNamed.length) {
    body +=
      lang === "es"
        ? `\n\nHoy estamos agotados de ${soldNamed.join(", ")}, así que eso no está disponible en el menú infantil.`
        : `\n\nWe're sold out of ${soldNamed.join(", ")} today, so that wouldn't be available on the kids menu.`;
  }
  return body;
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
      "Tenemos menú sin gluten. Para freidora / contaminación cruzada, avisa a tu mesero o llama a un gerente."
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
 * Dual-intent escalation — single reply block (no prior standalone alert message):
 * 1. [Standard Query Answer] (menu/allergen + safety)
 * 2. For a group event of [party size] (or to speak with management), ...
 * 3. 🚨 PHONE RINGING: Transferring guest to Manager...  (VERY END)
 */
function composeEscalationReply(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  const partySize = opts.partySize ?? extractPartySize(text);

  const standard = standardEscalationAnswers(text, lang);
  const handoff = managerEscalationLine(lang, partySize);

  const blocks = [];
  if (standard.length) {
    blocks.push(standard[0]);
    if (standard.length > 1) blocks.push(standard.slice(1).join(" "));
  }
  blocks.push(handoff);
  blocks.push(SIM_PHONE_RINGING);

  let out = blocks.join("\n");
  // Ensure PHONE RINGING appears only once, and only at the very end
  const firstRing = out.indexOf(SIM_PHONE_RINGING);
  if (firstRing !== -1) {
    const withoutDupes =
      out.slice(0, firstRing) +
      out.slice(firstRing + SIM_PHONE_RINGING.length).replaceAll(SIM_PHONE_RINGING, "");
    out = `${withoutDupes.replace(/\n+$/, "").trim()}\n${SIM_PHONE_RINGING}`;
  }

  return sanitizeGuestEscalationReply(
    ensureSingleAllergyDisclaimer(out.replace(/\n{3,}/g, "\n").trim(), lang)
  );
}

/** Strip call-store prompts / leaked internal logs — keep the PHONE RINGING sim line. */
function sanitizeGuestEscalationReply(text) {
  let body = String(text || "");
  body = body.replace(/^.*MANAGER ALERT.*$/gim, "");
  // Do not instruct the guest to call while already on the line
  body = body.replace(
    /\s*(Please call us directly at[^.\n]*\.?|Por favor llámanos directamente al[^.\n]*\.?|call us directly at\s*\(?\d[\d\s.()-]{7,}\)?[^.]*\.?)/gi,
    ""
  );
  body = body.replace(/\bPhone:\s*\(?\d[\d\s.()-]{7,}\)?/gi, "");
  body = body.replace(/\bTel[eé]fono:\s*\(?\d[\d\s.()-]{7,}\)?/gi, "");
  // Strip store phone if it sneaks into the handoff; keep PHONE RINGING line intact
  body = body
    .split("\n")
    .map((line) => {
      if (/PHONE RINGING/i.test(line)) return line;
      return line.replace(/\(210\)\s*455-3474/g, "");
    })
    .join("\n");
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return body;
}

function countGuestIntents(text) {
  let n = 0;
  if (asksHours(text) || asksClosingHours(text)) n += 1;
  if (asksKidsMeal(text)) n += 1;
  if (asksDishAllergen(text)) n += 1;
  if (isSideSwap(text)) n += 1;
  if (asksHappyHourReadout(text) || mentionsHappyHourBurger(text)) n += 1;
  if (asksParking(text)) n += 1;
  if (asksGluten(text) || asksFryerCrossContact(text)) n += 1;
  if (extractPartySize(text) != null) n += 1;
  if (asksManagerEscalation(text) || asksCateringEscalation(text)) n += 1;
  if (isSeatingPreference(text)) n += 1;
  return n;
}

/** Two or more guest asks in one message — answer every part, do not stop at hours. */
function isMultiIntentQuery(text) {
  if (countGuestIntents(text) >= 2) return true;
  const t = foldForMatch(text);
  const connector = /\b(y|e|and|ademas|también|tambien|,)\b/.test(t);
  if (!connector) return false;
  return (
    (asksHours(text) || asksClosingHours(text)) &&
    /\b(papas?|ensalada|sides?|gluten|ninos|ninas|estacionamiento|reserv|mesa|patio|kids|parking|cambiar|menu infantil|alergen|alergia)\b/.test(
      t
    )
  );
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
  if (asksHours(text) || asksClosingHours(text)) {
    const hoursLang = hoursReplyLanguage(text, lang);
    parts.push(hoursAnswer(hoursLang, { text }));
  }

  const partySize = extractPartySize(text);
  const partyBit = partyBookingAnswer(partySize, text, lang);
  if (partyBit) parts.push(partyBit);

  if (asksKidsMeal(text) && !asksDishAllergen(text) && !mentionsHappyHourBurger(text)) {
    parts.push(kidsMealReply(text, lang));
  } else if (asksDishAllergen(text)) {
    parts.push(dishAllergenReply(text, lang));
  } else {
    const hhBurger = happyHourBurgerReply(text, lang);
    if (hhBurger) parts.push(hhBurger);
    else if (isSideSwap(text)) parts.push(sideSwapAnswer(lang));
  }
  if (asksHappyHourReadout(text)) parts.push(happyHourAnswer(lang));
  if (asksParking(text)) parts.push(parkingAnswer(lang));

  if (asksDishAllergen(text)) {
    // dish-specific allergen reply already includes disclaimer + side swap
  } else if (asksGluten(text) || asksFryerCrossContact(text)) {
    // glutenFryerAnswer already weaves shared-fryer + allergy safety once in the menu section
    parts.push(glutenFryerAnswer(lang));
  }

  const lower = text.toLowerCase();
  const skip = new Set([
    "side-swap",
    "kids-menu",
    "kids-sides",
    "gluten",
    "dairy",
    "party-size-max",
    "party-of-6",
    "happy-hour",
    "hh-food",
    "parking",
    "parking-fee",
    "hours",
    "open-now",
  ]);
  const extra = findAllFaq(lower).filter((i) => {
    if (skip.has(i.id)) return false;
    if (asksHours(text) && (i.type === "hours" || i.id === "hours" || i.id === "open-now")) {
      return false;
    }
    // Avoid a second allergy/gluten FAQ block when menu section already covered it
    if (
      (asksDishAllergen(text) || asksGluten(text) || asksFryerCrossContact(text)) &&
      ALLERGY_FAQ_IDS.has(i.id)
    ) {
      return false;
    }
    if (asksHappyHour(text) && (i.type === "hours" || i.id === "hours" || i.id === "open-now")) {
      return false;
    }
    return true;
  });
  for (const hit of extra.slice(0, 4)) {
    const ans = resolveAnswer(hit, lang, text);
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
      ? `Los especiales de pasta del pizarrón rotan, así que ese plato exacto no está en el pizarrón de hoy. ¡Pero sí podemos sazonar nuestro salmón fresco al estilo cajún y mezclarlo con pasta en salsa ajo-crema para esos mismos sabores. ${side}`
      : `Our chalkboard pasta specials rotate, so that exact dish isn’t on today’s board! However, we can blacken our fresh Salmon and toss it with pasta in a garlic-cream or Cajun sauce to match those exact flavors. ${side}`;
  }
  if (/\bpasta\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales de pasta del pizarrón rotan, así que ese plato exacto no está en el pizarrón de hoy. ¡Pero sí podemos preparar pescado o camarón al estilo cajún con pasta en salsa ajo-crema. ${side}`
      : `Our chalkboard pasta specials rotate, so that exact dish isn’t on today’s board! However, we can do blackened fish or shrimp tossed with pasta in a garlic-cream or Cajun-style sauce. ${side}`;
  }
  if (/\bsalmon\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales del pizarrón rotan, así que ese salmón especial puede no estar hoy. ¡Pero sí podemos sazonar o asar nuestro salmón fresco con un acabado ajo-crema o cajún para acercarnos a esos sabores. ${side}`
      : `Our chalkboard specials rotate, so that exact salmon special may not be on today’s board! However, we can blacken or grill our fresh Salmon with a garlic-cream or Cajun finish to match those flavors. ${side}`;
  }
  if (/\bredfish|red fish\b/i.test(t)) {
    return lang === "es"
      ? `Los especiales del pizarrón rotan, así que ese redfish especial puede no estar hoy. ¡Pero sí podemos sazonar nuestro Texas Redfish al estilo cajún y acompañarlo con camarón, mantequilla de crawfish o sazón cajún. ${side}`
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
  const text = String(rawMessage || "").trim();
  if (asksSessionReset(text)) {
    return sessionTerminatedReply();
  }
  const isGreeting = !text || isPureGreeting(text);
  const initial =
    opts.initial === true || (opts.initial !== false && isGreeting);
  const body = stripCallOpening(
    generateReplyBody(rawMessage, { ...opts, initial })
  );
  return applyCallOpening(body, initial);
}

function generateReplyBody(rawMessage, opts = {}) {
  const lang = opts.language === "es" ? "es" : "en";
  const text = String(rawMessage || "").trim();
  if (!text) {
    return greetingReply(lang, opts.initial !== false);
  }

  const lower = text.toLowerCase();

  // Only pure greetings — NOT "hey we have a party of 10…"
  if (isPureGreeting(text)) {
    return greetingReply(lang, opts.initial !== false);
  }

  // Direct HOURS / close tonight — never help/options menu; language matches the guest
  if (asksHours(text)) {
    const hoursLang = hoursReplyLanguage(text, lang);
    if (needsManagerEscalation(text)) {
      return composeEscalationReply(text, { language: hoursLang });
    }
    if (isMultiIntentQuery(text)) {
      return (
        composeMultiPartReply(text, { language: hoursLang }) ||
        hoursAnswer(hoursLang, { text })
      );
    }
    return hoursAnswer(hoursLang, { text });
  }

  // Specific dish + allergen: dish status FIRST, then disclaimer, then side swap
  if (asksDishAllergen(text)) {
    return dishAllergenReply(text, lang);
  }

  // Happy Hour burger sides — before chalkboard, kids menu, or generic side dumps
  const hhBurger = happyHourBurgerReply(text, lang);
  if (hhBurger) return hhBurger;

  const restocked = reinstatedGuestReply(text, lang);
  if (restocked) return restocked;

  // Named chalkboard item / sides — payload first, before kids or everyday menu
  const boardDish = findPayloadDish(text);
  if (boardDish) {
    return spokenPayloadDishDetail(boardDish, lang, text);
  }

  // Kids menu: exactly ONE side; 86 a side only if the guest named it
  if (asksKidsMeal(text)) {
    return kidsMealReply(text, lang);
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
        "• ALERGIAS / SIN GLUTEN / MARISCOS",
        "• HORA FELIZ / BEBIDAS",
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
    const hhBurgerSwap = happyHourBurgerReply(text, lang);
    if (hhBurgerSwap) return hhBurgerSwap;
    const pastCombo = answerPastSpecialOrCustomMod(text, { language: lang });
    if (pastCombo && asksPastSpecial(text)) return pastCombo;
    return sideSwapAnswer(lang);
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
      parts.push(resolveAnswer(hit, lang, text));
    }
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    return ensureSingleAllergyDisclaimer(parts.join("\n\n"), lang);
  }

  const hits = findAllFaq(lower);
  if (hits.length >= 2) {
    const parts = hits.map((h) => resolveAnswer(h, lang, text));
    if (isSeatingPreference(text) || isCustomKitchenMod(text)) {
      parts.push(MANAGER_OPTION);
    }
    // Disclaimer is woven into allergy/menu FAQ answers — never a trailing standalone block
    return ensureSingleAllergyDisclaimer(parts.join("\n\n"), lang);
  }

  if (hits.length === 1) {
    let answer = resolveAnswer(hits[0], lang, text);
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
  happyHourBurgerReply,
  mentionsHappyHourBurger,
  isSideSwap,
  sideSwapAnswer,
  asksHappyHourReadout,
  parkingAnswer,
  hoursAnswer,
  asksHours,
  asksClosingHours,
  hoursReplyLanguage,
  closingHoursAnswer,
  closingClockForDay,
  isMultiIntentQuery,
  asksHappyHour,
  asksKidsMeal,
  kidsMealReply,
  asksDishAllergen,
  dishAllergenReply,
  answerPastSpecialOrCustomMod,
  asksPastSpecial,
  isLargeOnlineParty,
  MAX_ONLINE_PARTY,
  HOST_NAME,
  CALL_OPENING,
  CALL_OPENING_TEXT,
  CALL_OPENING_ES,
  CALL_SIGNOFF,
  SESSION_TERMINATED_FLAG,
  asksSessionReset,
  sessionTerminatedReply,
  withCallOpening,
  stripCallOpening,
  applyCallOpening,
  stripSpokenUrls,
  greetingReply,
  ALLERGY_DISCLAIMER,
  ALLERGY_DISCLAIMER_ES,
  ensureSingleAllergyDisclaimer,
  hasAllergyDisclaimer,
  MANAGER_OPTION,
  withAllergyDisclaimer,
};
