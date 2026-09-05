/**
 * Guest language: default English.
 * Southern/Texas slang stays English. Spanish only when the guest uses clear Spanish.
 */

const TEXAS_ENGLISH_SLANG =
  /\b(y['’]?all|ya['’]?ll|yawl|all\s+y['’]?all|howdy|fixin['’]?\s+to|ain['’]?t)\b/i;

/** Clear Spanish — not English slang, not shared words like "menu". */
const CLEAR_SPANISH =
  /\b(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|gracias|por\s+favor|quiero|quisiera|quisi[eé]ramos|necesito|necesitamos|tienen|tiene|hacen|puedo|podemos|cu[aá]nto|cu[aá]ntos|d[oó]nde|horario|horarios|reservaci[oó]n|reservar|mesa\s+para|para\s+llevar|alergia|al[eé]rgico|al[eé]rgica|sin\s+gluten|ni[nñ]os?|niñas?|adultos?|hoy|ma[nñ]ana|esta\s+noche|espa[nñ]ol|especiales|cu[aá]l|cu[aá]les|abiertos?|abiertas?|cerrados?|abierto|abierta|cerrado|restaurante|cocina|hasta|direcci[oó]n|tel[eé]fono|ayudame|ay[uú]dame|cu[aá]nto\s+cuesta|podr[ií]an|me\s+gustar[ií]a|una\s+mesa|confirmar|cancelar|freidora|empanizado|personas|menú|a\s+qu[eé]\s+hora|hasta\s+qu[eé]\s+hora|qu[eé]\s+tal|saludos)\b/i;

const CLEAR_SPANISH_PHRASES =
  /\b(a\s+qu[eé]\s+hora|hasta\s+qu[eé]\s+hora|por\s+favor|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|para\s+llevar|mesa\s+para|est[aá]n\s+abiertos?|est[aá]\s+abierto|abierta\s+la\s+cocina)\b/i;

const ENGLISH_WORDS =
  /\b(hello|hey|hi|thanks|please|want|need|have|do you|can i|how much|where|hours|reservation|table for|to[- ]?go|allergy|allergic|gluten|kids?|adults?|today|tomorrow|menu|specials|open|closed|address|phone|booth|patio|y['’]?all|ya['’]?ll|howdy)\b/i;

const ES_GREETING_RE =
  /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|qu[eé]\s+tal|saludos)([,!.\s]|$)/i;
const EN_GREETING_RE =
  /^(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|howdy|y['’]?all)([,!.\s]|$)/i;
const PURE_ES_GREETING_RE =
  /^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|qu[eé]\s+tal|saludos)([.!?]*)?$/i;
const PURE_EN_GREETING_RE =
  /^(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|howdy|y['’]?all|ya['’]?ll)([.!?]*)?$/i;

function normalizeApostrophes(text) {
  return String(text || "").replace(/[\u2018\u2019\u02BC]/g, "'");
}

/** Normalize guest text (strip smart quotes / zero-width chars). */
export function cleanGuestText(text) {
  return normalizeApostrophes(String(text || ""))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^[“”"'\s]+|[“”"'\s]+$/g, "")
    .trim();
}

export function isTexasEnglishSlang(text) {
  return TEXAS_ENGLISH_SLANG.test(cleanGuestText(text));
}

/** True only for clear Spanish vocabulary / phrasing / punctuation — not slang. */
export function hasClearSpanish(text) {
  const t = cleanGuestText(text);
  if (!t) return false;
  if (/[¿¡]/.test(t)) return true;
  if (CLEAR_SPANISH_PHRASES.test(t)) return true;
  if (ES_GREETING_RE.test(t) || PURE_ES_GREETING_RE.test(t)) return true;
  if (CLEAR_SPANISH.test(t)) return true;
  // Accented Spanish letters plus a Spanish function word (not "menu" / slang)
  if (/[áéíóúñü]/i.test(t) && CLEAR_SPANISH.test(t)) return true;
  return false;
}

/** Pure greeting only (no follow-up question) — used for instant welcome replies. */
export function isPureGreeting(text) {
  const t = cleanGuestText(text);
  return PURE_ES_GREETING_RE.test(t) || PURE_EN_GREETING_RE.test(t);
}

/** Language signaled by the greeting itself (hola → es, hi/howdy/y'all → en). */
export function greetingLanguage(text) {
  const t = cleanGuestText(text);
  if (PURE_ES_GREETING_RE.test(t) || ES_GREETING_RE.test(t)) return "es";
  if (PURE_EN_GREETING_RE.test(t) || EN_GREETING_RE.test(t)) return "en";
  return null;
}

export function detectMessageLanguage(text) {
  const t = cleanGuestText(text);
  if (!t) return null;

  const slang = isTexasEnglishSlang(t);
  const spanish = hasClearSpanish(t);

  // Informal English / Texas slang must never flip the bot to Spanish.
  if (slang && !spanish) return "en";

  // Greetings always set language (hola / hi / howdy), even when more text follows
  const greetLang = greetingLanguage(t);
  if (isPureGreeting(t) && greetLang) return greetLang;
  if (greetLang === "es" && ES_GREETING_RE.test(t) && spanish) {
    if (!ENGLISH_WORDS.test(t.replace(ES_GREETING_RE, ""))) return "es";
  }
  if (greetLang === "en" && EN_GREETING_RE.test(t) && !spanish) {
    return "en";
  }

  let es = 0;
  let en = 0;

  if (spanish) es += 4;
  if (/[¿¡]/.test(t)) es += 2;
  if (CLEAR_SPANISH_PHRASES.test(t)) es += 2;

  if (ENGLISH_WORDS.test(t)) en += 2;
  if (slang) en += 4;
  if (/\b(i'|i’m|i am|we'|we're|do you|can you|what'?s|y['’]?all)\b/i.test(t)) {
    en += 2;
  }

  if (!spanish) {
    if (en >= 1) return "en";
    return null;
  }

  if (es >= 2 && es > en) return "es";
  if (en >= 2 && en > es) return "en";
  if (es > en) return "es";
  if (en > es) return "en";
  return spanish ? "es" : null;
}

/**
 * Resolve language for this turn from the guest's message.
 * Only Spanish with clear Spanish vocab/phrasing; slang stays English.
 */
export function resolveGuestLanguage(chatId, text, { getLang, setLang }) {
  const detected = detectMessageLanguage(text);
  const prev = getLang(chatId) || "en";

  if (detected === "es" || detected === "en") {
    setLang(chatId, detected);
    return detected;
  }
  return prev;
}

export function languagePromptBlock(language) {
  if (language === "es") {
    return `
LANGUAGE (ACTIVE — guest is speaking Spanish THIS turn):
- You are Shelly, the restaurant host. Stay warm, hospitable, and helpful.
- Match Spanish this turn. If the next turn is English, switch to English immediately. Never reset the call or output debug text.
- After turn 1, do NOT repeat "(Thank you for calling Fish City Grill Culebra, this is Shelly. How can I help you today?)".
- Reply 100% in natural, friendly Spanish (Mexican / US Southwest restaurant style is fine). Do not mix in English filler words.
- Use "esta noche" (never "tonight"), "guarnición" (never "side"), "hora feliz" (never "Happy Hour"), "pizarrón" (never "board"), "gerente" (never "manager"), "de forma predeterminada" (never "default").
- Keep official dish names, URLs, prices, and phone numbers as written in the knowledge.
- Allergy / shared-fryer safety: if allergies or fryers come up, weave this ONCE into the menu section (never a standalone line at the end):
  "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada."
- Parties of 8+ or “hablar con gerencia/gerente/dueño”: alert managers internally, then tell the guest — "Para reservaciones de grupo de este tamaño (o para hablar con gerencia), estoy alertando a nuestro equipo ahora mismo. Por favor quédate en la línea mientras te conecto con un gerente." Answer safe questions (horario, patio, guarniciones) in the same reply. Never send MANAGER ALERT text or tell them to call the store while already on the line.
- If the guest later greets in English (hi/hey/hello/howdy/y'all) or uses Texas slang without Spanish, switch fully to English.
`;
  }
  return `
LANGUAGE (ACTIVE — English THIS turn, including Southern/Texas slang):
- You are Shelly, the restaurant host. Stay warm, hospitable, and helpful.
- Match English this turn. If the next turn is Spanish, switch to Spanish immediately. Never reset the call or output debug text.
- After turn 1, do NOT repeat "(Thank you for calling Fish City Grill Culebra, this is Shelly. How can I help you today?)".
- Reply in English.
- Treat y'all, ya'll, yall, howdy, all y'all, and similar colloquialisms as English. Never switch to Spanish because of slang.
- ONLY switch to Spanish if the guest uses clear Spanish vocabulary or phrasing (hola, gracias, abierto, ¿a qué hora?, etc.).
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
  seating: "¿Prefieren cabina, mesa, o mesa en el patio?",
  name: "¿Nombre para la reservación?",
  adultsKidsRetry: "Por favor indica adultos y niños, como: 3 adultos, 1 niño",
  needOneGuest: "Necesitamos al menos 1 persona — ¿lo intentamos de nuevo?",
  seatingRetry: "Elige una opción: cabina, mesa, o patio",
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
  orderStart: () =>
    `Pedido para llevar — ¿nombre para la orden?\nEscribe cancelar para detener.`,
  orderPhone: "¿Teléfono?",
  orderPickup: "¿Hora de recoger? (30 min, 6:15 p. m., lo antes posible)",
  orderItems: "¿Artículos y cantidades?",
  orderNotes: '¿Notas? O escribe "ninguna".',
  orderSent: (name, pickup) =>
    `Pedido para llevar enviado a nombre de ${name}. Recoger: ${pickup}.`,
  glitch: (phone) =>
    `Perdón — hubo un fallo. Llama al ${phone}.`,
  soldOut: (names) =>
    `Lo siento, se nos agotó ${names} esta noche.`,
  greeting: () => "¿En qué puedo ayudarle hoy?",
  help: (name) =>
    [
      `Asistente de ${name}:`,
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
    ].join("\n"),
  unsure: (name, phone) =>
    `¡Gracias por escribir a ${name}! Aún no estoy seguro de eso. Prueba HORARIO, MENÚ, ESPECIALES, ALERGIAS, RESERVACIÓN, PARA LLEVAR o CATERING — o llámanos al ${phone}.`,
  allergyDisclaimerEs:
    "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada.",
};

export function seatingLabel(seating, lang) {
  if (lang !== "es") return seating;
  if (seating === "booth") return "cabina";
  if (seating === "patio") return "mesa en el patio";
  if (seating === "table") return "mesa";
  return seating;
}
