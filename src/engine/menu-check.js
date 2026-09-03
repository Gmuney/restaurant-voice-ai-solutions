import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restaurant, ALLERGY_DISCLAIMER, ALLERGY_DISCLAIMER_ES, hasAllergyDisclaimer, ensureSingleAllergyDisclaimer } from "./reply.js";
import { asksDishAllergen } from "./dish-allergen.js";
import { getSoldOut } from "../store.js";
import { readCachedBoard } from "../board/read-board.js";
import { getActiveSpecialsPayload } from "./board-payload.js";
import { KNOWLEDGE_DIR } from "../paths.js";

function withAllergySafety(text, lang = "en") {
  let body = String(text || "").trim();
  if (!body) return body;
  if (hasAllergyDisclaimer(body)) {
    return ensureSingleAllergyDisclaimer(body, lang);
  }
  const disc = lang === "es" ? ALLERGY_DISCLAIMER_ES : ALLERGY_DISCLAIMER;
  // Weave into the menu section — not a trailing standalone block
  body = `${body.replace(/\s+$/, "")} ${disc}`;
  return ensureSingleAllergyDisclaimer(body, lang);
}

const catalog = JSON.parse(
  readFileSync(join(KNOWLEDGE_DIR, "menu-items.json"), "utf8")
);

function everydayMenuLink() {
  return (
    restaurant.everydayMenuUrl ||
    restaurant.orderOnlineUrl ||
    restaurant.menuUrl
  );
}

const AVAIL_TRIGGERS =
  /\b(do y'?all have|do you have|do you still have|y'?all have|got any|have any|is there|are there|serve|serving|can i get|can we get|still have|out of|sold out|86)\b/i;

