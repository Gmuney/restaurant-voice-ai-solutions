import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_DIR } from "../paths.js";

const restaurant = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "restaurant.json"), "utf8")
);
const catalog = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "menu-items.json"), "utf8")
);

const DISCLAIMER =
  restaurant.policies?.allergyDisclaimer ||
  "Please notify your server of severe allergies upon arrival so our kitchen can take extra precautions against cross-contamination.";
const DISCLAIMER_ES =
  restaurant.policies?.allergyDisclaimerEs ||
  "Por favor avise a su mesero de alergias graves al llegar para que la cocina pueda tomar precauciones extra contra la contaminación cruzada.";

const SIDE_SWAP =
  restaurant.policies?.dishAllergenSideSwap ||
  "We can swap any listed side for another listed side — just tell your server.";
const SIDE_SWAP_ES =
  restaurant.policies?.dishAllergenSideSwapEs ||
  "Podemos cambiar cualquier guarnición listada por otra — solo dile a tu mesero.";
const FRIED_SHRIMP_DAIRY =
  "Our Fried Shrimp is prepared in a buttermilk batter, so it does contain dairy. However, we can easily prepare your shrimp grilled or blackened for a delicious dairy-free option!";
const FRIED_SHRIMP_SIDES =
  "And feel free to swap out the fries for extra hush puppies or any of our other sides—just let your server know!";
const FRIED_SHRIMP_DAIRY_ES =
  "Nuestro camarón frito se prepara en un rebozado de suero de leche, así que sí contiene lácteos. Sin embargo, ¡podemos preparar tu camarón a la parrilla o sazonado al estilo cajún para una rica opción sin lácteos!";
const FRIED_SHRIMP_SIDES_ES =
  "Y si quieres, cambia las papas fritas por bolitas de maíz extra o cualquiera de nuestras otras guarniciones—¡solo dile a tu mesero!";

const ALLERGENS = [
  {
    id: "dairy",
    re: /\b(dairy|lactose|milk allergy|sin l[aá]cteos|lactosa|butter|mantequilla)\b/i,
  },
  {
    id: "gluten",
    re: /\b(gluten|celiac|cel[ií]aco|wheat|sin gluten)\b/i,
  },
  {
    id: "shellfish",
    re: /\b(shellfish|shrimp allergy|crab allergy|mariscos)\b/i,
  },
  {
    id: "nut",
    re: /\b(nut allergy|peanut|tree nut|pecan|almond|nuez|nueces)\b/i,
  },
];

const DAIRY_HINT =
  /\b(butter|beurre|cream|cheese|cheddar|havarti|bleu|blue cheese|buttermilk|aioli|parmesan|chowder|mac\b|queso)\b/i;
const GLUTEN_HINT =
  /\b(beer[- ]?batter|breaded|crostini|ritz|wonton|wrap|bun|po'? ?boy|hush puppy|flour|roux|milanese|nachos|mac)\b/i;
const NUT_HINT = /\b(pecan|almond|peanut|walnut|nut)\b/i;

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s&']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectAllergen(text) {
  for (const a of ALLERGENS) {
    if (a.re.test(text)) return a.id;
  }
  return null;
}

function findCatalogItem(text) {
  const lower = normalize(text);
  let best = null;
  let bestLen = 0;
  for (const item of catalog.items || []) {
    for (const alias of item.aliases || []) {
      const a = normalize(alias);
      if (!a) continue;
      const re = new RegExp(
        `(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`
      );
      if (re.test(` ${lower} `) || lower.includes(a)) {
        if (a.length > bestLen) {
          bestLen = a.length;
          best = item;
        }
      }
    }
  }
  return best;
}

function prepVariantKey(text, item) {
  if (/\bblackened\b/i.test(text) && item?.prepVariants?.blackened) {
    return "blackened";
  }
  if (/\bblackened\b/i.test(text) && (item?.cook || []).includes("blackened")) {
    return "blackened";
  }
  return null;
}

function inferStatus(item, allergen) {
  const blob = `${item.name || ""} ${item.blurb || ""} ${item.notes || ""}`;
  if (allergen === "dairy") {
    if (DAIRY_HINT.test(blob)) return { status: "contains", note: "butter/dairy" };
    if ((item.cook || []).includes("blackened")) return { status: "free" };
    return { status: "unknown" };
  }
  if (allergen === "gluten") {
    if (GLUTEN_HINT.test(blob)) return { status: "contains", note: "gluten" };
    if ((item.cook || []).includes("fried")) return { status: "fried" };
    if ((item.cook || []).includes("blackened") || (item.cook || []).includes("grilled")) {
      return { status: "free" };
    }
    return { status: "unknown" };
  }
  if (allergen === "shellfish") {
    if (item.shellfish) return { status: "contains", note: "shellfish" };
    return { status: "free" };
  }
  if (allergen === "nut") {
    if (NUT_HINT.test(blob)) return { status: "contains", note: "nuts" };
    return { status: "unknown" };
  }
  return { status: "unknown" };
}

function resolvePrep(item, allergen, variantKey) {
  const variant = variantKey ? item.prepVariants?.[variantKey] : null;
  const displayName = variant?.displayName || item.name;
  if (variant && variant[allergen]) {
    return {
      displayName,
      status: variant[allergen],
      note: variant[`${allergen}Note`],
    };
  }
  if (item.allergens?.[allergen]) {
    return {
      displayName,
      status: item.allergens[allergen],
      note: item.allergens[`${allergen}Note`],
    };
  }
  const inferred = inferStatus(item, allergen);
  return { displayName, ...inferred };
}

