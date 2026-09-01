import {
  generateReply,
  faq,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
  composeEscalationReply,
  closingHoursAnswer,
  closingClockForDay,
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
  "Does the blackened salmon have dairy?",
  "Does the grilled salmon have dairy?",
  "Does the fried shrimp have dairy?",
  "What time do y'all close tonight?",
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
  "Yes! We offer a dedicated Kids Menu featuring Kids Fish Sticks, Fried Shrimp, Chicken Strips, Cheeseburgers, Hamburgers, and Mac & Cheese.";
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

const KIDS_SIX_MAINS = [
  "Kids Fish Sticks",
  "Fried Shrimp",
  "Chicken Strips",
  "Cheeseburgers",
  "Hamburgers",
  "Mac & Cheese",
];
const kidsMenuList = generateReply("what's on the kids menu");
const missingMains = KIDS_SIX_MAINS.filter((name) => !kidsMenuList.includes(name));
if (missingMains.length) {
  console.error("FAIL kids menu must list all 6 mains:", missingMains.join(", "));
  console.error("GOT:", kidsMenuList);
  process.exitCode = 1;
} else if (KIDS_SIDES_LIST.includes("Mac & Cheese")) {
  console.error("FAIL Mac & Cheese is a kids entree, not a kids side");
  process.exitCode = 1;
} else {
  console.log("PASS kids menu lists all 6 mains including Mac & Cheese");
}

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

const SIDE_SWAP_BRIEF =
  "We can swap any listed side for another listed side — just tell your server.";
const BLACKENED_DAIRY =
  "Our Blackened Salmon is prepared dairy-free by default";
const GRILLED_SALMON_DAIRY =
  "Our Garlic Caper Grilled Salmon contains butter/dairy in its preparation";
const FISH_CHIPS_GLUTEN = "Our Fish & Chips contains gluten in its preparation";

function assertDishAllergen(label, reply, statusLine) {
  const statusAt = reply.indexOf(statusLine);
  const discAt = reply.indexOf(ALLERGY_DISCLAIMER);
  const sidesAt = reply.indexOf(SIDE_SWAP_BRIEF);
  if (statusAt !== 0) {
    console.error(`FAIL ${label}: must lead with dish status`);
    console.error("GOT:", reply);
    process.exitCode = 1;
    return;
  }
  if (discAt === -1 || discAt < statusLine.length) {
    console.error(`FAIL ${label}: disclaimer must come after dish status`);
    console.error("GOT:", reply);
    process.exitCode = 1;
    return;
  }
  if (sidesAt === -1 || sidesAt < discAt) {
    console.error(`FAIL ${label}: side swap must come after the disclaimer`);
    console.error("GOT:", reply);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${label}`);
}

assertDishAllergen(
  "blackened salmon dairy",
  generateReply("Does the blackened salmon have dairy?"),
  BLACKENED_DAIRY
);
assertDishAllergen(
  "grilled salmon dairy",
  generateReply("Does the grilled salmon have dairy?"),
  GRILLED_SALMON_DAIRY
);
assertDishAllergen(
  "fish and chips gluten",
  generateReply("Does the fish and chips have gluten?"),
  FISH_CHIPS_GLUTEN
);

const FRIED_SHRIMP_DAIRY =
  "Our Fried Shrimp is prepared in a buttermilk batter, so it does contain dairy. However, we can easily prepare your shrimp grilled or blackened for a delicious dairy-free option!";
const FRIED_SHRIMP_SIDES =
  "And feel free to swap out the fries for extra hush puppies or any of our other sides—just let your server know!";

const friedShrimpDairy = generateReply("Does the fried shrimp have dairy?");
if (
  friedShrimpDairy.indexOf(FRIED_SHRIMP_DAIRY) !== 0 ||
  !friedShrimpDairy.includes(FRIED_SHRIMP_SIDES)
) {
  console.error("FAIL fried shrimp dairy: buttermilk + grilled/blackened + hush puppy swap");
  console.error("GOT:", friedShrimpDairy);
  process.exitCode = 1;
} else if (friedShrimpDairy.includes(ALLERGY_DISCLAIMER)) {
  console.error("FAIL fried shrimp dairy must not add generic disclaimer");
  console.error("GOT:", friedShrimpDairy);
  process.exitCode = 1;
} else {
  console.log("PASS fried shrimp dairy natural wrap-up");
}

const friedShrimpSevere = generateReply(
  "I have a severe dairy allergy — does the fried shrimp have dairy?"
);
if (
  !friedShrimpSevere.includes(FRIED_SHRIMP_DAIRY) ||
  !friedShrimpSevere.includes(FRIED_SHRIMP_SIDES) ||
  !friedShrimpSevere.includes(ALLERGY_DISCLAIMER)
) {
  console.error("FAIL fried shrimp severe allergy should add the disclaimer");
  console.error("GOT:", friedShrimpSevere);
  process.exitCode = 1;
} else {
  console.log("PASS fried shrimp severe allergy includes disclaimer");
}

const genericDairy = generateReply("dairy free");
if (genericDairy.includes(BLACKENED_DAIRY) || genericDairy.indexOf(ALLERGY_DISCLAIMER) === 0) {
  console.error("FAIL generic dairy must not use a specific-dish lead-in");
  console.error("GOT:", genericDairy);
  process.exitCode = 1;
} else if (!/dairy/i.test(genericDairy)) {
  console.error("FAIL generic dairy should still talk about dairy");
  process.exitCode = 1;
} else {
  console.log("PASS generic dairy stays generic");
}

for (const [day, clock] of [
  ["sunday", "9:00 PM"],
  ["monday", "9:00 PM"],
  ["tuesday", "9:00 PM"],
  ["wednesday", "9:00 PM"],
  ["thursday", "9:00 PM"],
  ["friday", "10:00 PM"],
  ["saturday", "10:00 PM"],
]) {
  if (closingClockForDay(day) !== clock) {
    console.error(`FAIL close clock ${day}: expected ${clock}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS close clock ${day} ${clock}`);
  }
}

const mondayClose = closingHoursAnswer("en", "monday");
if (
  mondayClose !==
  "Since today is Monday, our kitchen and restaurant close at 9:00 PM tonight!"
) {
  console.error("FAIL Monday closing copy");
  console.error("GOT:", mondayClose);
  process.exitCode = 1;
} else {
  console.log("PASS Monday closing copy");
}

const fridayClose = closingHoursAnswer("en", "friday");
if (
  fridayClose !==
  "Since today is Friday, our kitchen and restaurant close at 10:00 PM tonight!"
) {
  console.error("FAIL Friday closing copy");
  console.error("GOT:", fridayClose);
  process.exitCode = 1;
} else {
  console.log("PASS Friday closing copy");
}

const mondayCloseEs = closingHoursAnswer("es", "monday");
if (
  mondayCloseEs !==
  "Como hoy es lunes, nuestra cocina y restaurante cierran a las 9:00 PM esta noche."
) {
  console.error("FAIL Monday Spanish closing copy");
  console.error("GOT:", mondayCloseEs);
  process.exitCode = 1;
} else {
  console.log("PASS Monday Spanish closing copy");
}

const cocinaHoy = generateReply(
  "¿hasta qué hora tienen abierta la cocina hoy?",
  { language: "es" }
);
if (
  !/^Como hoy es (lunes|martes|miércoles|jueves|viernes|sábado|domingo), nuestra cocina y restaurante cierran a las (9:00 PM|10:00 PM) esta noche\.$/.test(
    cocinaHoy.trim()
  )
) {
  console.error("FAIL Spanish kitchen hours should use today + esta noche");
  console.error("GOT:", cocinaHoy);
  process.exitCode = 1;
} else if (/\btonight\b/i.test(cocinaHoy)) {
  console.error("FAIL Spanish kitchen hours must not include tonight");
  process.exitCode = 1;
} else {
  console.log("PASS Spanish kitchen hours esta noche");
}

const spanishMulti = generateReply(
  "¿hasta qué hora tienen abierta la cocina hoy y se pueden cambiar las papas por ensalada?",
  { language: "es" }
);
if (
  !spanishMulti.includes("nuestra cocina y restaurante cierran a las") ||
  !/esta noche/.test(spanishMulti) ||
  /\btonight\b/i.test(spanishMulti) ||
  !/cambiar cualquier guarnición|podemos cambiar/i.test(spanishMulti)
) {
  console.error("FAIL Spanish multi-intent must answer hours AND side swap in Spanish");
  console.error("GOT:", spanishMulti);
  process.exitCode = 1;
} else if (
  spanishMulti.indexOf("Como hoy es") >
  spanishMulti.search(/cambiar cualquier guarnición|podemos cambiar/i)
) {
  console.error("FAIL Spanish multi-intent should lead with closing hours");
  console.error("GOT:", spanishMulti);
  process.exitCode = 1;
} else {
  console.log("PASS Spanish multi-intent hours + sides");
}

const closeTonight = generateReply("What time do y'all close tonight?");
if (
  !/^Since today is (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), our kitchen and restaurant close at (9:00 PM|10:00 PM) tonight!$/.test(
    closeTonight.trim()
  )
) {
  console.error("FAIL close tonight should use today's weekday and close time");
  console.error("GOT:", closeTonight);
  process.exitCode = 1;
} else {
  console.log("PASS close tonight uses today");
}

const kitchenClose = generateReply("What time does the kitchen close?");
if (!kitchenClose.includes("our kitchen and restaurant close at")) {
  console.error("FAIL kitchen close should use tonight closing copy");
  console.error("GOT:", kitchenClose);
  process.exitCode = 1;
} else {
  console.log("PASS kitchen close uses tonight copy");
}

const dualClose = composeEscalationReply(
  "What time do y'all close tonight? I need a manager",
  { language: "en" }
);
const closeAt = dualClose.indexOf("Since today is");
const handoffAt = dualClose.indexOf(
  "I am alerting our team right now. Please stay on the line while I connect you to a manager."
);
const ringAt = dualClose.indexOf("PHONE RINGING");
if (closeAt !== 0 || handoffAt === -1 || ringAt === -1 || !(closeAt < handoffAt && handoffAt < ringAt)) {
  console.error("FAIL dual close+manager: hours first, then handoff, then ringing");
  console.error("GOT:", dualClose);
  process.exitCode = 1;
} else {
  console.log("PASS dual close+manager hours first");
}

const dualParty = composeEscalationReply(
  "What time do y'all close tonight? party of 12",
  { language: "en", partySize: 12 }
);
if (
  dualParty.indexOf("Since today is") !== 0 ||
  dualParty.indexOf("For a group event of 12 guests") === -1 ||
  dualParty.indexOf("PHONE RINGING") < dualParty.indexOf("For a group event of 12")
) {
  console.error("FAIL dual close+party: hours first then handoff");
  console.error("GOT:", dualParty);
  process.exitCode = 1;
} else {
  console.log("PASS dual close+party hours first");
}
