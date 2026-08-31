import {
  generateReply,
  faq,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
} from "../src/engine/reply.js";

const samples = [
  "how big can my party be when reserving",
  "can i book a party of 12?",
  "party of 15 for saturday",
  "book a table for 4",
  "are you open and do you have gluten free options",
  "shellfish allergy",
  "gluten free",
  "can we sit in a booth by the window",
  "can you make the fish without butter",
  "happy hour",
  "do you cater",
  "parking",
  "what's the wait",
  "kids menu",
  "what sides come with a kids meal",
  "can my kid get broccoli",
];

console.log("FAQ items:", faq.items.length);
console.log("maxOnlinePartySize:", MAX_ONLINE_PARTY);
console.log("allergyDisclaimer:", ALLERGY_DISCLAIMER);
console.log("---");
for (const c of samples) {
  const a = generateReply(c);
  console.log("Q:", c);
  console.log("A:", a);
  if (/\ballerg|gluten|shellfish|dairy|nut\b/i.test(c)) {
    console.log(
      "HAS_DISCLAIMER:",
      a.includes(ALLERGY_DISCLAIMER) ? "yes" : "MISSING"
    );
  }
  console.log("---");
}

const KIDS_ENTREES =
  "Yes! We offer a dedicated Kids Menu featuring Kids Fish Sticks, Fried Shrimp, Chicken Strips, Cheeseburgers, and Hamburgers.";
const KIDS_SIDES_BRIEF =
  "All kids meals include your choice of ONE side, and we can substitute pretty much any standard side upon request!";
const KIDS_SIDES_LIST =
  "Broccoli, Virginia's Apple Cider Coleslaw, Corn on the Cob, White Rice, Hush Puppies, or Fries";

function assertKidsGeneral(label, reply) {
  if (!reply.includes(KIDS_ENTREES) || !reply.includes(KIDS_SIDES_BRIEF)) {
    console.error(`FAIL ${label}: need entrees first + brief ONE side line`);
    console.error("GOT:", reply);
    process.exitCode = 1;
    return;
  }
  if (reply.indexOf(KIDS_ENTREES) > reply.indexOf(KIDS_SIDES_BRIEF)) {
    console.error(`FAIL ${label}: entrees must come before the side line`);
    process.exitCode = 1;
    return;
  }
  if (reply.includes(KIDS_SIDES_LIST)) {
    console.error(`FAIL ${label}: must not list individual sides unless asked`);
    console.error("GOT:", reply);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${label}`);
}

assertKidsGeneral("kids menu", generateReply("kids menu"));
assertKidsGeneral("family options", generateReply("family options"));
assertKidsGeneral("options for children", generateReply("options for children"));
assertKidsGeneral("kids options", generateReply("kids options"));

const kidsSidesAsk = generateReply("what sides come with that?");
if (
  !kidsSidesAsk.includes(KIDS_ENTREES) ||
  !kidsSidesAsk.includes(KIDS_SIDES_BRIEF) ||
  !kidsSidesAsk.includes(KIDS_SIDES_LIST)
) {
  console.error("FAIL what sides come with that: should add the side list");
  console.error("GOT:", kidsSidesAsk);
  process.exitCode = 1;
} else if (/SOLD OUT|We're sold out of/i.test(kidsSidesAsk)) {
  console.error("FAIL kids sides must not volunteer 86'd items");
  process.exitCode = 1;
} else {
  console.log("PASS what sides come with that lists sides");
}

const kidsSidesMeal = generateReply("what sides come with a kids meal");
if (!kidsSidesMeal.includes(KIDS_SIDES_LIST)) {
  console.error("FAIL kids meal sides should list sides");
  process.exitCode = 1;
} else {
  console.log("PASS kids meal sides lists sides");
}

const sideOptions = generateReply("what are the side options?");
if (!sideOptions.includes(KIDS_SIDES_LIST)) {
  console.error("FAIL side options should list named kids sides");
  process.exitCode = 1;
} else {
  console.log("PASS side options lists named kids sides");
}
