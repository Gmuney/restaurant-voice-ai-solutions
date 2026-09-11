import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  buildMenuDataForContext,
  buildMessagesForLLM,
  getActiveDishContext,
} from "./active-dish-context.js";
import {
  wantsChalkboardSpecialsQuestion,
  chalkboardSpecialsReply,
} from "../engine/specials.js";
import {
  findRemovedChalkboardDish,
  removedChalkboardGuestReply,
} from "../engine/chalkboard-manager.js";
import { readCachedBoard } from "../board/read-board.js";
import {
  applyCallOpening,
  asksSessionReset,
  sessionTerminatedReply,
  tryDeterministicSideSwapReply,
  scrubStaleFriesSideSwap,
} from "../engine/reply.js";
import {
  getChatMessages,
  appendChatMessage,
  trimChatMessages,
  getChatLang,
  setChatLang,
  setActiveDish,
} from "../store.js";
import { resolveGuestLanguage } from "../engine/language.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GEMINI_MODEL =
  process.env.GEMINI_CHAT_MODEL ||
  process.env.GEMINI_BOARD_MODEL ||
  "gemini-flash-latest";
const MAX_TURNS = Number(process.env.CHAT_HISTORY_TURNS || 20);

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const p = join(process.env.HOME || "/root", ".gemini/gemini-credentials.json");
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8").trim();
    if (/^AIza[0-9A-Za-z_-]{20,}$/.test(raw)) return raw;
    if (raw.startsWith("{")) {
      const cred = JSON.parse(raw);
      return (
        cred.apiKey ||
        cred.api_key ||
        cred.key ||
        cred?.gemini?.apiKey ||
        null
      );
    }
    return null;
  } catch {
    return null;
  }
}

const OLLAMA_CHAT_MODEL =
  process.env.CHAT_OLLAMA_MODEL ||
  process.env.BOARD_OCR_MODEL ||
  "gemma3:4b";

/** Split buildMessagesForLLM output into system instruction + turns. */
export function splitLlmMessages(llmMessages) {
  const arr = llmMessages || [];
  if (arr[0]?.role === "system") {
    return {
      systemInstruction: String(arr[0].content || ""),
      turns: arr.slice(1),
    };
  }
  return { systemInstruction: "", turns: arr };
}

