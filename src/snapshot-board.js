/**
 * Cron entrypoint: grab chalkboard photo + OCR once.
 * Usage:
 *   node src/snapshot-board.js            # auto lunch/evening from clock
 *   node src/snapshot-board.js lunch
 *   node src/snapshot-board.js evening
 */
import { snapshotBoard, currentBoardWindow } from "./read-board.js";

const arg = (process.argv[2] || "").toLowerCase();
const windowName =
  arg === "lunch" || arg === "evening" ? arg : currentBoardWindow().snapshotWindow;

snapshotBoard(windowName)
  .then((cache) => {
    console.log("[snapshot] ok", cache.boardWindow, "chars=", cache.text.length);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[snapshot] failed:", err.message || err);
    process.exit(1);
  });
