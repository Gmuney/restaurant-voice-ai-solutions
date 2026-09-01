import {
  detectMessageLanguage,
  hasClearSpanish,
  isTexasEnglishSlang,
} from "../src/engine/language.js";
import { hoursReplyLanguage } from "../src/engine/reply.js";

function assert(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exitCode = 1;
  } else {
    console.log("PASS", label);
  }
}

const slang = [
  "y'all",
  "ya'll",
  "yall",
  "howdy",
  "all y'all",
  "howdy y'all",
  "yall open?",
  "are y'all open",
  "do yall have fries",
];

for (const s of slang) {
  assert(`slang is English: ${s}`, isTexasEnglishSlang(s) || /howdy/i.test(s));
  assert(`detect EN: ${s}`, detectMessageLanguage(s) === "en");
  assert(`not clear Spanish: ${s}`, !hasClearSpanish(s));
}

assert("hours yall stays EN", hoursReplyLanguage("yall open?", "en") === "en");
assert("hours howdy stays EN", hoursReplyLanguage("howdy are y'all open", "en") === "en");
assert(
  "cocina hoy is ES",
  hoursReplyLanguage("¿hasta qué hora tienen abierta la cocina hoy?", "en") ===
    "es"
);

assert("hola is ES", detectMessageLanguage("hola") === "es");
assert("gracias is ES", detectMessageLanguage("gracias") === "es");
assert("abierto is ES", detectMessageLanguage("están abiertos?") === "es");
assert("a que hora is ES", detectMessageLanguage("¿a qué hora abren?") === "es");
assert("horario is ES", detectMessageLanguage("cuál es su horario") === "es");

assert(
  "hola y'all still Spanish greeting",
  detectMessageLanguage("hola") === "es"
);
