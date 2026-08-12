import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  getChatMessages,
  appendChatMessage,
  trimChatMessages,
} from "./store.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const GEMINI_MODEL =
  process.env.GEMINI_CHAT_MODEL ||
  process.env.GEMINI_BOARD_MODEL ||
  "gemini-flash-latest";
const MAX_TURNS = Number(process.env.CHAT_HISTORY_TURNS || 20);

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const p = join(process.env.HOME || "/root", ".gemini/gemini-credentials.json");
    if (!existsSync(p)) return null;
    const cred = JSON.parse(readFileSync(p, "utf8"));
    return (
      cred.apiKey ||
      cred.api_key ||
      cred.key ||
      cred?.gemini?.apiKey ||
      null
    );
  } catch {
    return null;
  }
}

/** Convert stored history → Gemini `contents` array (full conversation). */
export function toGeminiContents(messages) {
  return (messages || [])
    .filter((m) => m && m.content && (m.role === "user" || m.role === "model" || m.role === "assistant"))
    .map((m) => ({
      role: m.role === "assistant" ? "model" : m.role === "model" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
}

async function generateWithGemini(systemInstruction, messages) {
  const key = loadGeminiApiKey();
  if (!key) {
    console.error("[ai-chat] No Gemini API key");
    return null;
  }

  const contents = toGeminiContents(messages);
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
    // Must pass the conversation array here — not a single prompt
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

/**
 * Generate a reply using full message history for this chat.
 * Mirrors:
 *   const { messages } = await req.json();
 *   aiClient.generateContent({ systemInstruction, contents: messages })
 */
export async function generateAiReply(chatId, userText) {
  const text = String(userText || "").trim();
  if (!text) return null;

  appendChatMessage(chatId, { role: "user", content: text });
  trimChatMessages(chatId, MAX_TURNS);

  const messages = getChatMessages(chatId);
  const systemInstruction = buildSystemPrompt();

  let reply = await generateWithGemini(systemInstruction, messages);
  if (!reply) {
    // History is kept; caller may fall back to FAQ. Remove the user turn? Keep it for continuity.
    return null;
  }

  appendChatMessage(chatId, { role: "model", content: reply });
  trimChatMessages(chatId, MAX_TURNS);
  return reply;
}

/** HTTP-style helper for Express: body must include full `messages` array. */
export async function generateFromMessagesPayload({ messages, systemInstruction }) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Request body must include messages: [{role, content}, ...]");
  }
  const instruction = systemInstruction || buildSystemPrompt();
  const reply = await generateWithGemini(instruction, messages);
  if (!reply) throw new Error("AI generation unavailable");
  return { reply, messages: [...messages, { role: "model", content: reply }] };
}

export { buildSystemPrompt, loadGeminiApiKey, OLLAMA_URL, GEMINI_MODEL };
