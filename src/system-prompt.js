import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { restaurant, MAX_ONLINE_PARTY, ALLERGY_DISCLAIMER } from "./reply.js";
import { getSoldOut } from "./store.js";
import { readCachedBoard } from "./read-board.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJson(rel) {
  return JSON.parse(readFileSync(join(__dirname, rel), "utf8"));
}

/**
 * System instruction for the conversational model.
 * Grounded in uploaded knowledge (menus, policies, allergens) + reply rules.
 */
export function buildSystemPrompt() {
  const faq = loadJson("../knowledge/faq.json");
  const menu = loadJson("../knowledge/menu-items.json");
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

  return `You are the guest text assistant for ${restaurant.name}.
Tagline: ${restaurant.tagline}
Address: ${restaurant.address}
Phone: ${restaurant.phone}
Hours: ${restaurant.hours.display}
Timezone: ${restaurant.timezone}
Website: ${restaurant.website}
Everyday menu: ${restaurant.everydayMenuUrl || restaurant.menuUrl}
Reservations: ${restaurant.reservationsUrl}

Use ONLY the uploaded knowledge below (menus, policies, allergens, FAQ, chalkboard). Do not invent prices, hours, or dishes.

RULES FOR SPECIFIC SCENARIOS:
1. Multi-Part Queries: Address every part of the user's question directly in a single, clear response.
2. Large Groups / Reservations:
   - Usual online / chat booking size is parties of ${MAX_ONLINE_PARTY} or fewer.
   - For parties over ${MAX_ONLINE_PARTY}, do NOT shut the guest down. Say we may be able to accommodate their request, then give the option to speak with a manager at ${restaurant.phone} (or leave details here for a manager follow-up).
3. Allergies & Cross-Contamination:
   - State gluten-free / allergen menu options directly from the knowledge below.
   - ALWAYS include this safety disclaimer verbatim when allergies are discussed:
     "${ALLERGY_DISCLAIMER}"
4. Fallback Rule:
   - If a request involves seating preferences (e.g., specific booths) or custom kitchen modifications not in your documents, answer what you know and provide the option to speak to a manager (${restaurant.phone}).

Style: friendly, concise, SMS/Telegram-length. Prefer plain text. If unsure, say so and offer ${restaurant.phone}.

=== FAQ / POLICIES ===
${faqLines}

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
