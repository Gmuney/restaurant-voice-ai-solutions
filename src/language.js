/**
 * Guest language: default English. Switch when the guest greets/writes in Spanish or English.
 */

const SPANISH_WORDS =
  /\b(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|por\s+favor|quiero|quisiera|quisi[eé]ramos|necesito|necesitamos|tienen|tiene|hacen|puedo|podemos|cu[aá]nto|cu[aá]ntos|d[oó]nde|horario|horarios|reservaci[oó]n|reservar|mesa\s+para|para\s+llevar|alergia|al[eé]rgico|al[eé]rgica|sin\s+gluten|ni[nñ]os?|niñas?|adultos?|hoy|ma[nñ]ana|esta\s+noche|espa[nñ]ol|men[uú]|especiales|cu[aá]l|cu[aá]les|est[aá]n|abiertos?|cerrados?|direcci[oó]n|tel[eé]fono|favor|ayudame|ay[uú]dame|hay|cu[aá]nto\s+cuesta|podr[ií]an|podria|me\s+gustar[ií]a|una\s+mesa|confirmar|cancelar|freidora|empanizado|personas|opciones)\b/i;

const ENGLISH_WORDS =
  /\b(hello|hey|hi|thanks|please|want|need|have|do you|can i|how much|where|hours|reservation|table for|to[- ]?go|allergy|allergic|gluten|kids?|adults?|today|tomorrow|menu|specials|open|closed|address|phone|booth|patio)\b/i;

const ES_GREETING_RE =
  /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|qu[eé]\s+tal|saludos)([,!.\s]|$)/i;
const EN_GREETING_RE =
  /^(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|howdy)([,!.\s]|$)/i;
const PURE_ES_GREETING_RE =
  /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|qu[eé]\s+tal|saludos)([.!?]*)?$/i;
const PURE_EN_GREETING_RE =
  /^(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|howdy)([.!?]*)?$/i;

/** Normalize guest text (strip smart quotes / zero-width chars). */
export function cleanGuestText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^[“”"'\s]+|[“”"'\s]+$/g, "")
    .trim();
}

/** Pure greeting only (no follow-up question) — used for instant welcome replies. */
export function isPureGreeting(text) {
  const t = cleanGuestText(text);
  return PURE_ES_GREETING_RE.test(t) || PURE_EN_GREETING_RE.test(t);
}

/** Language signaled by the greeting itself (hola → es, hi → en). */
export function greetingLanguage(text) {
  const t = cleanGuestText(text);
  if (PURE_ES_GREETING_RE.test(t) || ES_GREETING_RE.test(t)) return "es";
  if (PURE_EN_GREETING_RE.test(t) || EN_GREETING_RE.test(t)) return "en";
  return null;
}

export function detectMessageLanguage(text) {
  const t = cleanGuestText(text);
  if (!t) return null;

  // Greetings always set language (hola / hi), even when more text follows
  const greetLang = greetingLanguage(t);
  if (isPureGreeting(t) && greetLang) return greetLang;
  if (greetLang === "es" && ES_GREETING_RE.test(t)) {
    // "Hola, …" — treat as Spanish unless the rest is clearly English-only
    if (!ENGLISH_WORDS.test(t.replace(ES_GREETING_RE, ""))) return "es";
  }
  if (greetLang === "en" && EN_GREETING_RE.test(t)) {
    if (!SPANISH_WORDS.test(t.replace(EN_GREETING_RE, ""))) return "en";
  }

  let es = 0;
  let en = 0;

  if (/[áéíóúñü¿¡]/i.test(t)) es += 2;
  if (SPANISH_WORDS.test(t)) es += 3;
  if (/\b(qué|que|cómo|como|cuándo|cuando|dónde|donde|por qu[eé])\b/i.test(t)) {
    es += 1;
  }
  if (/[¿¡]/.test(t)) es += 2;

  if (ENGLISH_WORDS.test(t)) en += 2;
  if (/\b(i'|i’m|i am|we'|we're|do you|can you|what'?s)\b/i.test(t)) en += 2;

  if (es >= 2 && es > en) return "es";
  if (en >= 2 && en > es) return "en";
  if (es > en) return "es";
  if (en > es) return "en";
  return null;
}

/**
 * Resolve language for this turn from the guest's message.
 * Greeting or clear Spanish/English content switches the chat language.
 */
export function resolveGuestLanguage(chatId, text, { getLang, setLang }) {
  const detected = detectMessageLanguage(text);
  const prev = getLang(chatId) || "en";

  if (detected === "es" || detected === "en") {
    if (prev !== detected) setLang(chatId, detected);
    else setLang(chatId, detected); // keep sticky explicit
    return detected;
  }
  return prev;
}

