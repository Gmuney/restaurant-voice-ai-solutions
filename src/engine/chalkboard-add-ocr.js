import {
  looksGenericMenuFallback,
  transcribeImageWithPrompt,
} from "../board/read-board.js";

export const ADD_SPECIAL_UNREADABLE_MESSAGE =
  "The photo has severe glare or small handwriting. Please retake the photo closer to the board or type the details manually: /addspecial Dish Name | Price | Sides";

export const ADD_SPECIAL_OCR_PROMPT = `This photo shows handwritten chalk for ONE Fish City Grill seafood chalkboard special.

Extract ONLY what is clearly visible: dish name, price (2–3 digit number), description/ingredients (smaller line under the name), and sides if written separately.

Output ONLY one JSON object. No markdown fences. No extra text.

If glare, blur, or handwriting is too small to read accurately — do NOT guess — output exactly:
{"status":"ERROR_UNREADABLE","message":"${ADD_SPECIAL_UNREADABLE_MESSAGE}"}

If readable, output exactly:
{"name":"Dish Name","price":"26","toppings":"visible ingredients","sides":"visible sides"}

Rules:
- Use key "toppings" for the description/ingredients line under the dish name. Omit "toppings" if not visible.
- Omit "sides" if not explicitly written on the board.
- Price: digits only, no dollar sign.
- Never invent menu items (no default fries, coleslaw, lobster roll, fish tacos, etc.).
- If dish name OR price cannot be read with confidence, use ERROR_UNREADABLE instead of guessing.`;

function unreadablePayload(message = ADD_SPECIAL_UNREADABLE_MESSAGE) {
  return { status: "ERROR_UNREADABLE", message };
}

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const slice = fenced ? fenced[1].trim() : raw;
  const start = slice.indexOf("{");
  const end = slice.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(slice.slice(start, end + 1));
  } catch {
    return null;
  }
}

function hasUnclear(text) {
  return /\[unclear\]/i.test(String(text || ""));
}

/** Validate OCR JSON — zero hallucination; no invented fries/sides. */
export function interpretAddSpecialOcrText(text) {
  if (!String(text || "").trim()) {
    return unreadablePayload();
  }

  const json = extractJsonObject(text);
  if (!json || typeof json !== "object") {
    return unreadablePayload();
  }

  if (json.status === "ERROR_UNREADABLE") {
    return {
      status: "ERROR_UNREADABLE",
      message: String(json.message || ADD_SPECIAL_UNREADABLE_MESSAGE).trim(),
    };
  }

  const name = String(json.name || "").replace(/\s+/g, " ").trim();
  const price = String(json.price || "")
    .replace(/^\$/, "")
    .match(/\d{2,3}/)?.[0];
  const toppings = String(json.toppings || json.description || "")
    .replace(/\s+/g, " ")
    .trim();
  const sides = String(json.sides || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name || !price || name.length < 3) {
    return unreadablePayload();
  }
  if (hasUnclear(name) || hasUnclear(price) || hasUnclear(toppings) || hasUnclear(sides)) {
    return unreadablePayload();
  }
  if (looksGenericMenuFallback(name)) {
    return unreadablePayload();
  }
  if (looksGenericMenuFallback(`${name} ${toppings} ${sides}`)) {
    return unreadablePayload();
  }

  const pseudoBoard = `${name} — $${price}\n  ${toppings || sides || ""}`;
  if (looksGenericMenuFallback(pseudoBoard) && !toppings && !sides) {
    return unreadablePayload();
  }

  const dish = { name, price };
  if (toppings) dish.toppings = toppings;
  if (sides) dish.sides = sides;

  return dish;
}

export function addSpecialOcrResultToMenuJson(result) {
  if (result?.status === "ERROR_UNREADABLE") {
    return {
      status: "ERROR_UNREADABLE",
      message: result.message || ADD_SPECIAL_UNREADABLE_MESSAGE,
    };
  }
  if (!result?.name || !result?.price) {
    return unreadablePayload();
  }
  const row = { name: result.name, price: result.price };
  if (result.toppings) row.toppings = result.toppings;
  if (result.sides) row.sides = result.sides;
  return row;
}

export async function extractAddSpecialDishFromPhoto(imageBuf) {
  const text = await transcribeImageWithPrompt(imageBuf, ADD_SPECIAL_OCR_PROMPT);
  const interpreted = interpretAddSpecialOcrText(text);
  return addSpecialOcrResultToMenuJson(interpreted);
}