function statusLine(displayName, allergen, status, note, lang) {
  const es = lang === "es";
  if (status === "free") {
    if (allergen === "dairy") {
      return es
        ? `Nuestro ${displayName} se prepara sin lácteos de forma predeterminada.`
        : `Our ${displayName} is prepared dairy-free by default.`;
    }
    if (allergen === "gluten") {
      return es
        ? `Nuestro ${displayName} se prepara sin gluten de forma predeterminada.`
        : `Our ${displayName} is prepared gluten-free by default.`;
    }
    if (allergen === "shellfish") {
      return es
        ? `Nuestro ${displayName} no lleva mariscos en su preparación.`
        : `Our ${displayName} is prepared without shellfish by default.`;
    }
    return es
      ? `Nuestro ${displayName} se prepara sin ese alérgeno de forma predeterminada.`
      : `Our ${displayName} is prepared without that allergen by default.`;
  }
  if (status === "contains" || status === "fried") {
    if (allergen === "dairy") {
      const bit =
        lang === "es"
          ? "mantequilla o lácteos"
          : note && note !== "butter/dairy"
            ? note
            : "butter/dairy";
      return es
        ? `Nuestro ${displayName} lleva ${bit} en su preparación.`
        : `Our ${displayName} contains ${bit} in its preparation.`;
    }
    if (allergen === "gluten") {
      if (status === "fried") {
        return es
          ? `Nuestro ${displayName} es frito; no podemos garantizar que esté libre de gluten por el aceite compartido.`
          : `Our ${displayName} is fried, so we cannot guarantee it is gluten-free because of shared fryer oil.`;
      }
      const bit = note && note !== "gluten" ? note : "gluten";
      return es
        ? `Nuestro ${displayName} lleva ${bit} en su preparación.`
        : `Our ${displayName} contains ${bit} in its preparation.`;
    }
    const bit = note || allergen;
    return es
      ? `Nuestro ${displayName} lleva ${bit} en su preparación.`
      : `Our ${displayName} contains ${bit} in its preparation.`;
  }
  const label =
    allergen === "dairy" ? (es ? "lácteos" : "dairy") : allergen;
  return es
    ? `No tengo un estatus confirmado de ${label} para nuestro ${displayName}, así que avisa a tu mesero para que la cocina revise esa preparación.`
    : `I don't have a confirmed ${label} status for our ${displayName}, so please tell your server and they'll check that prep with the kitchen.`;
}

function isDishStatusAsk(text) {
  const t = String(text || "");
  if (
    /\b(dairy[- ]?free|gluten[- ]?free|sin (gluten|l[aá]cteos))\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(does|do|is|are)\b.{0,90}\b(contain|contains|have|has|dairy|gluten|butter|lactose|wheat|shellfish|nut|peanut)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(contain|contains|any dairy|any gluten|any butter)\b/i.test(t) ||
    /\b(dairy|gluten|butter|lactose)\s+in\s+(the|its|that|this)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function mentionsSevereAllergy(text) {
  const t = String(text || "");
  return (
    /\bsevere.{0,24}allerg/i.test(t) ||
    /\balergias? graves?\b/i.test(t) ||
    /\b(anaphylax|epi[- ]?pen|life[- ]?threaten)\b/i.test(t)
  );
}

function isFriedShrimpAsk(text) {
  return /\bfried shrimp\b/i.test(text) || /\bcamar[oó]n frito\b/i.test(text);
}

function friedShrimpDairyReply(lang = "en", text = "") {
  const status = lang === "es" ? FRIED_SHRIMP_DAIRY_ES : FRIED_SHRIMP_DAIRY;
  const sides = lang === "es" ? FRIED_SHRIMP_SIDES_ES : FRIED_SHRIMP_SIDES;
  const parts = [status, sides];
  if (mentionsSevereAllergy(text)) {
    parts.push(lang === "es" ? DISCLAIMER_ES : DISCLAIMER);
  }
  return parts.join(" ");
}

function isPersonAllergyOnly(text) {
  const t = String(text || "");
  return (
    /\b(i('m| am)|we('re| are)|allergic to|(shrimp|shellfish|nut|peanut|dairy|gluten) allergy)\b/i.test(
      t
    ) && !isDishStatusAsk(t)
  );
}

/** True when the guest named a specific dish AND asked about an allergen. */
export function asksDishAllergen(text) {
  const t = String(text || "");
  if (!detectAllergen(t)) return false;
  if (isFriedShrimpAsk(t) && detectAllergen(t) === "dairy") return true;
  if (isPersonAllergyOnly(t)) return false;
  if (!isDishStatusAsk(t) && !/\bblackened\s+salmon\b/i.test(t)) return false;
  if (/\bblackened\s+salmon\b/i.test(t)) return true;
  return Boolean(findCatalogItem(t));
}

/**
 * Dish status FIRST. Fried shrimp dairy is brief (no generic disclaimer unless severe allergy).
 * Other dishes: then generic allergy disclaimer, then a concise side-swap.
 */
export function dishAllergenReply(text, lang = "en") {
  const t = String(text || "");
  const allergen = detectAllergen(t);
  if (!allergen) return null;

  if (isFriedShrimpAsk(t) && allergen === "dairy") {
    return friedShrimpDairyReply(lang, t);
  }

  let item = findCatalogItem(t);
  if (!item && /\bblackened\s+salmon\b/i.test(t)) {
    item = (catalog.items || []).find((i) => i.id === "salmon") || null;
  }
  if (!item) return null;

  const variantKey = prepVariantKey(t, item);
  const { displayName, status, note } = resolvePrep(item, allergen, variantKey);
  const disc = lang === "es" ? DISCLAIMER_ES : DISCLAIMER;
  const sides = lang === "es" ? SIDE_SWAP_ES : SIDE_SWAP;
  const first = statusLine(displayName, allergen, status, note, lang);

  return `${first} ${disc} ${sides}`;
}
