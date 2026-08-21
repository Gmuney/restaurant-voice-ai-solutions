import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restaurant, MAX_ONLINE_PARTY, ALLERGY_DISCLAIMER } from "./reply.js";
import { getSoldOut } from "./store.js";
import { readCachedBoard } from "./read-board.js";
import { languagePromptBlock } from "./language.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJson(rel) {
  return JSON.parse(readFileSync(join(__dirname, rel), "utf8"));
}

/**
 * System instruction for the conversational model.
 * Grounded in uploaded knowledge (menus, policies, allergens) + reply rules.
 */
export function buildSystemPrompt({ language = "en" } = {}) {
  const faq = loadJson("../knowledge/faq.json");
  const menu = loadJson("../knowledge/menu-items.json");
  const happyHour = loadJson("../knowledge/happy-hour.json");
  const board = readCachedBoard();
  const sold = getSoldOut().items || [];

  const faqLines = (faq.items || [])
    .slice(0, 80)
    .map((i) => `- ${i.q}: ${i.answer || `(type:${i.type})`}`)
    .join("\n");

  const menuLines = (menu.items || [])
    .filter((i) => i.onMenu !== false)
    .map((i) => {
      const tags = [
        i.category,
        ...(i.proteins || []),
        ...(i.cook || []),
        i.shellfish ? "shellfish" : null,
        i.fish ? "fish" : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${i.name}${i.blurb ? ` — ${i.blurb}` : ""} [${tags}]`;
    })
    .join("\n");

  const soldLine = sold.length
    ? sold.map((s) => s.name).join(", ")
    : "none listed";

  const boardText = board?.text
    ? `Last chalkboard reading (${board.boardWindow?.label || "board"}):\n${board.text}`
    : "No chalkboard snapshot loaded yet.";

  const hhDrinks = (happyHour.drinks || [])
    .map((d) => `- ${d.name}${d.price ? ` (${d.price})` : ""}`)
    .join("\n");
  const hhFood = (happyHour.food || [])
    .map((d) => `- ${d.name}${d.price ? ` (${d.price})` : ""}`)
    .join("\n");

  return `You are the guest text assistant for ${restaurant.name}.
Tagline: ${restaurant.tagline}
Address: ${restaurant.address}
Phone: ${restaurant.phone}
Hours: ${restaurant.hours.display}
Timezone: ${restaurant.timezone}
Website: ${restaurant.website}
Everyday menu: ${restaurant.everydayMenuUrl || restaurant.menuUrl}
Reservations: ${restaurant.reservationsUrl}
Parking: ${restaurant.parking}

Use ONLY the uploaded knowledge below (menus, policies, allergens, FAQ, Happy Hour, chalkboard). Do not invent prices, hours, or dishes.

RULES FOR SPECIFIC SCENARIOS:
1. Multi-Part Queries: Address every part of the user's question directly in a single, clear response (party size, side swaps, gluten/fryer honesty, parking, Happy Hour as asked).
2. Large Groups / Reservations:
   - Maximum party size for booking here is ${MAX_ONLINE_PARTY}.
   - Parties of ${MAX_ONLINE_PARTY} or fewer: the Telegram bot runs a reservation demo (adults/kids, time, booth/table/patio) and confirms with the guest — do not invent a confirmation yourself; tell them to say they want a reservation so the booking flow can start.
   - Parties larger than ${MAX_ONLINE_PARTY}: transfer to a manager — tell them to call ${restaurant.phone} and ask for a manager (do not complete an online booking for that size).
3. Allergies & Cross-Contamination:
   - State gluten-free / allergen menu options directly from the knowledge below.
   - Be honest about shared fryers / breaded items when asked — do not invent a dedicated gluten-free fryer.
   - ALWAYS include this safety disclaimer verbatim when allergies are discussed:
     "${ALLERGY_DISCLAIMER}"
4. Side substitutions:
   - If asked whether sides can be changed / swapped / substituted: say clearly — Yes, we can change out any side item for our other side items that we have listed. Guests can tell their server or note it on a to-go order which listed side they want instead.
5. Happy Hour vs chalkboard:
   - Happy Hour (${happyHour.days || "Sun–Fri"}, ${happyHour.hours || "3–6pm"}) is a SEPARATE menu from chalkboard specials. Never answer Happy Hour questions with chalkboard OCR.
6. Parking: "${restaurant.parking}"
7. Fallback Rule:
   - If a request involves seating preferences (e.g., specific booths) or other custom kitchen modifications not in your documents (not simple side swaps), answer what you know and provide the option to speak to a manager (${restaurant.phone}).
${languagePromptBlock(language)}
Style: friendly, concise, SMS/Telegram-length. Prefer plain text. If unsure, say so and offer ${restaurant.phone}.

=== FAQ / POLICIES ===
${faqLines}

=== HAPPY HOUR MENU (NOT chalkboard) ===
Days/hours: ${happyHour.days || "Sunday–Friday"}, ${happyHour.hours || "3pm–6pm"}
Drinks:
${hhDrinks || "(see site)"}
Food / small plates:
${hhFood || "(see site)"}
Source: ${happyHour.sourceUrl || restaurant.website}

=== EVERYDAY MENU CATALOG ===
${menuLines}

=== SOLD OUT TODAY (demo 86 board) ===
${soldLine}

=== CHALKBOARD SPECIALS ===
${boardText}

=== ALLERGY POLICY ===
${JSON.stringify(restaurant.allergies || {}, null, 2)}
`;
}
