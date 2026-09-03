import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restaurant } from "../engine/reply.js";
import { DATA_DIR } from "../paths.js";
import {
  looksGenericMenuFallback,
  buildActiveSpecialsPayload,
} from "../engine/board-payload.js";

export { looksGenericMenuFallback };

const SNAP_DIR = join(DATA_DIR, "board-snapshots");
const CACHE_FILE = join(DATA_DIR, "board-reading.json");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.BOARD_OCR_MODEL || "gemma3:4b";

let inFlight = null;

const TRANSCRIBE_PROMPT = `This photo is the Fish City Grill SEAFOOD chalkboard of today's specials (not a weekly Mon–Sun schedule).

Layout (left/main board):
- Large colored chalk = DISH NAME + price (numbers like 35, 22, 21…)
- Smaller chalk DIRECTLY under each dish = ingredients, sauces, and sides for THAT dish

Your job: transcribe BOTH the large dish lines AND the smaller ingredient/sides lines under them.

Format exactly like:
DISH NAME — $price
  ingredient, ingredient, sauce, side, …

Rules:
- Copy ONLY handwritten chalk visible on THIS board. If a word is low-confidence, write [unclear] or omit the dish — NEVER substitute everyday menu items (Lobster Roll, Angel Hair Pasta, Fish Tacos, Shrimp Tacos, Crab Cakes, burgers, fajitas, etc.).
- Do NOT invent a Monday–Sunday weekly specials menu.
- Do NOT invent pulled pork, fajitas, burgers, ribeye, or generic bar food unless clearly written.
- Keep each dish's small ingredient line indented under that dish.
- If a word is unreadable write [unclear].
- Ignore ceiling lights, brick wall, and camera timestamp.
- Optional: if a drinks/beer list is visible on the far right, put it under DRINKS after the specials.
- Output ONLY the transcription.`;

const RETRY_PROMPT = `STRICT OCR retry. This is Fish City Grill seafood specials chalk.

Read the real handwritten dish names (large colored chalk) and the small ingredient/sides line under each.
Output ONLY what you see. No Monday–Sunday template. No invented menu. Never guess Lobster Roll, Angel Hair Pasta, Fish Tacos, Shrimp Tacos, Crab Cakes, or other everyday items for unreadable chalk.

Format:
DISH NAME — $price
  small ingredient / sides text

If unsure about a word use [unclear].`;

const ROW_PROMPT = `This image crop shows 1–2 Fish City Grill chalkboard specials only.
Each special has a LARGE dish name + price, then a SMALLER ingredient/sides line under it.
Transcribe BOTH lines for each dish you see.

Format:
DISH NAME — $price
  ingredients, sauces, sides

Rules: copy only visible chalk. If unsure, [unclear] or skip — do not invent Lobster Roll, Angel Hair Pasta, Fish Tacos, Shrimp Tacos, Crab Cakes, or other menu items. No weekly Mon–Sun menu. Output only the transcription.`;

/** Reject invented menus (Gemma often fabricates bar food / weekly specials). */
export function looksHallucinated(text) {
  if (!text || text.trim().length < 40) return true;
  const dayHits = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ].filter((d) => text.toLowerCase().includes(d)).length;
  if (dayHits >= 3) return true;
  if (looksGenericMenuFallback(text)) return true;
  // Generic soda list with no real chalk sides is a common invent
  if (/soda,\s*iced tea,\s*lemonade/i.test(text)) return true;
  const unclear = (String(text).match(/\[unclear\]/gi) || []).length;
  if (unclear >= 4) return true;
  return false;
}

function pricedDishLineCount(text) {
  let n = 0;
  for (const raw of String(text || "").split(/\n/)) {
    const line = raw.trim();
    if (!line || /^drinks?\b/i.test(line)) continue;
    if (/^\s+/.test(raw) && !/\$\d{2,3}\b/.test(line)) continue;
    if (!/(?:[—–\-:]+|\s)\s*\$?\s*\d{2,3}\b/.test(line)) continue;
    if (/\[unclear\]/i.test(line) || looksGenericMenuFallback(line)) continue;
    n += 1;
  }
  return n;
}

/** True when we should not treat this OCR as today's specials. */
export function isLowConfidenceOcr(text) {
  if (!String(text || "").trim()) return true;
  if (looksGenericMenuFallback(text)) return true;
  if (pricedDishLineCount(text) < 1) return true;
  if (looksHallucinated(text) && pricedDishLineCount(text) < 2) return true;
  const unclear = (String(text).match(/\[unclear\]/gi) || []).length;
  if (unclear >= 4 && pricedDishLineCount(text) < 2) return true;
  return false;
}

