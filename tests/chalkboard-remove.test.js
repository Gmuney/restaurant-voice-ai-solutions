import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  managerRemoveChalkboardSpecial,
  handleRemoveSpecialCommand,
  findRemovedChalkboardDish,
  removedChalkboardGuestReply,
  REMOVED_CHALKBOARD_GUEST_REPLY_EN,
  managerAddChalkboardSpecial,
} from "../src/engine/chalkboard-manager.js";
import { getActiveSpecialsPayload } from "../src/engine/specials.js";
import { generateReply } from "../src/engine/reply.js";
import { answerAvailability } from "../src/engine/menu-check.js";
import { KNOWLEDGE_DIR, DATA_DIR } from "../src/paths.js";
import { getChalkboardTakenOff } from "../src/store.js";

const SEED_FILE = join(KNOWLEDGE_DIR, "active-specials.json");
const TAKEN_OFF_FILE = join(DATA_DIR, "chalkboard-taken-off.json");

const seedSnapshot = readFileSync(SEED_FILE, "utf8");
let takenOffSnapshot = null;
try {
  takenOffSnapshot = readFileSync(TAKEN_OFF_FILE, "utf8");
} catch {
  takenOffSnapshot = null;
}

function restore() {
  writeFileSync(SEED_FILE, seedSnapshot);
  if (takenOffSnapshot != null) writeFileSync(TAKEN_OFF_FILE, takenOffSnapshot);
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
  managerAddChalkboardSpecial(
    "Takeoff Test Special | 55 | test line | test sides"
  );
  const before = getActiveSpecialsPayload()?.dishes?.some((d) =>
    /takeoff test special/i.test(d.name)
  );
  assert("setup dish on payload", before);

  const { dish } = managerRemoveChalkboardSpecial("Takeoff Test Special", "test");
  assert("remove returns canonical name", dish.name === "Takeoff Test Special");

  const after = getActiveSpecialsPayload()?.dishes?.some((d) =>
    /takeoff test special/i.test(d.name)
  );
  assert("dish gone from live payload", !after);

  assert(
    "taken-off registry records dish",
    getChalkboardTakenOff().removed.some((r) =>
      /takeoff test special/i.test(r.name)
    )
  );

  assert(
    "guest match on removed name",
    Boolean(findRemovedChalkboardDish("do you have the takeoff test special"))
  );

  assert(
    "guest reply exact copy",
    removedChalkboardGuestReply("en") === REMOVED_CHALKBOARD_GUEST_REPLY_EN
  );

  const reply = generateReply("Can I get the Takeoff Test Special?");
  assert("generateReply uses sold-out script", reply.includes("sold out of that feature"));

  const avail = answerAvailability("Do you have Takeoff Test Special?");
  assert("availability uses sold-out script", avail?.includes("sold out of that feature"));

  managerAddChalkboardSpecial("Takeoff Test Special | 55 | test line | test sides");
  assert(
    "re-add clears taken-off list",
    !getChalkboardTakenOff().removed.some((r) =>
      /takeoff test special/i.test(r.name)
    )
  );
  managerRemoveChalkboardSpecial("Takeoff Test Special", "test");

  managerAddChalkboardSpecial("Takeoff Test Special | 55 | a | b");
  const ok = handleRemoveSpecialCommand("/takeoffspecial [Takeoff Test Special]");
  assert(
    "middleware success copy",
    ok?.text ===
      '[MANAGER OVERRIDE: Successfully removed "Takeoff Test Special" from live Chalkboard Specials.]'
  );

  const missing = handleRemoveSpecialCommand("/takeoffspecial Not On Board Dish");
  assert(
    "middleware not found copy",
    missing?.text ===
      '[MANAGER OVERRIDE: "Not On Board Dish" was not found in active Chalkboard Specials.]'
  );

  assert("middleware ignores non-command", handleRemoveSpecialCommand("takeoff salmon") === null);
} finally {
  restore();
}