/** Convert stored history → Gemini `contents` array (user/model turns only). */
export function toGeminiContents(messages) {
  return (messages || [])
    .filter(
      (m) =>
        m &&
        m.content &&
        (m.role === "user" || m.role === "model" || m.role === "assistant")
    )
    .map((m) => ({
      role:
        m.role === "assistant" || m.role === "model" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
}

/**
 * Send the exact array from buildMessagesForLLM() to Gemini.
 */
async function generateWithGeminiMessages(llmMessages) {
  const key = loadGeminiApiKey();
  if (!key) {
    console.error("[ai-chat] No Gemini API key");
    return null;
  }

  const { systemInstruction, turns } = splitLlmMessages(llmMessages);
  const contents = toGeminiContents(turns);
  if (!contents.length) {
    console.error("[ai-chat] Empty contents — refusing to call Gemini");
    return null;
  }
  if (contents[contents.length - 1].role !== "user") {
    console.error("[ai-chat] Last content must be user role");
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 900,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[ai-chat] Gemini failed:", data?.error?.message || res.status);
    return null;
  }
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .join("")
    ?.trim();
  if (!text) {
    console.error(
      "[ai-chat] Gemini returned empty text",
      data?.candidates?.[0]?.finishReason || data?.promptFeedback || ""
    );
  }
  return text || null;
}

/** Send the exact array from buildMessagesForLLM() to Ollama. */
async function generateWithOllamaMessages(llmMessages) {
  const messages = (llmMessages || [])
    .filter((m) => m?.content)
    .map((m) => ({
      role:
        m.role === "system"
          ? "system"
          : m.role === "assistant" || m.role === "model"
            ? "assistant"
            : "user",
      content: String(m.content),
    }));
  if (messages.length < 2) return null;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        stream: false,
        messages,
        options: { temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.error("[ai-chat] Ollama chat HTTP", res.status);
      return null;
    }
    const data = await res.json().catch(() => ({}));
    const text = String(data?.message?.content || "").trim();
    return text || null;
  } catch (err) {
    console.error("[ai-chat] Ollama chat failed:", err.message || err);
    return null;
  }
}

/**
 * Generate a reply using full message history for this chat.
 * Language: English by default; Spanish only after the guest writes in Spanish.
 */
export async function generateAiReply(chatId, userText, opts = {}) {
  const text = String(userText || "").trim();
  if (!text) return null;
  if (asksSessionReset(text)) return sessionTerminatedReply();

  const languageEarly =
    opts.language ||
    resolveGuestLanguage(chatId, text, {
      getLang: getChatLang,
      setLang: setChatLang,
    });

  if (findRemovedChalkboardDish(text)) {
    appendChatMessage(chatId, { role: "user", content: text });
    trimChatMessages(chatId, MAX_TURNS);
    const initial = !getChatMessages(chatId).some((m) => m.role === "model");
    const det = removedChalkboardGuestReply(languageEarly);
    const reply = applyCallOpening(det, initial);
    appendChatMessage(chatId, { role: "model", content: reply });
    trimChatMessages(chatId, MAX_TURNS);
    return reply;
  }

  if (wantsChalkboardSpecialsQuestion(text)) {
    appendChatMessage(chatId, { role: "user", content: text });
    trimChatMessages(chatId, MAX_TURNS);
    const initial = !getChatMessages(chatId).some((m) => m.role === "model");
    const det = chalkboardSpecialsReply(languageEarly, readCachedBoard());
    const reply = applyCallOpening(det, initial);
    appendChatMessage(chatId, { role: "model", content: reply });
    trimChatMessages(chatId, MAX_TURNS);
    return reply;
  }

  const language =
    opts.language ||
    resolveGuestLanguage(chatId, text, {
      getLang: getChatLang,
      setLang: setChatLang,
    });

  const initial = !getChatMessages(chatId).some((m) => m.role === "model");

  appendChatMessage(chatId, { role: "user", content: text });
  trimChatMessages(chatId, MAX_TURNS);

  const conversationHistory = getChatMessages(chatId);
  const menuData = buildMenuDataForContext();
  const { activeDish } = getActiveDishContext(conversationHistory, menuData);
  if (activeDish?.name) setActiveDish(chatId, activeDish.name);

  const deterministicSide = tryDeterministicSideSwapReply(text, language, {
    chatId,
    activeDishName: activeDish?.name,
    recentMessages: conversationHistory.map((m) => m.content),
  });
  if (deterministicSide) {
    const reply = applyCallOpening(deterministicSide, initial);
    appendChatMessage(chatId, { role: "model", content: reply });
    trimChatMessages(chatId, MAX_TURNS);
    return reply;
  }

  const llmMessages = buildMessagesForLLM(conversationHistory, menuData);

  let reply = await generateWithGeminiMessages(llmMessages);
  if (!reply) {
    console.log(`[ai-chat] Gemini unavailable — trying Ollama (${OLLAMA_CHAT_MODEL})`);
    reply = await generateWithOllamaMessages(llmMessages);
  }
  if (!reply) {
    return null;
  }

  reply = scrubStaleFriesSideSwap(reply, text, language, {
    chatId,
    activeDishName: activeDish?.name,
    recentMessages: conversationHistory.map((m) => m.content),
  });
  if (/\bvoodoo\b/i.test(reply)) {
    reply = chalkboardSpecialsReply(language, readCachedBoard());
  }

  reply = applyCallOpening(reply, initial);

  appendChatMessage(chatId, { role: "model", content: reply });
  trimChatMessages(chatId, MAX_TURNS);
  return reply;
}

/** Translate a deterministic English bot reply into Spanish for Spanish-speaking guests. */
export async function translateToSpanish(englishText) {
  const text = String(englishText || "").trim();
  if (!text) return text;

  const system =
    `Traduce al español natural (estilo México / Sur de EE.UU.) textos de un restaurante para invitados.
Reglas: solo la traducción, sin comillas ni comentarios. El resultado debe ser 100% español: nunca dejes palabras en inglés como tonight, side, sides, Happy Hour, board, default, manager o ASAP; usa esta noche, guarnición, hora feliz, pizarrón, de forma predeterminada, gerente, lo antes posible. Conserva nombres oficiales de platillos, precios y teléfonos. Nunca traduzcas ni leas una URL. Tono SMS corto.`;

  const key = loadGeminiApiKey();
  if (key) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
    };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      const out = data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .join("")
        ?.trim();
      if (out) return out;
    } catch (err) {
      console.error("[ai-chat] translateToSpanish Gemini failed:", err.message || err);
    }
  }

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const out = String(data?.message?.content || "").trim();
      if (out) return out;
    }
  } catch (err) {
    console.error("[ai-chat] translateToSpanish Ollama failed:", err.message || err);
  }
  return text;
}

/** HTTP-style helper for Express: body must include full `messages` array. */
export async function generateFromMessagesPayload({
  messages,
  systemInstruction,
  sessionId = null,
  language = "en",
}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Request body must include messages: [{role, content}, ...]");
  }

  const conversationHistory = messages.filter((m) => m.role !== "system");
  const lastUser = [...conversationHistory]
    .reverse()
    .find((m) => m.role === "user")?.content;
  const ctxOpts = sessionId
    ? { chatId: String(sessionId) }
    : { recentMessages: conversationHistory.map((m) => m.content) };
  const deterministicSide = lastUser
    ? tryDeterministicSideSwapReply(String(lastUser), language, ctxOpts)
    : null;
  if (deterministicSide) {
    const initial = !conversationHistory.some((m) => m.role === "model");
    return {
      reply: applyCallOpening(deterministicSide, initial),
      messages: [
        ...conversationHistory,
        { role: "model", content: applyCallOpening(deterministicSide, initial) },
      ],
      llmMessages: [],
      deterministic: true,
    };
  }

  const menuData = buildMenuDataForContext();
  let llmMessages = buildMessagesForLLM(conversationHistory, menuData);

  if (systemInstruction) {
    const extra = String(systemInstruction).trim();
    if (extra) {
      llmMessages = [
        {
          role: "system",
          content: `${llmMessages[0].content}\n\n${extra}`,
        },
        ...llmMessages.slice(1),
      ];
    }
  }

  let reply = await generateWithGeminiMessages(llmMessages);
  if (!reply) throw new Error("AI generation unavailable");
  if (lastUser) {
    reply = scrubStaleFriesSideSwap(reply, String(lastUser), language, ctxOpts);
  }
  const initial = !conversationHistory.some((m) => m.role === "model");
  reply = applyCallOpening(reply, initial);
  return {
    reply,
    messages: [...conversationHistory, { role: "model", content: reply }],
    llmMessages,
  };
}

export {
  buildSystemPrompt,
  loadGeminiApiKey,
  OLLAMA_URL,
  GEMINI_MODEL,
  buildMessagesForLLM,
  getActiveDishContext,
  buildMenuDataForContext,
  generateWithGeminiMessages,
  generateWithOllamaMessages,
};
