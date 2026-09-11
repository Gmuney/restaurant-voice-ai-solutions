import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getSoldOut,
  addSoldOut,
  removeSoldOut,
  findSoldOutMatch,
  findReinstatedMatch,
} from "../src/store.js";
import { answerAvailability } from "../src/engine/menu-check.js";
import { generateReply } from "../src/engine/reply.js";
import { DATA_DIR } from "../src/paths.js";

const snapshot = JSON.stringify(getSoldOut(), null, 2) + "\n";
const soldPath = join(DATA_DIR, "soldout.json");

function restore() {
  writeFileSync(soldPath, snapshot);
}

try {
  const availableAsk = answerAvailability("Is the trout 86'd?");
  if (!availableAsk || !/currently available on our menu tonight/i.test(availableAsk)) {
    console.error("FAIL conversational 86'd ask must not change inventory and should confirm availability");
    console.error("GOT:", availableAsk);
    process.exitCode = 1;
  } else if (/MANAGER OVERRIDE/i.test(availableAsk)) {
    console.error("FAIL guest 86'd ask must not trigger manager override copy");
    process.exitCode = 1;
  } else {
    console.log("PASS conversational 86'd ask answers availability only");
  }

  addSoldOut("Broccoli", "test");
  if (!findSoldOutMatch("do you have broccoli").length) {
    console.error("FAIL 86'd broccoli should match a guest ask");
    process.exitCode = 1;
  } else {
    console.log("PASS sold-out match while 86'd");
  }

  const stillOut = generateReply("do you have broccoli");
  if (/Great news! Our chef just got a fresh shipment/i.test(stillOut)) {
    console.error("FAIL still-86'd item must not use the restock script");
    console.error("GOT:", stillOut);
    process.exitCode = 1;
  } else {
    console.log("PASS 86'd item is not announced as back");
  }

  const ok = removeSoldOut("Broccoli", "test");
  if (!ok || findSoldOutMatch("broccoli").length) {
    console.error("FAIL un-86 must clear broccoli from the sold-out list");
    process.exitCode = 1;
  } else if (!findReinstatedMatch("do you have broccoli").length) {
    console.error("FAIL un-86 must mark broccoli as reinstated");
    process.exitCode = 1;
  } else {
    console.log("PASS un-86 clears sold-out and marks reinstated");
  }

  const SCRIPT =
    "Great news! Our chef just got a fresh shipment of Broccoli, so that is back in stock and available tonight!";
  for (const q of [
    "do you have broccoli",
    "can I get broccoli",
    "can my kid get broccoli",
  ]) {
    const a = generateReply(q);
    if (a !== SCRIPT) {
      console.error(`FAIL reinstated script: "${q}"`);
      console.error("GOT:", a);
      process.exitCode = 1;
    } else if (/un-?86|\b68\b|middleware|system flag|86 board/i.test(a)) {
      console.error(`FAIL guest must not hear inventory commands: "${q}"`);
      console.error("GOT:", a);
      process.exitCode = 1;
    } else {
      console.log("PASS reinstated shipment:", q);
    }
  }
} finally {
  restore();
}
