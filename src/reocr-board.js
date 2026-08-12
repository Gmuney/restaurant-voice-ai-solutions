import { reocrSnapshot, readCachedBoard } from "./read-board.js";

const path = process.argv[2] || readCachedBoard()?.snapshotPath;
reocrSnapshot(path)
  .then((cache) => {
    console.log("--- transcription ---");
    console.log(cache.text);
    console.log("---");
    console.log("chars=", cache.text.length, "source=", cache.source);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[reocr] failed:", err.message || err);
    process.exit(1);
  });
