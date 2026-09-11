import {
  findPayloadDish,
  resolveActivePayloadDish,
  getActiveSpecialsPayload,
} from "./board-payload.js";

export const SUBSTITUTE_SIDE_INTENT = "SUBSTITUTE_SIDE";
export const SWAP_SIDES_ACTION = "SWAP_SIDES";
export const HAPPY_HOUR_BURGER_DISH = "Double Bacon Cheeseburger";

/** Side change / swap / substitute — maps to SUBSTITUTE_SIDE. */
export function isSideSubstitutionQuery(text) {
  const t = String(text || "");
  if (
    /\b(chang(?:e|es|ed|ing)|swap(?:ped|ping)?|switch(?:ed|ing)?|substitut\w*|replac(?:e|ed|ing)|different|another|switch out|change out|swap out|switch(?:ed)?\s+out).{0,40}\b(sides?|fries|papas?|potatoes)\b|\b(sides?|fries|papas?|potatoes)\b.{0,40}\b(chang(?:e|es|ed|ing)|swap(?:ped|ping)?|switch(?:ed|ing)?|substitut\w*|replac(?:e|ed|ing)|different|another)\b/i.test(
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
  if (
    /\b(switch|swap|change)\s+out\b/i.test(t) &&
    /\b(okra|cornbread|coleslaw|mashed|rice|fries|hush|broccoli|slaw|beans|papas|potatoes)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** Follow-up after sides were discussed ("change them", "swap one of those", …). */
export function contextualSideSubstitutionQuery(text, opts = {}) {
  const t = String(text || "");
  if (isSideSubstitutionQuery(t)) return true;
  const activeDish = resolveActiveDishName(t, opts);
  if (!activeDish) return false;
  if (
    /\b(change|swap|switch|substitut|replace|different|other|instead).{0,30}\b(them|it|those|one|both|my side|the side|that side|these|the sides)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(okra|cornbread|coleslaw|mashed|rice|hush|broccoli|fries|papas|salad|beans|potatoes).{0,35}\b(instead|rather|swap|change|substitut|replace)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function mentionsHappyHourBurger(text) {
  const t = String(text || "");
  if (/\b(kids?|children|ni[nñ]os?)\b/i.test(t)) return false;
  return (
    /\bdouble\s+bacon\s+(cheese)?burgers?\b/i.test(t) ||
    /\b(happy\s*hour|hh)\s+(double\s+)?(bacon\s+)?(cheese)?burgers?\b/i.test(t) ||
    /\bbacon\s+cheeseburgers?\b/i.test(t)
  );
}

function happyHourBurgerInContext(query, opts = {}) {
  if (mentionsHappyHourBurger(query)) return true;
  if (opts.activeDishName === HAPPY_HOUR_BURGER_DISH) return true;
  for (const msg of opts.recentMessages || []) {
    if (mentionsHappyHourBurger(msg)) return true;
  }
  return false;
}

/**
 * Resolve active dish name from the query + conversation context only.
 * Never assumes default sides or a default dish.
 */
export function resolveActiveDishName(query, opts = {}) {
  const fromQuery = findPayloadDish(query);
  if (fromQuery?.name) return fromQuery.name;

  if (opts.forceHappyHourBurger || happyHourBurgerInContext(query, opts)) {
    return HAPPY_HOUR_BURGER_DISH;
  }

  const fromContext = resolveActivePayloadDish(query, opts);
  if (fromContext?.name) return fromContext.name;

  return null;
}

/**
 * Intent & entity parser — JSON only, no conversational phone copy.
 *
 * @returns {null | { intent: "SUBSTITUTE_SIDE", active_dish: string, requested_action: "SWAP_SIDES" }}
 */
export function parseGuestIntent(query, opts = {}) {
  if (
    !isSideSubstitutionQuery(query) &&
    !contextualSideSubstitutionQuery(query, opts)
  ) {
    return null;
  }

  const activeDish = resolveActiveDishName(query, opts);
  if (!activeDish) return null;

  return {
    intent: SUBSTITUTE_SIDE_INTENT,
    active_dish: activeDish,
    requested_action: SWAP_SIDES_ACTION,
  };
}

/** Map parsed intent to a dish record `{ name, sides? }` for the response layer. */
export function dishEntityForIntent(parsed) {
  if (!parsed?.active_dish) return null;
  if (parsed.active_dish === HAPPY_HOUR_BURGER_DISH) {
    return {
      name: HAPPY_HOUR_BURGER_DISH,
      sides: "house-seasoned fries",
    };
  }
  const payload = getActiveSpecialsPayload();
  const hit = (payload?.dishes || []).find(
    (d) => d.name.toLowerCase() === String(parsed.active_dish).toLowerCase()
  );
  if (hit) return hit;
  return { name: parsed.active_dish };
}
