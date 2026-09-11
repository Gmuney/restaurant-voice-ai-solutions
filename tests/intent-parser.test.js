import {
  parseGuestIntent,
  isSideSubstitutionQuery,
  contextualSideSubstitutionQuery,
  resolveActiveDishName,
  SUBSTITUTE_SIDE_INTENT,
  SWAP_SIDES_ACTION,
  HAPPY_HOUR_BURGER_DISH,
} from "../src/engine/intent-parser.js";

function assert(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exitCode = 1;
  } else {
    console.log("PASS", label);
  }
}

assert("side swap phrasing detected", isSideSubstitutionQuery("can I swap the side on the mahi tacos"));
assert(
  "changing sides phrasing detected",
  isSideSubstitutionQuery("changing the sides on the nola")
);
assert(
  "change them follow-up with active dish",
  contextualSideSubstitutionQuery("can I change them", {
    activeDishName: "Grilled Redfish Nola",
  })
);
assert("partial okra swap detected", isSideSubstitutionQuery("Can I switch out the okra or cornbread?"));
assert("hours not side swap", !isSideSubstitutionQuery("What time do y'all close tonight?"));

const mahiParsed = parseGuestIntent("can I swap the side on the mahi tacos");
assert(
  "mahi maps to SUBSTITUTE_SIDE",
  mahiParsed?.intent === SUBSTITUTE_SIDE_INTENT &&
    mahiParsed.requested_action === SWAP_SIDES_ACTION &&
    mahiParsed.active_dish === "Jalapeno Bacon Mahi Tacos"
);

const redfishParsed = parseGuestIntent("Can I switch the sides on the Redfish Nola");
assert(
  "redfish maps to SUBSTITUTE_SIDE",
  redfishParsed?.active_dish === "Grilled Redfish Nola"
);

const hhParsed = parseGuestIntent("Can I change the side on the Double Bacon Cheeseburger?");
assert(
  "HH burger active dish",
  hhParsed?.active_dish === HAPPY_HOUR_BURGER_DISH
);

const contextual = parseGuestIntent("Can I switch out the okra or cornbread?", {
  recentMessages: ["Tell me about the Grilled Redfish Nola"],
});
assert(
  "context history resolves redfish without naming dish in swap ask",
  contextual?.intent === SUBSTITUTE_SIDE_INTENT &&
    contextual.active_dish === "Grilled Redfish Nola"
);

const noDish = parseGuestIntent("Can I switch out the fries?");
assert("no active dish yields null payload", noDish === null);

assert(
  "resolveActiveDishName from history only",
  resolveActiveDishName("swap sides please", {
    recentMessages: ["what sides come with the mahi tacos"],
  }) === "Jalapeno Bacon Mahi Tacos"
);

assert(
  "the Nola alias resolves to Grilled Redfish Nola",
  resolveActiveDishName("can I swap the sides on the Nola") === "Grilled Redfish Nola"
);
