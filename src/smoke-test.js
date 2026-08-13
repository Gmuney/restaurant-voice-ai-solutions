import {
  generateReply,
  faq,
  MAX_ONLINE_PARTY,
  ALLERGY_DISCLAIMER,
} from "./reply.js";

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