export function getVerifiedBoardPayload(cache) {
  const v = cache?.verified;
  if (v?.text && !isLowConfidenceOcr(v.text)) return v;
  if (cache?.text && !isLowConfidenceOcr(cache.text) && !cache?.ocrFallback) {
    return {
      text: cache.text,
      readAt: cache.readAt,
      boardWindow: cache.boardWindow,
      snapshotPath: cache.snapshotPath,
    };
  }
  return null;
}

function ensureDirs() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
}

export function chicagoParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: restaurant.timezone || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  const minute = Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
    hour,
    minute,
  };
}

/** Lunch board from 11:00, evening board from 16:30 (America/Chicago). */
export function currentBoardWindow(date = new Date()) {
  const { dateKey, minutes } = chicagoParts(date);
  if (minutes < 11 * 60) {
    return {
      dateKey,
      window: "overnight",
      label: "before lunch board (snapshot at 11:00am)",
      snapshotWindow: "lunch",
    };
  }
  if (minutes < 16 * 60 + 30) {
    return {
      dateKey,
      window: "lunch",
      label: "lunch board (snapshot ~11:00am)",
      snapshotWindow: "lunch",
    };
  }
  return {
    dateKey,
    window: "evening",
    label: "dinner board (snapshot ~4:30pm)",
    snapshotWindow: "evening",
  };
}

export function readCachedBoard() {
  ensureDirs();
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  ensureDirs();
  const payload = buildActiveSpecialsPayload(data);
  if (payload?.dishes?.length) data.active_specials_payload = payload;
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2) + "\n");
}

/** Snapshot-mode freshness: same calendar day + same lunch/dinner window. */
export function isBoardCacheFresh(cache = readCachedBoard(), now = new Date()) {
  if (!cache?.text || !cache.readAt) return false;
  const nowWin = currentBoardWindow(now);
  const cacheWin = cache.boardWindow || {};
  if (cacheWin.dateKey !== nowWin.dateKey) return false;
  // Overnight: reuse yesterday evening if present, else not fresh
  if (nowWin.window === "overnight") {
    return cacheWin.window === "evening";
  }
  return cacheWin.window === nowWin.window;
}

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const p = join(process.env.HOME || "/root", ".gemini/gemini-credentials.json");
    if (!existsSync(p)) return null;
    const cred = JSON.parse(readFileSync(p, "utf8"));
    return cred.apiKey || cred.api_key || cred.key || cred?.gemini?.apiKey || null;
  } catch {
    return null;
  }
}

