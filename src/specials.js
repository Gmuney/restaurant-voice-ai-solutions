import { restaurant } from "./reply.js";
import { getSpecialsText } from "./store.js";
import {
  getBoardReading,
  formatBoardReading,
  readCachedBoard,
  isBoardCacheFresh,
} from "./read-board.js";

/** Pull a dish block (name + following small ingredient/sides lines) from board text. */
function extractDishBlock(boardText, query) {
  if (!boardText) return null;
  const lines = boardText.split(/\n/).map((l) => l.trimEnd());
  const words = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          "what",
          "about",
          "special",
          "specials",
          "chalkboard",
          "today",
          "todays",
          "have",
          "tell",
          "ingredients",
          "describe",
          "description",
        ].includes(w)
    );
  if (!words.length) return null;

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const score = words.reduce((s, w) => (lower.includes(w) ? s + w.length : s), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 4) return null;

  const block = [lines[bestIdx]];
  for (let j = bestIdx + 1; j < lines.length && j < bestIdx + 5; j++) {
    const line = lines[j];
    if (!line.trim()) break;
    // stop if next looks like a new priced dish heading
    if (/\$?\d{2,3}\b/.test(line) && !/^\s/.test(line) && j > bestIdx) break;
    if (/^[A-Z][A-Za-z].{8,}/.test(line) && /\$?\d{2}/.test(line) && j > bestIdx) break;
    block.push(line);
  }
  return block.join("\n").trim();
}

export function specialsImageUrl() {
  return `${restaurant.dailySpecialsImageUrl}?t=${Date.now()}`;
}

export function specialsCaption() {
  const saved = getSpecialsText();
  const board = readCachedBoard();
  const lines = [
    `Chalkboard specials — ${restaurant.name}`,
    board?.boardWindow?.label || "Scheduled board snapshot",
  ];
  if (board?.text) {
    lines.push("", board.text.trim().slice(0, 700));
  }
  if (saved.text) {
    lines.push("", "Manager notes:", saved.text);
  }
  return lines.join("\n");
}

export async function answerSpecialsQuestion(question) {
  const saved = getSpecialsText();
  const q = String(question || "").toLowerCase();
  const wantPhotoOnly = /\b(photo|picture|image|pic)\b/i.test(q);

  const board = await getBoardReading({ force: false, forceAwait: false });
  const boardText = board?.text || "";
  const managerText = saved.text || "";
  const combined = `${boardText}\n${managerText}`.toLowerCase();

  const words = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        ![
          "what",
          "todays",
          "today",
          "special",
          "specials",
          "chalkboard",
          "chalk",
          "board",
          "daily",
          "have",
          "about",
          "your",
          "whats",
        ].includes(w)
    );

  const hits = words.filter((w) => combined.includes(w));

  if (wantPhotoOnly) {
    return {
      kind: "image",
      text: boardText
        ? "Here's the chalkboard snapshot photo."
        : "Here's the chalkboard photo (no text snapshot yet — a manager can /rereadboard).",
      board,
      needsRefreshFollowUp: false,
    };
  }

  if (boardText) {
    const dishBlock = extractDishBlock(boardText, q);
    if (dishBlock && (hits.length || /\b(ingredient|side|describe|about|what'?s in|come with)\b/i.test(q))) {
      return {
        kind: "text",
        text: [
          `From today's chalkboard:`,
          "",
          dishBlock,
          "",
          "That includes the smaller ingredient / sides lines under the dish when we could read them.",
          'Ask "today\'s specials" for the full board.',
        ].join("\n"),
        board,
        needsRefreshFollowUp: false,
      };
    }

    let text = formatBoardReading(board);
    if (managerText) text += `\n\nManager notes:\n${managerText}`;
    if (hits.length) {
      text =
        `Looking for "${hits.join(", ")}" on the board:\n\n` +
        (dishBlock ? `${dishBlock}\n\nFull board:\n${boardText}` : text);
    }
    return {
      kind: hits.length ? "text" : "both",
      text,
      board,
      needsRefreshFollowUp: false,
      stale: !isBoardCacheFresh(board),
    };
  }

  return {
    kind: "image",
    text:
      "No chalkboard snapshot is loaded yet. We normally capture the board at ~11:00am (lunch) and ~4:30pm (dinner). A manager can run /rereadboard to capture now.",
    board: null,
    needsRefreshFollowUp: false,
  };
}

export { getBoardReading, formatBoardReading, readCachedBoard };
