import "dotenv/config";
import express from "express";
import {
  generateFromMessagesPayload,
  buildSystemPrompt,
  toGeminiContents,
  GEMINI_MODEL,
} from "../ai/chat.js";
import {
  restaurant,
  applyCallOpening,
  asksSessionReset,
  sessionTerminatedReply,
} from "../engine/reply.js";
import {
  getChatMessages,
  appendChatMessage,
  trimChatMessages,
  clearChatMessages,
} from "../store.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const MAX_TURNS = Number(process.env.CHAT_HISTORY_TURNS || 20);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: restaurant.name,
    model: GEMINI_MODEL,
  });
});

/**
 * Normalize request body into a Gemini-ready messages array.
 * Accepts:
 *   { messages: [...] }
 *   { messages: [...], message: "latest user text" }
 *   { message: "..." } / { prompt: "..." } / { text: "..." }
 *   { sessionId, message } — server keeps history for that session
 */
function normalizeMessages(body = {}) {
  const single =
    body.message ?? body.prompt ?? body.text ?? body.userMessage ?? null;

  let messages = Array.isArray(body.messages) ? [...body.messages] : [];

  // Session-backed history (optional)
  if (body.sessionId) {
    const stored = getChatMessages(body.sessionId);
    if (!messages.length && stored.length) {
      messages = stored.map((m) => ({ role: m.role, content: m.content }));
    }
  }

  // Append the latest user utterance if provided separately
  if (single != null && String(single).trim()) {
    const text = String(single).trim();
    const last = messages[messages.length - 1];
    const alreadyLastUser =
      last &&
      (last.role === "user" || last.role === "USER") &&
      String(last.content || last.text || "").trim() === text;
    if (!alreadyLastUser) {
      messages.push({ role: "user", content: text });
    }
  }

  // Normalize shapes: {role, content} | {role, text} | {role, parts:[{text}]}
  messages = messages
    .map((m) => {
      if (!m) return null;
      let role = String(m.role || "user").toLowerCase();
      if (role === "assistant" || role === "bot") role = "model";
      if (role !== "user" && role !== "model" && role !== "system") role = "user";

      let content =
        m.content ??
        m.text ??
        (Array.isArray(m.parts)
          ? m.parts.map((p) => p?.text || "").join("")
          : "");
      content = String(content || "").trim();
      if (!content) return null;
      // System turns belong in systemInstruction, not contents
      if (role === "system") return null;
      return { role, content };
    })
    .filter(Boolean);

  return messages;
}

/**
 * Conversational endpoint — ALWAYS calls Gemini with:
 *   systemInstruction (knowledge + rules)
 *   contents: full message history including the latest user message
 *
 * Never returns the FAQ welcome greeting.
 */
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const messages = normalizeMessages(body);

    if (!messages.length) {
      return res.status(400).json({
        error:
          'Send { messages: [{ role, content }, ...] } and/or { message: "user text" }. Full history is required for multi-turn chat.',
      });
    }

    // Gemini requires the conversation to end with a user turn
    if (messages[messages.length - 1].role !== "user") {
      return res.status(400).json({
        error: "Last message in history must be from the user.",
      });
    }

    const lastUserText = messages[messages.length - 1].content;
    if (asksSessionReset(lastUserText)) {
      const reply = sessionTerminatedReply();
      if (body.sessionId) clearChatMessages(String(body.sessionId));
      return res.json({
        reply,
        messages: [],
        sessionTerminated: true,
        model: GEMINI_MODEL,
      });
    }

    const YOUR_SYSTEM_PROMPT = buildSystemPrompt();

    // Debug-friendly log (no secrets): proves we are not short-circuiting to welcome text
    console.log(
      `[/chat] model=${GEMINI_MODEL} turns=${messages.length} lastUser=${JSON.stringify(
        messages[messages.length - 1].content.slice(0, 80)
      )}`
    );

    const result = await generateFromMessagesPayload({
      systemInstruction: YOUR_SYSTEM_PROMPT,
      messages, // full conversation array → Gemini contents
    });

    if (result?.reply) {
      const initial = !messages.some((m) => m.role === "model");
      result.reply = applyCallOpening(result.reply, initial);
      const last = result.messages?.[result.messages.length - 1];
      if (last?.role === "model") last.content = result.reply;
    }

    // Persist session history when sessionId provided
    if (body.sessionId) {
      const sid = String(body.sessionId);
      clearChatMessages(sid);
      for (const m of result.messages) {
        appendChatMessage(sid, { role: m.role, content: m.content });
      }
      trimChatMessages(sid, MAX_TURNS);
    }

    res.json({
      reply: result.reply,
      messages: result.messages,
      model: GEMINI_MODEL,
      // Echo what Gemini received (roles/parts) for debugging clients
      geminiContentsPreview: toGeminiContents(messages).map((c) => ({
        role: c.role,
        text: c.parts[0]?.text?.slice(0, 120),
      })),
    });
  } catch (err) {
    console.error("/chat", err.message || err);
    // Do NOT fall back to generateReply() welcome greeting
    res.status(502).json({
      error: err.message || "AI unavailable",
      hint: "Check Gemini API key/model. Chat route does not use FAQ welcome text.",
    });
  }
});

app.post("/chat/reset", (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId required" });
  }
  clearChatMessages(sessionId);
  res.json({ ok: true, cleared: String(sessionId) });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`${restaurant.name} chat API on :${port}`);
  console.log(`POST /chat  → Gemini (${GEMINI_MODEL}) with full message history`);
});