async function fetchBoardImage() {
  const url = restaurant.dailySpecialsImageUrl;
  if (!url) throw new Error("No dailySpecialsImageUrl configured");
  const res = await fetch(`${url}?t=${Date.now()}`, {
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "FishCityCulebraBot/1.0" },
  });
  if (!res.ok) throw new Error(`Board image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    buf,
    etag: res.headers.get("etag") || null,
    lastModified: res.headers.get("last-modified") || null,
    url,
  };
}

function ffmpegToJpeg(inPath, outPath, vf) {
  return new Promise((resolve) => {
    const ff = spawn(
      "ffmpeg",
      ["-y", "-i", inPath, "-vf", vf, "-q:v", "2", outPath],
      { stdio: "ignore" }
    );
    ff.on("close", (code) => {
      try {
        if (code === 0 && existsSync(outPath)) {
          resolve(readFileSync(outPath));
          return;
        }
      } catch {
        /* fall through */
      }
      resolve(null);
    });
    ff.on("error", () => resolve(null));
  });
}

/**
 * Crop to the specials chalk area (skip brick/lights + far-right beer list),
 * then upscale/sharpen so small ingredient lines stay readable.
 */
async function prepareJpegForOcr(buf) {
  const stamp = Date.now();
  const inPath = join(tmpdir(), `fcg-board-${stamp}.jpg`);
  const outPath = join(tmpdir(), `fcg-board-${stamp}-ocr.jpg`);
  writeFileSync(inPath, buf);
  const out = await ffmpegToJpeg(
    inPath,
    outPath,
    "crop=iw*0.78:ih*0.58:iw*0.06:ih*0.20,scale=2000:-1:flags=lanczos,eq=contrast=1.25:brightness=0.03,unsharp=5:5:1.0:3:3:0.5"
  );
  return out || buf;
}

/** Three horizontal strips of the specials panel — easier for small vision models. */
async function prepareRowCropsForOcr(buf) {
  const stamp = Date.now();
  const inPath = join(tmpdir(), `fcg-board-${stamp}.jpg`);
  writeFileSync(inPath, buf);
  const crops = [];
  // y offsets within the specials crop: top / mid / bottom thirds
  const bands = [
    "crop=iw*0.78:ih*0.22:iw*0.06:ih*0.18",
    "crop=iw*0.78:ih*0.22:iw*0.06:ih*0.36",
    "crop=iw*0.78:ih*0.22:iw*0.06:ih*0.54",
  ];
  for (let i = 0; i < bands.length; i++) {
    const outPath = join(tmpdir(), `fcg-board-${stamp}-row${i}.jpg`);
    const out = await ffmpegToJpeg(
      inPath,
      outPath,
      `${bands[i]},scale=1800:-1:flags=lanczos,eq=contrast=1.3:brightness=0.04,unsharp=5:5:1.2:3:3:0.6`
    );
    if (out) crops.push(out);
  }
  return crops;
}

async function transcribeWithGemini(jpegBuf, prompt = TRANSCRIBE_PROMPT) {
  const key = loadGeminiApiKey();
  if (!key) return null;
  const model = process.env.GEMINI_BOARD_MODEL || "gemini-flash-latest";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: jpegBuf.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.05, maxOutputTokens: 1200 },
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[board] Gemini OCR failed:", data?.error?.message || res.status);
    return null;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim();
  if (!text) return null;
  return { text, source: `gemini:${model}` };
}

async function transcribeWithOllama(jpegBuf, prompt = TRANSCRIBE_PROMPT) {
  const payload = {
    model: OLLAMA_MODEL,
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [jpegBuf.toString("base64")],
      },
    ],
    options: { temperature: 0, num_predict: 1200 },
  };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(320000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.message?.content?.trim();
  if (!text) throw new Error("Ollama returned empty transcription");
  return { text, source: `ollama:${OLLAMA_MODEL}` };
}

async function transcribeByRows(fullJpegBuf) {
  const crops = await prepareRowCropsForOcr(fullJpegBuf);
  if (!crops.length) return null;
  console.log(`[board] row OCR: ${crops.length} strips (ingredients under each dish)…`);
  const parts = [];
  for (let i = 0; i < crops.length; i++) {
    let row = await transcribeWithGemini(crops[i], ROW_PROMPT);
    if (!row) row = await transcribeWithOllama(crops[i], ROW_PROMPT);
    if (row?.text && !looksHallucinated(row.text)) {
      parts.push(row.text.trim());
    } else if (row?.text) {
      console.warn(`[board] row ${i + 1} looked invented — skipping`);
    }
  }
  if (parts.length < 2) return null;
  return {
    text: parts.join("\n\n"),
    source: `ollama:${OLLAMA_MODEL}+rows`,
  };
}

async function runBoardOcr(jpegBuf, originalBuf) {
  let result = await transcribeWithGemini(jpegBuf);
  if (!result) {
    console.log("[board] using Ollama vision for OCR (large + small chalk)…");
    result = await transcribeWithOllama(jpegBuf);
  }
  if (result && !looksHallucinated(result.text)) return result;

  if (result && looksHallucinated(result.text)) {
    console.warn("[board] OCR looked invented — retrying with stricter prompt…");
  }
  let retry = await transcribeWithGemini(jpegBuf, RETRY_PROMPT);
  if (!retry) retry = await transcribeWithOllama(jpegBuf, RETRY_PROMPT);
  if (retry && !looksHallucinated(retry.text)) return retry;

  // Last resort: read the board in horizontal strips (better for small chalk)
  const sourceBuf = originalBuf || jpegBuf;
  const rows = await transcribeByRows(sourceBuf);
  if (rows && !looksHallucinated(rows.text)) return rows;

  console.error("[board] OCR still unreliable; keeping previous cache if any");
  const bad = rows || retry || result;
  return bad
    ? { text: bad.text, source: bad.source, hallucinated: true }
    : null;
}

/**
 * Scheduled snapshot: download chalkboard once, save JPG, OCR once.
 * windowName: "lunch" | "evening" | auto from clock
 */
export async function snapshotBoard(windowName) {
  ensureDirs();
  const now = new Date();
  const parts = chicagoParts(now);
  let window = windowName;
  if (window !== "lunch" && window !== "evening") {
    window = currentBoardWindow(now).snapshotWindow;
  }
  const label =
    window === "evening"
      ? "dinner board (snapshot ~4:30pm)"
      : "lunch board (snapshot ~11:00am)";

  console.log(`[board] snapshot ${window} for ${parts.dateKey}…`);
  const image = await fetchBoardImage();
  const snapPath = join(SNAP_DIR, `${parts.dateKey}-${window}.jpg`);
  writeFileSync(snapPath, image.buf);
  console.log(`[board] saved ${snapPath} (${image.buf.length} bytes)`);

  // Persist today's photo immediately; keep last verified OCR if this read fails
  const prev = readCachedBoard();
  const prevVerified = getVerifiedBoardPayload(prev);
  let cache = {
    text: "",
    source: "pending-ocr",
    readAt: new Date().toISOString(),
    imageEtag: image.etag,
    imageLastModified: image.lastModified,
    imageUrl: image.url,
    snapshotPath: snapPath,
    ocrFallback: true,
    verified: prevVerified,
    boardWindow: {
      dateKey: parts.dateKey,
      window,
      label,
    },
  };
  writeCache(cache);

  const ocrImage = await prepareJpegForOcr(image.buf);
  let result = null;
  try {
    result = await runBoardOcr(ocrImage, image.buf);
  } catch (err) {
    console.error("[board] OCR failed (photo snapshot kept):", err.message || err);
  }

  const usable =
    result?.text && !result.hallucinated && !isLowConfidenceOcr(result.text);

  if (usable) {
    const verified = {
      text: result.text,
      readAt: new Date().toISOString(),
      boardWindow: cache.boardWindow,
      snapshotPath: snapPath,
      source: result.source,
    };
    cache = {
      ...cache,
      text: result.text,
      source: result.source,
      readAt: verified.readAt,
      ocrFallback: false,
      verified,
    };
    writeCache(cache);
    console.log(
      `[board] snapshot OCR done via ${cache.source} (${cache.text.length} chars)`
    );
  } else if (result?.hallucinated || (result?.text && isLowConfidenceOcr(result.text))) {
    cache = {
      ...cache,
      ocrFallback: true,
      verified: prevVerified,
      text: "",
    };
    writeCache(cache);
    console.warn(
      "[board] low-confidence OCR — keeping last verified snapshot payload for guest speech"
    );
  } else {
    cache = {
      ...cache,
      ocrFallback: true,
      verified: prevVerified,
      text: "",
    };
    writeCache(cache);
    console.warn("[board] no OCR text — last verified payload kept for guest speech");
  }
  return cache;
}

/** Prefer local snapshot file bytes for Telegram send. */
export function loadSnapshotImageBuffer(cache = readCachedBoard()) {
  const p = cache?.snapshotPath;
  if (p && existsSync(p)) return readFileSync(p);
  return null;
}

/**
 * Guest-facing: use scheduled snapshot only. No background OCR storms.
 * force/forceAwait → manual /rereadboard path.
 */
export async function getBoardReading({ force = false, forceAwait = false } = {}) {
  const cached = readCachedBoard();
  if (!force && !forceAwait) {
    if (cached?.text || cached?.verified?.text || cached?.snapshotPath) {
      return {
        ...cached,
        fromCache: true,
        stale: !isBoardCacheFresh(cached),
        afterHours: currentBoardWindow().window === "overnight",
        ocrFallback:
          cached.ocrFallback === true || isLowConfidenceOcr(cached.text || ""),
      };
    }
    return null;
  }
  return { ...(await refreshBoardReading()), fromCache: false };
}

export function refreshBoardReading() {
  if (inFlight) return inFlight;
  const win = currentBoardWindow();
  inFlight = snapshotBoard(win.snapshotWindow)
    .catch((err) => {
      console.error("[board] snapshot failed:", err.message || err);
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function formatBoardReading(cache) {
  const text = cache?.text || cache?.verified?.text;
  if (!text) return null;
  const when = cache.readAt
    ? new Date(cache.readAt).toLocaleString("en-US", {
        timeZone: restaurant.timezone || "America/Chicago",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        day: "numeric",
      })
    : "unknown time";
  const win = cache.boardWindow?.label || "current board";
  const staleNote = cache.stale
    ? " (this may be the previous board — next auto snapshot is 11:00am or 4:30pm)"
    : "";
  return [
    `Chalkboard specials — ${restaurant.name}`,
    `${win}`,
    `Snapshot read: ${when}${staleNote}`,
    "",
    cache.text?.trim?.() || cache.verified?.text?.trim() || text.trim(),
    "",
    cache.ocrFallback
      ? "Today's handwriting was low-confidence — showing the last verified board text. Guest speech uses that verified list (no photo mention)."
      : "Includes dish names plus the smaller ingredient / sides lines under them when readable.",
    "Board snapshots: ~11:00am lunch · ~4:30pm dinner.",
  ].join("\n");
}

/** Re-OCR an existing snapshot file (no new download). */
export async function reocrSnapshot(snapshotPath) {
  ensureDirs();
  const path = snapshotPath || readCachedBoard()?.snapshotPath;
  if (!path || !existsSync(path)) {
    throw new Error("No snapshot image on disk to re-read");
  }
  console.log(`[board] re-OCR small text from ${path}`);
  const buf = readFileSync(path);
  const ocrImage = await prepareJpegForOcr(buf);
  const result = await runBoardOcr(ocrImage, buf);
  const prev = readCachedBoard() || {};
  if (result?.hallucinated || !result?.text || isLowConfidenceOcr(result.text)) {
    console.warn(
      "[board] re-OCR low-confidence — leaving last verified snapshot payload unchanged"
    );
    const verified = getVerifiedBoardPayload(prev);
    const cache = {
      ...prev,
      ocrFallback: true,
      verified,
      snapshotPath: path,
    };
    writeCache(cache);
    return cache;
  }
  const verified = {
    text: result.text,
    readAt: new Date().toISOString(),
    boardWindow: prev.boardWindow,
    snapshotPath: path,
    source: result.source,
  };
  const cache = {
    ...prev,
    text: result.text,
    source: result.source,
    readAt: verified.readAt,
    snapshotPath: path,
    ocrFallback: false,
    verified,
  };
  writeCache(cache);
  console.log(`[board] re-OCR done (${cache.text.length} chars) via ${cache.source}`);
  return cache;
}

const LUNCH_MINUTES = 11 * 60; // 11:00am America/Chicago
const EVENING_MINUTES = 16 * 60 + 30; // 4:30pm America/Chicago
const SCHEDULE_TICK_MS = 30_000;

/** Which scheduled window should be captured right now (exact clock + catch-up). */
function dueSnapshotWindow(now = new Date()) {
  const { dateKey, minutes } = chicagoParts(now);
  const cached = readCachedBoard();
  const have = (window) =>
    cached?.boardWindow?.dateKey === dateKey &&
    cached?.boardWindow?.window === window &&
    Boolean(cached?.snapshotPath);

  // At/after 4:30pm → evening board
  if (minutes >= EVENING_MINUTES) {
    if (!have("evening")) return { dateKey, window: "evening" };
    return null;
  }
  // At/after 11:00am → lunch board
  if (minutes >= LUNCH_MINUTES) {
    if (!have("lunch")) return { dateKey, window: "lunch" };
    return null;
  }
  return null;
}

/**
 * Auto-refresh specials at 11:00am and 4:30pm America/Chicago.
 * Also catch-up if the bot was down at the exact minute (once per window/day).
 * System cron can still run as a backup.
 */
export function startBoardRefreshLoop() {
  const cached = readCachedBoard();
  const fresh = isBoardCacheFresh(cached);
  console.log(
    "[board] auto-refresh: 11:00am & 4:30pm America/Chicago",
    fresh
      ? `| serving ${cached.boardWindow?.window} snapshot`
      : "| no fresh snapshot yet — will catch up when due, or use /rereadboard"
  );

  let running = false;
  const tick = async () => {
    if (running || inFlight) return;
    const due = dueSnapshotWindow();
    if (!due) return;
    running = true;
    console.log(
      `[board] scheduled refresh starting (${due.window} ${due.dateKey})…`
    );
    try {
      await snapshotBoard(due.window);
      console.log(`[board] scheduled ${due.window} refresh complete`);
    } catch (err) {
      console.error(
        `[board] scheduled ${due.window} refresh failed:`,
        err.message || err
      );
    } finally {
      running = false;
    }
  };

  // Small delay so Telegram polling starts first
  setTimeout(() => {
    tick();
    setInterval(tick, SCHEDULE_TICK_MS);
  }, 5_000);
}
