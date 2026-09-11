import {
  buildMessagesForLLM,
  getActiveDishContext,
  buildMenuDataForContext,
  STRONG_SYSTEM_PROMPT,
} from "../src/ai/active-dish-context.js";
import { splitLlmMessages } from "../src/ai/chat.js";

function assert(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exitCode = 1;
  } else {
    console.log("PASS", label);
  }
}

const menu = buildMenuDataForContext();

const redfishHistory = [
  { role: "user", content: "Tell me about the Grilled Redfish Nola" },
  { role: "model", content: "Our special tonight..." },
  { role: "user", content: "Can I swap the sides?" },
];

const bound = getActiveDishContext(redfishHistory, menu);
assert("detects redfish from history", bound.activeDish?.name === "Grilled Redfish Nola");
assert(
  "injects exact sides array",
  bound.injection.includes('"crispy okra"') &&
    bound.injection.includes('"cornbread"')
);
assert(
  "active dish absolute truth header",
  bound.injection.includes("[ACTIVE DISH – ABSOLUTE TRUTH]")
);

const nolaOnly = getActiveDishContext(
  [{ role: "user", content: "what comes on the Nola?" }],
  menu
);
assert("Nola alias binds redfish", nolaOnly.activeDish?.name === "Grilled Redfish Nola");

const empty = getActiveDishContext([{ role: "user", content: "Can I swap the fries?" }], menu);
assert("no dish clarifies before swap", empty.activeDish === null);
assert("no-dish block", empty.injection.includes("[ACTIVE DISH]"));

const llmMessages = buildMessagesForLLM(redfishHistory, menu);
assert("buildMessagesForLLM leads with system", llmMessages[0]?.role === "system");
assert(
  "system includes STRONG_SYSTEM_PROMPT",
  llmMessages[0].content.startsWith(STRONG_SYSTEM_PROMPT.slice(0, 40))
);
assert(
  "system includes ACTIVE DISH block",
  llmMessages[0].content.includes("[ACTIVE DISH – ABSOLUTE TRUTH]")
);
assert("turns follow system", llmMessages.length === redfishHistory.length + 1);
assert(
  "assistant role normalized",
  llmMessages[2].role === "assistant" && llmMessages[3].role === "user"
);

const split = splitLlmMessages(llmMessages);
assert("split extracts system for Gemini", split.systemInstruction.includes("Shelly"));
assert("split keeps user turns", split.turns.length === 3);