const LIST_TRIGGERS =
  /\b(what('?s| is| are)?\s+(on\s+)?(the\s+)?|list|show|tell me|go over|run through|all|your)\b/i;

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s&']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isItemSoldOut(item) {
  const sold = getSoldOut().items || [];
  return sold.filter((s) => {
    const sn = normalize(s.name);
    return (
      normalize(item.name).includes(sn) ||
      (item.aliases || []).some((a) => {
        const an = normalize(a);
        return an === sn || an.includes(sn) || sn.includes(an);
      })
    );
  });
}

/** Find best catalog match by longest alias contained in the message. */
export function findMenuItem(text) {
  const lower = normalize(text);
  let best = null;
  let bestLen = 0;
  for (const item of catalog.items) {
    for (const alias of item.aliases || []) {
      const a = normalize(alias);
      if (!a) continue;
      const re = new RegExp(
        `(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`
      );
      if (re.test(` ${lower} `) || lower.includes(a)) {
        if (a.length > bestLen) {
          bestLen = a.length;
          best = { item, alias: a };
        }
      }
    }
  }
  return best;
}

function findCategory(text) {
  const lower = normalize(text);
  let best = null;
  let bestLen = 0;
  for (const cat of catalog.categories || []) {
    for (const alias of cat.aliases || []) {
      const a = normalize(alias);
      if (!a) continue;
      // Word-boundary match so "besides" does not hit category "sides"
      const re = new RegExp(
        `(^|\\s)${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`
      );
      if (re.test(` ${lower} `) && a.length > bestLen) {
        bestLen = a.length;
        best = cat;
      }
    }
  }
  return best;
}

function wantsFullMenu(text) {
  const lower = normalize(text);
  return (
    /\b(full menu|entire menu|whole menu|all menu items|everything on the menu|complete menu)\b/.test(
      lower
    ) ||
    (/\b(menu items|on the menu|what.?s on the menu|what do you have on the menu)\b/.test(
      lower
    ) &&
      !findCategory(text))
  );
}

function wantsCategoryList(text) {
  const lower = normalize(text);
  const cat = findCategory(text);
  if (!cat) return null;

  // Kids meal / family-options copy is a dedicated two-block reply, not a category dump
  if (
    cat.id === "kids" ||
    (cat.id === "sides" &&
      /\b(kids?|kid'?s|children'?s|ni[nñ]os?|menu infantil|family options|family menu)\b/i.test(
        text
      ))
  ) {
    return null;
  }

  // "do you have tacos?" is availability-ish but listing tacos is better
  const listLike =
    LIST_TRIGGERS.test(text) ||
    /\b(options|choices|selection)\b/i.test(text) ||
    /\b(what|which|any|your)\b.+\b(appetizer|taco|sandwich|entree|entrée|side|dessert|salad|soup)/i.test(
      text
    ) ||
    new RegExp(`\\b(list|show|what).{0,20}${cat.aliases[0]}`, "i").test(text) ||
    new RegExp(`\\b${cat.aliases[0]}\\b`, "i").test(text);

  // Prefer list when they ask about the category as a group
  const categoryAsSubject =
    /\b(appetizers?|apps|starters?|tacos?|sandwiches?|sandwhiches?|entrees?|entrées?|favorites|sides?|desserts?|soups?|salads?|raw bar)\b/i.test(
      text
    );

  if (listLike || categoryAsSubject) return cat;
  return null;
}

function formatCategoryList(cat) {
  const items = catalog.items.filter(
    (i) => i.category === cat.id && i.onMenu !== false
  );
  if (!items.length) {
    return `I don't have ${cat.label} loaded yet. Everyday menu: ${everydayMenuLink()}`;
  }

  const lines = items.map((i) => {
    const sold = isItemSoldOut(i);
    return sold.length ? `• ${i.name} — SOLD OUT today` : `• ${i.name}`;
  });

  const soldCount = items.filter((i) => isItemSoldOut(i).length).length;
  return [
    `${cat.label} (everyday menu) — ${restaurant.name}:`,
    ...lines,
    "",
    soldCount
      ? `${soldCount} marked sold out on today's 86 board (demo inventory).`
      : "None of these are marked sold out on today's 86 board.",
    `Everyday menu / order online: ${everydayMenuLink()}`,
    `Chalkboard specials are separate — ask for "today's specials".`,
  ].join("\n");
}

function formatFullMenu() {
  const blocks = [];
  for (const cat of catalog.categories || []) {
    const items = catalog.items.filter(
      (i) => i.category === cat.id && i.onMenu !== false
    );
    if (!items.length) continue;
    blocks.push(
      `${cat.label}:\n` +
        items
          .map((i) => {
            const sold = isItemSoldOut(i);
            return sold.length ? `• ${i.name} (sold out today)` : `• ${i.name}`;
          })
          .join("\n")
    );
  }
  return [
    `Everyday menu (not chalkboard specials) — ${restaurant.name}`,
    `Source: ${everydayMenuLink()}`,
    "",
    ...blocks,
    "",
    `Order online: ${everydayMenuLink()}`,
    `For chalkboard / daily specials, ask "today's specials".`,
  ]
    .join("\n")
    .slice(0, 3900);
}

function findOnChalkboard(item) {
  const board = readCachedBoard();
  const payload = getActiveSpecialsPayload(board);
  const dishes = payload?.dishes || [];
  if (!dishes.length) return null;
  const names = [item.name, ...(item.aliases || [])]
    .map(normalize)
    .filter((n) => n.length >= 10);
  for (const dish of dishes) {
    const dishNorm = normalize(dish.name);
    for (const n of names) {
      if (dishNorm === n || dishNorm.includes(n) || n.includes(dishNorm)) {
        return {
          line: `${dish.name} — $${dish.price}`,
          board,
        };
      }
    }
  }
  return null;
}

function itemLine(item) {
  const sold = isItemSoldOut(item);
  const bit = item.blurb ? ` — ${item.blurb}` : "";
  return sold.length
    ? `• ${item.name}${bit} (SOLD OUT today)`
    : `• ${item.name}${bit}`;
}

function filterItems({ cook, protein, excludeFish, excludeShellfish, mainsOnly }) {
  return catalog.items.filter((i) => {
    if (i.onMenu === false) return false;
    if (mainsOnly && ["sides", "desserts"].includes(i.category)) return false;
    if (excludeFish && i.fish) return false;
    if (excludeShellfish && i.shellfish) return false;
    if (cook && !(i.cook || []).includes(cook)) return false;
    if (protein && !(i.proteins || []).includes(protein)) return false;
    return true;
  });
}

/** "Do y'all have fried fish?" / fried shrimp / grilled fish style asks. */
function answerCookStyle(text) {
  const lower = normalize(text);
  const avail =
    AVAIL_TRIGGERS.test(text) ||
    /\?/.test(text) ||
    /\b(any|options?|choices)\b/i.test(text);

  const wantsFried = /\bfried\b/.test(lower) || /\bbeer[- ]?battered\b/.test(lower);
  const wantsGrilled = /\bgrilled\b/.test(lower) || /\bblackened\b/.test(lower);
  const wantsFish = /\bfish\b/.test(lower) || /\bcod\b/.test(lower) || /\bcatfish\b/.test(lower);
  const wantsShrimp = /\bshrimp\b/.test(lower);
  const wantsChicken = /\bchicken\b/.test(lower);

  if (!avail && !(wantsFried || wantsGrilled)) return null;

  let items = null;
  let headline = null;

  if (wantsFried && wantsFish) {
    // Pure fried fish (skip combo platters that also mix in shellfish)
    items = filterItems({ cook: "fried", protein: "fish" }).filter(
      (i) => !i.shellfish
    );
    headline = "Yes — fried fish options on the everyday menu:";
  } else if (wantsFried && wantsShrimp) {
    items = filterItems({ cook: "fried", protein: "shellfish" }).filter((i) =>
      /shrimp/i.test(i.name)
    );
    headline = "Yes — fried shrimp options:";
  } else if (wantsFried && wantsChicken) {
    items = filterItems({ cook: "fried", protein: "chicken" });
    headline = "Yes — fried / crispy chicken options:";
  } else if (wantsGrilled && wantsFish) {
    items = catalog.items.filter(
      (i) =>
        i.onMenu !== false &&
        i.fish &&
        (i.cook || []).some((c) => c === "grilled" || c === "blackened")
    );
    headline = "Yes — grilled / blackened fish options:";
  } else if (wantsFried && !wantsFish && !wantsShrimp && !wantsChicken) {
    // bare "any fried food?" — too broad; skip
    return null;
  }

  if (!items || !items.length) return null;

  return [
    headline,
    ...items.map(itemLine),
    "",
    `Everyday menu / order: ${everydayMenuLink()}`,
    `Chalkboard specials change daily — ask "today's specials" too.`,
  ].join("\n");
}

/**
 * Non-fish / shellfish-allergy style questions:
 * "what else besides fish?" + "allergic to shellfish"
 */
function answerDietaryOptions(text) {
  const lower = normalize(text);
  const mentionsAllergy = /\ballerg/.test(lower);
  const shellfishAllergy =
    mentionsAllergy &&
    /\b(shellfish|shrimp|crab|oyster|lobster|clam|calamari|crawfish|crawdad)\b/.test(
      lower
    );
  const fishAllergy =
    mentionsAllergy &&
    /\b(fish allergy|allergic to fish|allergic to seafood)\b/.test(lower);
  const noFish =
    fishAllergy ||
    /\b(besides fish|other than fish|no fish|don'?t (want|like|eat) fish|anything but fish|options besides fish|instead of fish|not (a )?fish (person|eater)|hate fish|don't do fish)\b/.test(
      lower
    ) ||
    /\b(what (else|other)|other options|what can i (eat|get|order)).{0,40}\bfish\b/.test(
      lower
    );
  const noShellfish =
    shellfishAllergy ||
    /\b(no shellfish|without shellfish|besides shellfish|other than shellfish)\b/.test(
      lower
    );
  const wantsSuggestions =
    /\b(what|options?|choices|else|besides|other than|instead|can i (eat|get|order)|recommend|suggest)\b/i.test(
      text
    ) ||
    shellfishAllergy ||
    noFish;

  if (!wantsSuggestions) return null;
  if (!noFish && !noShellfish && !shellfishAllergy && !fishAllergy) return null;

  const excludeFish = noFish || fishAllergy;
  const excludeShellfish = noShellfish || shellfishAllergy;

  const mains = filterItems({
    excludeFish,
    excludeShellfish,
    mainsOnly: true,
  }).filter((i) => !["raw-bar"].includes(i.category));

  // Feature non-seafood first; if fish is still allowed, include fish-only dishes too
  const featured = mains.filter((i) => {
    const prots = i.proteins || [];
    if (!excludeFish && i.fish && !i.shellfish) return true;
    return prots.some((p) =>
      ["chicken", "beef", "pork", "vegetarian"].includes(p)
    );
  });
  const list = (featured.length ? featured : mains).slice(0, 14);

  if (!list.length) {
    return withAllergySafety(
      [
        `I don't have a clear non-seafood list loaded for that filter.`,
        `Please call ${restaurant.phone} — especially with allergies, a manager should help you plan.`,
        `Everyday menu: ${everydayMenuLink()}`,
      ].join("\n")
    );
  }

  const constraints = [];
  if (excludeFish) constraints.push("no fish");
  if (excludeShellfish) constraints.push("no shellfish ingredients listed");

  const lines = [
    `Here are everyday-menu options that look ${constraints.join(" + ")} from our catalog:`,
    ...list.map(itemLine),
    "",
    `Sides & desserts are also usually fish/shellfish-free (fries, mac, veggies, brownie, key lime, etc.).`,
  ];

  if (shellfishAllergy || excludeShellfish) {
    lines.push(
      "",
      restaurant.allergies?.shellfish ||
        `Shellfish touches most of our kitchen — we cannot guarantee a shellfish-free environment. Please call ${restaurant.phone} so we can talk through options safely.`
    );
  }

  lines.push(`Everyday menu / order: ${everydayMenuLink()}`);
  return withAllergySafety(lines.join("\n"));
}

/**
 * Guide answers: fried fish, non-fish options, shellfish allergy filters, etc.
 */
export function answerMenuGuide(rawMessage) {
  const text = String(rawMessage || "").trim();
  if (!text) return null;
  return answerDietaryOptions(text) || answerCookStyle(text);
}

/**
 * Category / full-menu listings (appetizers, tacos, sandwiches, entrees…).
 */
export function answerMenuList(rawMessage) {
  const text = String(rawMessage || "").trim();
  if (!text) return null;

  if (wantsFullMenu(text)) return formatFullMenu();

  const cat = wantsCategoryList(text);
  if (cat) return formatCategoryList(cat);

  return null;
}

/**
 * If the guest is asking whether we have a specific item, answer from:
 * 1) 86 / sold-out board (demo inventory)
 * 2) today's chalkboard reading
 * 3) regular menu catalog
 */
export function answerAvailability(rawMessage) {
  const text = String(rawMessage || "").trim();
  if (!text) return null;
  if (asksDishAllergen(text)) return null;

  // Let category lists win over "do you have tacos?"
  if (answerMenuList(text) && findCategory(text) && !findMenuItem(text)) {
    return answerMenuList(text);
  }
  // If they named a category clearly, prefer the list
  const catOnly = wantsCategoryList(text);
  const itemHit = findMenuItem(text);
  if (catOnly && (!itemHit || normalize(itemHit.alias).length <= 5)) {
    // "tacos" as category vs item — if message is really about the category section
    if (
      /\b(appetizers?|apps|tacos?|sandwiches?|sandwhiches?|entrees?|entrées?|sides?|desserts?)\b/i.test(
        text
      ) &&
      !/\b(trout|salmon|broccoli|burger|catfish|redfish|calamari)\b/i.test(text)
    ) {
      return formatCategoryList(catOnly);
    }
  }

  // Style asks like "fried fish" before single-item match
  const style = answerCookStyle(text);
  if (style && !itemHit) return style;
  // If they said "fried fish", alias may hit fish-chips — still nicer to list all fried fish
  if (
    style &&
    itemHit &&
    /\bfried\b/i.test(text) &&
    /\bfish\b/i.test(text) &&
    !/\bfish and chips|fish & chips|fishwich|fish tacos\b/i.test(text)
  ) {
    return style;
  }

  const isAvailabilityAsk =
    AVAIL_TRIGGERS.test(text) ||
    /\?/.test(text) ||
    /^(trout|salmon|shrimp|oysters?|broccoli|brocolli|burger|catfish|redfish)\b/i.test(
      text
    );

  if (!isAvailabilityAsk) return null;

  const found = itemHit || findMenuItem(text);
  if (!found) {
    return answerCookStyle(text);
  }

  const { item } = found;
  const sold = isItemSoldOut(item);
  if (sold.length) {
    const names = sold.map((s) => s.name).join(", ");
    return [
      `We're sold out of ${names} for the day.`,
      `Managers update the 86 board in this bot (demo stand-in for the restaurant count system).`,
      `Everyday menu: ${everydayMenuLink()}`,
      `Or call ${restaurant.phone} to double-check.`,
    ].join("\n");
  }

  if (!item.onMenu) {
    return `I don't show ${item.name} on the everyday menu right now. Ask about today's specials, or call ${restaurant.phone}.`;
  }

  const chalk = findOnChalkboard(item);
  if (chalk?.line) {
    return [
      `Yes — we have ${item.name} on the everyday menu.`,
      item.blurb,
      `Also on today's chalkboard: ${chalk.line}`,
      `Everyday menu: ${everydayMenuLink()}`,
      `Want the chalkboard? Ask for "today's specials".`,
    ].join("\n");
  }

  return [
    `Yes — we have ${item.name} on the everyday menu.`,
    item.blurb,
    `It's not marked sold out on today's 86 board.`,
    `Everyday menu / order: ${everydayMenuLink()}`,
  ].join("\n");
}

export { catalog as menuCatalog, AVAIL_TRIGGERS };
