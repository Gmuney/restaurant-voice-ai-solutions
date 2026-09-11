import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAddSpecialArg,
  managerAddChalkboardSpecial,
} from "../src/engine/chalkboard-manager.js";
import {
  interpretAddSpecialOcrText,
  ADD_SPECIAL_UNREADABLE_MESSAGE,
} from "../src/engine/chalkboard-add-ocr.js";
import { getActiveSpecialsPayload } from "../src/engine/specials.js";
import { KNOWLEDGE_DIR } from "../src/paths.js";

const SEED_FILE = join(KNOWLEDGE_DIR, "active-specials.json");
const snapshot = readFileSync(SEED_FILE, "utf8");

function restore() {
  writeFileSync(SEED_FILE, snapshot);
}

function assert(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exitCode = 1;
  } else {
    console.log("PASS", label);
  }
}

try {
  const pipe = parseAddSpecialArg(
    "Test Manager Dish | 99 | test topping | test sides"
  );
  assert("parse pipe format name", pipe.name === "Test Manager Dish");
  assert("parse pipe format price", pipe.price === "99");
  assert("parse pipe toppings", pipe.toppings === "test topping");
  assert("parse pipe sides", pipe.sides === "test sides");

  const dollar = parseAddSpecialArg("Another Special $42 toppings: a sides: b");
  assert("parse dollar format", dollar.name === "Another Special" && dollar.price === "42");

  const { dish } = managerAddChalkboardSpecial(
    "Test Manager Dish | 99 | test topping | test sides"
  );
  assert("persist returns dish name", dish.name === "Test Manager Dish");

  const payload = getActiveSpecialsPayload();
  const live = payload?.dishes?.find(
    (d) => d.name.toLowerCase() === "test manager dish"
  );
  assert("new dish live on payload immediately", Boolean(live && live.price === "99"));

  managerAddChalkboardSpecial("Test Manager Dish | 88 | updated | sides");
  const updated = getActiveSpecialsPayload()?.dishes?.find(
    (d) => d.name.toLowerCase() === "test manager dish"
  );
  assert("upsert updates price", updated?.price === "88");
  assert("upsert updates toppings", updated?.toppings === "updated");

  const okJson = interpretAddSpecialOcrText(
    '{"name":"Blackened Trout","price":"28","toppings":"blackening spice","sides":"rice, coleslaw"}'
  );
  assert("OCR JSON parses dish", okJson.name === "Blackened Trout" && okJson.price === "28");
  assert("OCR maps description to toppings", okJson.toppings === "blackening spice");

  const descKey = interpretAddSpecialOcrText(
    '{"name":"Test Board Dish","price":"31","description":"gulf shrimp"}'
  );
  assert("OCR description field", descKey.toppings === "gulf shrimp");

  const err = interpretAddSpecialOcrText(
    `{"status":"ERROR_UNREADABLE","message":"${ADD_SPECIAL_UNREADABLE_MESSAGE}"}`
  );
  assert("OCR unreadable status", err.status === "ERROR_UNREADABLE");

  const lobster = interpretAddSpecialOcrText(
    '{"name":"Lobster Roll","price":"24","sides":"fries"}'
  );
  assert("OCR rejects hallucinated lobster roll", lobster.status === "ERROR_UNREADABLE");

  const unclear = interpretAddSpecialOcrText(
    '{"name":"[unclear] Pasta","price":"22","sides":"fries"}'
  );
  assert("OCR rejects unclear name", unclear.status === "ERROR_UNREADABLE");
} finally {
  restore();
}