export function languagePromptBlock(language) {
  if (language === "es") {
    return `
LANGUAGE (ACTIVE — guest greeted or is speaking Spanish):
- Reply entirely in natural, friendly Spanish (Mexican / US Southwest restaurant style is fine).
- Keep dish names, brand names, URLs, prices, and phone numbers as written in the knowledge.
- Allergy disclaimer: if allergies come up, include this Spanish version verbatim:
  "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada."
- If the guest later greets in English (hi/hey/hello), switch fully to English.
`;
  }
  return `
LANGUAGE (ACTIVE — guest greeted or is speaking English):
- Reply in English.
- If the guest greets in Spanish (hola / buenos días / etc.) or writes in Spanish, switch fully to Spanish for that reply and following turns until they greet/write in English again.
`;
}

/** Spanish copy for reservation / order demo wizards */
export const ES = {
  resCancel: "Solicitud de reservación cancelada.",
  resDemoNote:
    "(Reservación demo — te confirmo aquí. Escribe cancelar para detener.)",
  adultsKidsWithParty: (n, date, time) =>
    `Perfecto — mesa para ${n}${date ? ` ${date}` : ""}${time ? ` a las ${time}` : ""}.\n\n¿Cuántos adultos y cuántos niños? (ej: 3 adultos, 1 niño)`,
  adultsKids: "¿Cuántos adultos y cuántos niños? (ej: 2 adultos, 1 niño)",
  date: "¿Qué día? (ej: hoy, viernes, 8/15)",
  time: "¿A qué hora? (ej: 5pm, 6:30pm)",
  seating: "¿Prefieren booth (cabina), mesa, o mesa en el patio?",
  name: "¿Nombre para la reservación?",
  adultsKidsRetry: "Por favor indica adultos y niños, como: 3 adultos, 1 niño",
  needOneGuest: "Necesitamos al menos 1 persona — ¿lo intentamos de nuevo?",
  seatingRetry: "Elige una opción: booth, mesa, o patio",
  confirmed: (name, adults, kids, partySize, date, time, seating, id) =>
    [
      "✅ ¡Reservación confirmada!",
      "",
      `Nombre: ${name}`,
      `Personas: ${adults} adulto${adults === 1 ? "" : "s"}, ${kids} niño${kids === 1 ? "" : "s"} (${partySize} en total)`,
      `Cuándo: ${date} a las ${time}`,
      `Asientos: ${seating}`,
      "",
      "Nos vemos pronto — si necesitas cambiar algo, escríbenos aquí.",
      `(Ref ${id})`,
    ].join("\n"),
  orderCancel: "Pedido para llevar cancelado.",
  orderStart: (url) =>
    `Pedido para llevar — ¿nombre para la orden?\n(O pide en línea: ${url})\nEscribe cancelar para detener.`,
  orderPhone: "¿Teléfono?",
  orderPickup: "¿Hora de recoger? (30 min, 6:15pm, ASAP)",
  orderItems: "¿Artículos y cantidades?",
  orderNotes: '¿Notas? O escribe "ninguna".',
  orderSent: (name, pickup) =>
    `Pedido para llevar enviado a nombre de ${name}. Recoger: ${pickup}.`,
  glitch: (phone) =>
    `Perdón — hubo un fallo. Llama al ${phone}.`,
  soldOut: (names, menuUrl) =>
    `Se nos agotó: ${names} por hoy.\n(Tablero 86 demo — después puede sincronizar con el inventario del restaurante.)\nMenú: ${menuUrl}`,
  greeting: (name) =>
    `¡Hola! Gracias por escribir a ${name}. Puedo ayudar con horarios, dirección, menú, especiales, alergias, happy hour, reservaciones, para llevar, catering y eventos privados. ¿En qué te ayudo?`,
  help: (name) =>
    [
      `Asistente de ${name}:`,
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
    ].join("\n"),
  unsure: (name, phone) =>
    `¡Gracias por escribir a ${name}! Aún no estoy seguro de eso. Prueba HORARIO, MENÚ, ESPECIALES, ALERGIAS, RESERVACIÓN, PARA LLEVAR o CATERING — o llámanos al ${phone}.`,
  allergyDisclaimerEs:
    "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada.",
};

export function seatingLabel(seating, lang) {
  if (lang !== "es") return seating;
  if (seating === "booth") return "booth (cabina)";
  if (seating === "patio") return "mesa en el patio";
  if (seating === "table") return "mesa";
  return seating;
}
