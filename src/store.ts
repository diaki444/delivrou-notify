import fs from "node:fs";
import path from "node:path";

/**
 * Stockage leger des conversations et du journal d'envoi, persiste dans un
 * simple fichier JSON a l'interieur du volume `auth_info` deja monte (pas
 * besoin d'un deuxieme volume ni d'une vraie base de donnees pour ce
 * volume d'usage).
 */

export interface StoredMessage {
  id: string;
  chatJid: string;
  fromMe: boolean;
  senderName?: string;
  text: string;
  timestamp: number; // unix ms
}

export interface ChatMeta {
  jid: string;
  name: string;
  isGroup: boolean;
  lastText?: string;
  lastTimestamp?: number;
}

export interface SendLogEntry {
  id: string;
  phone: string;
  text: string;
  source: "auto" | "manual";
  status: "sent" | "failed" | "blocked";
  error?: string;
  timestamp: number; // unix ms
}

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: number;
}

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const DATA_FILE = path.join(AUTH_DIR, "dashboard_data.json");

const MAX_MESSAGES_PER_CHAT = 200;
const MAX_SEND_LOG = 500;

interface DiskShape {
  chats: Record<string, ChatMeta>;
  messages: Record<string, StoredMessage[]>;
  sendLog: SendLogEntry[];
  templates: MessageTemplate[];
}

let chats = new Map<string, ChatMeta>();
let messages = new Map<string, StoredMessage[]>();
let sendLog: SendLogEntry[] = [];
let templates: MessageTemplate[] = [];

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as DiskShape;
    chats = new Map(Object.entries(parsed.chats || {}));
    messages = new Map(Object.entries(parsed.messages || {}));
    sendLog = parsed.sendLog || [];
    templates = parsed.templates || [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Impossible de charger l'historique sauvegarde:", err);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
      const shape: DiskShape = {
        chats: Object.fromEntries(chats),
        messages: Object.fromEntries(messages),
        sendLog,
        templates,
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(shape), "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[delivrou-notify] Impossible de sauvegarder l'historique:", err);
    }
  }, 2000);
}

load();

export function upsertChat(jid: string, patch: Partial<ChatMeta>) {
  const existing = chats.get(jid);
  chats.set(jid, {
    jid,
    name: patch.name ?? existing?.name ?? jid,
    isGroup: jid.endsWith("@g.us"),
    lastText: patch.lastText ?? existing?.lastText,
    lastTimestamp: patch.lastTimestamp ?? existing?.lastTimestamp,
  });
  scheduleSave();
}

export function recordMessage(msg: StoredMessage) {
  const list = messages.get(msg.chatJid) ?? [];
  list.push(msg);
  if (list.length > MAX_MESSAGES_PER_CHAT) list.shift();
  messages.set(msg.chatJid, list);

  upsertChat(msg.chatJid, { lastText: msg.text, lastTimestamp: msg.timestamp });
}

export function listChats(limit = 100): ChatMeta[] {
  return [...chats.values()].sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0)).slice(0, limit);
}

export function getChat(jid: string): ChatMeta | undefined {
  return chats.get(jid);
}

export function getMessages(jid: string, limit = 100): StoredMessage[] {
  return (messages.get(jid) ?? []).slice(-limit);
}

export function addSendLogEntry(entry: Omit<SendLogEntry, "id" | "timestamp">) {
  const full: SendLogEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  sendLog.push(full);
  if (sendLog.length > MAX_SEND_LOG) sendLog.shift();
  scheduleSave();
  return full;
}

export function listSendLog(limit = 100): SendLogEntry[] {
  return sendLog.slice(-limit).reverse();
}

export function listTemplates(): MessageTemplate[] {
  return [...templates].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export function addTemplate(name: string, body: string): MessageTemplate {
  const full: MessageTemplate = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    body,
    createdAt: Date.now(),
  };
  templates.push(full);
  scheduleSave();
  return full;
}

export function deleteTemplate(id: string) {
  templates = templates.filter((t) => t.id !== id);
  scheduleSave();
}
