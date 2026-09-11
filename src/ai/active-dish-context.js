import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCachedBoard } from "../board/read-board.js";
import { getActiveSpecialsPayload } from "../engine/board-payload.js";
import { KNOWLEDGE_DIR } from "../paths.js";

export const STRONG_SYSTEM_PROMPT = `You are Shelly, a warm and concise restaurant phone agent. Keep every reply under 3 sentences.

CRITICAL RULE – SIDE SUBSTITUTIONS (NEVER BREAK THIS):
- You must ALWAYS use the exact sides of the currently discussed dish.
- NEVER say “fries”, “those fries”, “swap those fries”, or any side that is not listed on the active dish.
- When the caller asks to switch/swap/substitute the sides, first restate the real sides of the dish, then offer alternatives from the everyday sides list.

Correct example:
Caller: “What all comes with the Nola?”
You: “Our Grilled Redfish Nola comes topped with blackened crawfish tails and crawfish cream sauce, and it’s served with crispy okra and cornbread on the side!”
Caller: “Can I switch out the sides?”
You: “Absolutely! The Nola comes with crispy okra and cornbread. You can swap either or both for black beans and rice, mashed potatoes, hush puppies, house-seasoned fries, or coleslaw. What would you like?”

You will receive an [ACTIVE DISH] block every turn. Treat that block as absolute truth.`;

function splitSideLine(value) {
  return String(value || "")
    .split(/,|;|\s+\+\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function loadEverydaySides() {
  try {
    const data = JSON.parse(
      readFileSync(join(KNOWLEDGE_DIR, "everyday-sides.json"), "utf8")
    );
    return Array.isArray(data.sides) ? data.sides : [];
  } catch {
    return [
      "Cuban Black Beans & Rice",
      "Buttermilk Mashed Potatoes",
      "Hush Puppies",
      "House-Seasoned Fries",
      "Virginia's Apple Cider Coleslaw",
    ];
  }
}

function normalizeSpecial(dish) {
  if (!dish?.name) return null;
  return {
    name: dish.name,
    price: dish.price ? `$${dish.price}` : dish.price,
    sides: Array.isArray(dish.sides) ? dish.sides : splitSideLine(dish.sides),
    toppings: Array.isArray(dish.toppings)
      ? dish.toppings
      : splitSideLine(dish.toppings),
  };
}

/** Menu data synced from knowledge/active-specials.json + everyday-sides.json */
export function buildMenuDataForContext(board = readCachedBoard()) {
  const payload = getActiveSpecialsPayload(board);
  const chalkboard_specials = (payload?.dishes || [])
    .map(normalizeSpecial)
    .filter(Boolean);
  return {
    chalkboard_specials,
    everyday_sides: loadEverydaySides(),
  };
}

/**
 * Detects the active dish from conversation history
 * and returns a strict context injection string.
 */
export function getActiveDishContext(history, menu = buildMenuDataForContext()) {
  const specials = menu.chalkboard_specials || [];
  let activeDish = null;

  const conversation = Array.isArray(history) ? history : [];

  for (let i = conversation.length - 1; i >= 0; i--) {
    const text = (conversation[i].content || conversation[i].text || "").toLowerCase();

    for (const dish of specials) {
      const name = dish.name.toLowerCase();

      if (
        text.includes(name) ||
        (name.includes("nola") && text.includes("nola")) ||
        (name.includes("mahi") && (text.includes("mahi") || text.includes("tacos")))
      ) {
        activeDish = dish;
        break;
      }
    }
    if (activeDish) break;
  }

  if (!activeDish) {
    return {
      injection: `\n\n[ACTIVE DISH]\nNone detected. Ask which dish they mean before talking about sides.`,
      activeDish: null,
    };
  }

  const sidesText = activeDish.sides.join(" and ");
  const hasFries = activeDish.sides.some((s) => s.toLowerCase().includes("fries"));
  const everyday = (menu.everyday_sides || []).join(", ");

  return {
    injection: `\n\n[ACTIVE DISH – ABSOLUTE TRUTH]
Dish: ${activeDish.name}
Exact sides you MUST use: ${JSON.stringify(activeDish.sides)}
Everyday substitution sides (offer from this list only): ${everyday}
When the caller asks to switch or swap sides, you MUST say: "The ${activeDish.name} comes with ${sidesText}."
${hasFries ? "" : "NEVER mention fries or 'those fries' — this dish does not come with fries."}`,
    activeDish,
  };
}

function normalizeTurn(m) {
  const role = m.role === "model" || m.role === "assistant" ? "assistant" : "user";
  return {
    role,
    content: String(m.content || m.text || "").trim(),
  };
}

/**
 * Call on EVERY turn before sending to Gemini (or any LLM).
 * Returns the messages array to send (system + conversation turns).
 */
export function buildMessagesForLLM(conversationHistory, menu = buildMenuDataForContext()) {
  const { injection } = getActiveDishContext(conversationHistory, menu);

  const turns = (conversationHistory || [])
    .filter((m) => m && m.role !== "system")
    .map(normalizeTurn)
    .filter((m) => m.content);

  return [
    {
      role: "system",
      content: STRONG_SYSTEM_PROMPT + injection,
    },
    ...turns,
  ];
}

/** @deprecated use getActiveDishContext + STRONG_SYSTEM_PROMPT */
export function injectActiveDishContext(conversationHistory, menu) {
  const { injection, activeDish } = getActiveDishContext(conversationHistory, menu);
  return {
    systemPromptAddition: injection,
    activeDish,
  };
}

/** @deprecated use buildMessagesForLLM */
export function buildSystemInstructionWithActiveDish(
  baseSystemPrompt,
  conversationHistory,
  menu
) {
  const { injection } = getActiveDishContext(conversationHistory, menu);
  return baseSystemPrompt + injection;
}
