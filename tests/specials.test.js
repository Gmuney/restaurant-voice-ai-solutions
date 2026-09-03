import {
  parseBoardDishes,
  spokenSpecialsReadout,
  spokenUpdatingBoardReadout,
  guestSpecialsSpeech,
  boardSpecialsReadout,
  getActiveSpecialsPayload,
} from "../src/engine/specials.js";
import {
  looksHallucinated,
  looksGenericMenuFallback,
  isLowConfidenceOcr,
  getVerifiedBoardPayload,
} from "../src/board/read-board.js";

function assert(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exitCode = 1;
  } else {
    console.log("PASS", label);
  }
}

const SAMPLE_BOARD = `Jalapeno Bacon Mahi Tacos — $19
  jalapeno, bacon, slaw
Grilled Redfish Nola — $29
Maple Chipotle Seared Halibut — $38
Voodoo Seafood Pasta — $27
Low Country Porkchop — $26`;

const POISONED_OCR = `ANGEL HAIR PASTA — $21
LOBSTER ROLL — $22
FISH Tacos — $21
SHRIMP Tacos — $18
CRAB CAKE SANDWICH — $21`;

const dishes = parseBoardDishes(SAMPLE_BOARD);
assert("parse 5 chalkboard dishes", dishes.length === 5);
assert(
  "parse mahi tacos",
  dishes[0].name === "Jalapeno Bacon Mahi Tacos" && dishes[0].price === "19"
);
assert("parse redfish nola", dishes[1].name === "Grilled Redfish Nola");
assert("parse halibut", dishes[2].name === "Maple Chipotle Seared Halibut");

const FEATURED_SCRIPT =
  "Our chalkboard specials feature the Jalapeno Bacon Mahi Tacos for $19, Grilled Redfish Nola for $29, and Maple Chipotle Seared Halibut for $38. Would you like me to tell you more about any of those?";

const three = spokenSpecialsReadout(dishes.slice(0, 3));
assert("spoken three-dish readout", three === FEATURED_SCRIPT);

assert(
  "no lobster roll in chalkboard parse",
  parseBoardDishes("Lobster Roll — $24\nAngel Hair Pasta — $18").length === 0
);
assert("generic lobster roll flagged", looksGenericMenuFallback("Lobster Roll $24"));
assert("generic angel hair flagged", looksGenericMenuFallback("Angel Hair Pasta — $18"));
assert("generic fish tacos flagged", looksGenericMenuFallback("Fish Tacos — $21"));
assert("generic shrimp tacos flagged", looksGenericMenuFallback("Shrimp Tacos — $18"));
assert("generic crab cakes flagged", looksGenericMenuFallback("Crab Cakes — $21"));
assert(
  "poisoned OCR yields no payload dishes",
  parseBoardDishes(POISONED_OCR).length === 0
);
assert(
  "hallucinated lobster/angel hair rejected",
  looksHallucinated(
    "Monday specials\nTuesday tacos\nWednesday pasta\nLobster Roll — $24\nAngel Hair Pasta — $18\nextra filler text here"
  )
);

assert(
  "low-confidence board does not invent menu items",
  !boardSpecialsReadout("[unclear] — $22\n[unclear] pasta — $18\n[unclear] [unclear] [unclear] [unclear]").includes(
    "Lobster"
  ) &&
    !boardSpecialsReadout("not enough").includes("Angel Hair") &&
    !boardSpecialsReadout(POISONED_OCR).includes("Fish Tacos") &&
    !boardSpecialsReadout(POISONED_OCR).includes("Shrimp Tacos") &&
    !boardSpecialsReadout(POISONED_OCR).includes("Crab")
);

assert(
  "unclear dishes omitted from spoken list",
  parseBoardDishes("Jalapeno Bacon Mahi Tacos — $19\n[unclear] special — $22").length === 1
);

const PHOTO_TALK =
  /text you a photo|Sending the board|snapshot photo|board photo|send you the board|mando una foto|foto del pizarrón|picture of (today'?s )?board/i;
const GENERIC_SPECIALS_TALK = /\bFish Tacos\b|\bShrimp Tacos\b|\bCrab Cakes\b|\bLobster Roll\b|\bAngel Hair/i;

const fallbackTwo = spokenUpdatingBoardReadout(dishes.slice(0, 2));
assert(
  "updating-board fallback script",
  fallbackTwo ===
    "Our chalkboard specials feature the Jalapeno Bacon Mahi Tacos for $19 and Grilled Redfish Nola for $29. Would you like me to tell you more about any of those?"
);

const lowBoard = {
  text: "[unclear] [unclear] [unclear] [unclear] pasta",
  ocrFallback: true,
  verified: {
    text: SAMPLE_BOARD,
    boardWindow: { window: "evening" },
  },
};
const speech = guestSpecialsSpeech(lowBoard);
assert("low-confidence uses verified payload", speech.mode === "payload");
assert(
  "fallback names come from last verified board",
  speech.text === FEATURED_SCRIPT && !GENERIC_SPECIALS_TALK.test(speech.text)
);
assert("fallback is voice-only", !PHOTO_TALK.test(speech.text));
assert("low-confidence OCR flagged", isLowConfidenceOcr(lowBoard.text));
assert(
  "verified payload recovered",
  getVerifiedBoardPayload(lowBoard)?.text === SAMPLE_BOARD
);

const TWO_DISH_BOARD = `Jalapeno Bacon Mahi Tacos — $19
Grilled Redfish Nola — $29`;

const afterHours = guestSpecialsSpeech({
  text: "[unclear] [unclear] [unclear] [unclear] pasta",
  ocrFallback: true,
  afterHours: true,
  boardWindow: { window: "overnight" },
  verified: { text: TWO_DISH_BOARD, boardWindow: { window: "evening" } },
});
assert("after-hours uses verified snapshot speech", afterHours.mode === "payload");
assert(
  "after-hours dinner script",
  afterHours.text ===
    "Our chalkboard specials feature the Jalapeno Bacon Mahi Tacos for $19 and Grilled Redfish Nola for $29. Would you like me to tell you more about any of those?"
);
assert("after-hours is voice-only", !PHOTO_TALK.test(afterHours.text));

assert(
  "empty current readout stays voice-only",
  !PHOTO_TALK.test(spokenSpecialsReadout([]))
);

const currentSpeech = guestSpecialsSpeech({
  text: SAMPLE_BOARD,
  ocrFallback: false,
});
assert("readable board uses today's priced readout", currentSpeech.mode === "payload");
assert("priced readout has dollar", currentSpeech.text === FEATURED_SCRIPT);
assert("current readout is voice-only", !PHOTO_TALK.test(currentSpeech.text));

const poisonedBoard = {
  text: POISONED_OCR,
  ocrFallback: false,
  active_specials_payload: {
    source: "verified",
    meal: "dinner",
    dishes: dishes.slice(0, 3),
  },
};
const bound = guestSpecialsSpeech(poisonedBoard);
assert("payload binding ignores poisoned OCR", bound.text === FEATURED_SCRIPT);
assert(
  "payload never speaks generic menu items",
  !GENERIC_SPECIALS_TALK.test(bound.text)
);
const payload = getActiveSpecialsPayload(poisonedBoard);
assert(
  "active_specials_payload is the only dish source",
  payload.dishes.length === 3 &&
    payload.dishes[0].name === "Jalapeno Bacon Mahi Tacos" &&
    !payload.dishes.some((d) => /fish tacos|shrimp tacos|crab/i.test(d.name))
);
