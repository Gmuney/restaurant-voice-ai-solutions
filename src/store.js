import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function pathFor(name) {
  return join(DATA_DIR, name);
}

function readJson(name, fallback) {
  ensure();
  const p = pathFor(name);
  if (!existsSync(p)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name, data) {
  ensure();
  writeFileSync(pathFor(name), JSON.stringify(data, null, 2) + "\n");
}

export function getManagers() {
  return readJson("managers.json", { managers: {} });
}

export function isManager(_userId) {
  // Demo mode: everyone has manager access.
  return true;
}

export function unlockManager(userId, name) {
  const db = getManagers();
  db.managers[String(userId)] = {
    name: name || "Manager",
    unlockedAt: new Date().toISOString(),
  };
  writeJson("managers.json", db);
}

export function listManagerIds() {
  return Object.keys(getManagers().managers);
}

export function getSoldOut() {
  return readJson("soldout.json", { items: [] });
}

export function addSoldOut(name, by) {
  const db = getSoldOut();
  const key = name.trim().toLowerCase();
  db.items = db.items.filter((i) => i.name.toLowerCase() !== key);
  db.items.push({
    name: name.trim(),
    by: by || "manager",
    at: new Date().toISOString(),
  });
  writeJson("soldout.json", db);
  return db.items;
}

export function removeSoldOut(name) {
  const db = getSoldOut();
  const key = name.trim().toLowerCase();
  const before = db.items.length;
  db.items = db.items.filter((i) => i.name.toLowerCase() !== key);
  writeJson("soldout.json", db);
  return before !== db.items.length;
}

export function findSoldOutMatch(text) {
  const lower = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  // Common guest typos for demo items
  const aliases = {
    broccoli: ["broccoli", "brocolli", "brocoli", "broccolli"],
  };
  return getSoldOut().items.filter((i) => {
    const name = i.name.toLowerCase();
    if (lower.includes(name)) return true;
    const extras = aliases[name] || [];
    return extras.some((a) => lower.includes(a));
  });
}

export function getSessions() {
  return readJson("sessions.json", { sessions: {} });
}

export function getSession(chatId) {
  return getSessions().sessions[String(chatId)] || null;
}

export function setSession(chatId, session) {
  const db = getSessions();
  if (session == null) delete db.sessions[String(chatId)];
  else db.sessions[String(chatId)] = session;
  writeJson("sessions.json", db);
}

export function getReservations() {
  return readJson("reservations.json", { reservations: [] });
}

export function saveReservation(res) {
  const db = getReservations();
  db.reservations.push(res);
  writeJson("reservations.json", db);
  return res;
}

export function updateReservation(id, patch) {
  const db = getReservations();
  const idx = db.reservations.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  db.reservations[idx] = { ...db.reservations[idx], ...patch };
  writeJson("reservations.json", db);
  return db.reservations[idx];
}

export function getReservation(id) {
  return getReservations().reservations.find((r) => r.id === id) || null;
}

export function reservationsForGuest(chatId) {
  return getReservations().reservations.filter(
    (r) => String(r.guestChatId) === String(chatId)
  );
}

export function pendingReservations() {
  return getReservations().reservations.filter((r) => r.status === "pending");
}

export function getSpecialsText() {
  return readJson("specials.json", { text: "", updatedAt: null, by: null });
}

export function setSpecialsText(text, by) {
  const data = {
    text: String(text || "").trim(),
    updatedAt: new Date().toISOString(),
    by: by || "manager",
  };
  writeJson("specials.json", data);
  return data;
}

export function getOrders() {
  return readJson("orders.json", { orders: [] });
}

export function saveOrder(order) {
  const db = getOrders();
  db.orders.push(order);
  writeJson("orders.json", db);
  return order;
}

export function updateOrder(id, patch) {
  const db = getOrders();
  const idx = db.orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  db.orders[idx] = { ...db.orders[idx], ...patch };
  writeJson("orders.json", db);
  return db.orders[idx];
}

export function getOrder(id) {
  return getOrders().orders.find((o) => o.id === id) || null;
}

export function pendingOrders() {
  return getOrders().orders.filter((o) => o.status === "pending");
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** Full conversation history per chat (for AI generateContent contents[]). */
export function getChatHistoryDb() {
  return readJson("chat-history.json", { chats: {} });
}

export function getChatMessages(chatId) {
  const db = getChatHistoryDb();
  return db.chats[String(chatId)]?.messages || [];
}

export function appendChatMessage(chatId, message) {
  const db = getChatHistoryDb();
  const key = String(chatId);
  if (!db.chats[key]) db.chats[key] = { messages: [], updatedAt: null };
  db.chats[key].messages.push({
    role: message.role,
    content: String(message.content || ""),
    at: new Date().toISOString(),
  });
  db.chats[key].updatedAt = new Date().toISOString();
  writeJson("chat-history.json", db);
  return db.chats[key].messages;
}

export function trimChatMessages(chatId, maxTurns = 20) {
  const db = getChatHistoryDb();
  const key = String(chatId);
  const chat = db.chats[key];
  if (!chat?.messages?.length) return [];
  // Keep last N messages (user+model pairs ≈ 2*turns)
  const maxMsgs = Math.max(4, maxTurns * 2);
  if (chat.messages.length > maxMsgs) {
    chat.messages = chat.messages.slice(-maxMsgs);
    chat.updatedAt = new Date().toISOString();
    writeJson("chat-history.json", db);
  }
  return chat.messages;
}

export function clearChatMessages(chatId) {
  const db = getChatHistoryDb();
  delete db.chats[String(chatId)];
  writeJson("chat-history.json", db);
}

