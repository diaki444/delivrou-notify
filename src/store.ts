import fs from "node:fs";
import path from "node:path";
import { classifyCategory, type ProspectCategory } from "./categories.js";

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

export interface Prospect {
  id: string;
  name: string;
  phone: string; // chiffres uniquement
  address?: string;
  category?: string;
  bucket: ProspectCategory; // famille (pharmacie, epicerie, restaurant, boutique)
  query: string; // recherche d'origine
  addedAt: number;
  contacted: boolean;
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
  prospects: Prospect[];
  suggestedReplies: Record<string, string>;
}

let chats = new Map<string, ChatMeta>();
let messages = new Map<string, StoredMessage[]>();
let sendLog: SendLogEntry[] = [];
let templates: MessageTemplate[] = [];
let prospects: Prospect[] = [];
let suggestedReplies = new Map<string, string>();

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw) as DiskShape;
    chats = new Map(Object.entries(parsed.chats || {}));
    messages = new Map(Object.entries(parsed.messages || {}));
    sendLog = parsed.sendLog || [];
    templates = parsed.templates || [];
    // Les prospects sauvegardes avant l'ajout des familles n'ont pas de `bucket` : on le deduit a la volee.
    prospects = (parsed.prospects || []).map((p) => ({
      ...p,
      bucket: p.bucket || classifyCategory(p.category, p.query),
    }));
    suggestedReplies = new Map(Object.entries(parsed.suggestedReplies || {}));
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
        prospects,
        suggestedReplies: Object.fromEntries(suggestedReplies),
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

export function listProspects(limit = 300, bucket?: ProspectCategory): Prospect[] {
  const filtered = bucket ? prospects.filter((p) => p.bucket === bucket) : prospects;
  return [...filtered].sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
}

/** Nombre de prospects par famille, pour les compteurs des onglets de filtre. */
export function countProspectsByBucket(): Record<ProspectCategory, number> {
  const counts: Record<ProspectCategory, number> = { pharmacie: 0, epicerie: 0, restaurant: 0, boutique: 0 };
  for (const p of prospects) counts[p.bucket]++;
  return counts;
}

export function getProspect(id: string): Prospect | undefined {
  return prospects.find((p) => p.id === id);
}

export function findProspectByPhone(phone: string): Prospect | undefined {
  return prospects.find((p) => p.phone === phone);
}

/** Ajoute des prospects trouves par une recherche, en evitant les doublons par numero. */
export function addProspects(
  query: string,
  found: Array<{ id: string; name: string; phone: string; address?: string; category?: string }>,
): { added: number; duplicates: number } {
  const existingPhones = new Set(prospects.map((p) => p.phone));
  let added = 0;
  let duplicates = 0;
  for (const f of found) {
    if (existingPhones.has(f.phone)) {
      duplicates++;
      continue;
    }
    prospects.push({
      id: f.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      phone: f.phone,
      address: f.address,
      category: f.category,
      bucket: classifyCategory(f.category, query),
      query,
      addedAt: Date.now(),
      contacted: false,
    });
    existingPhones.add(f.phone);
    added++;
  }
  scheduleSave();
  return { added, duplicates };
}

export function markProspectContacted(id: string) {
  const p = prospects.find((x) => x.id === id);
  if (p) p.contacted = true;
  scheduleSave();
}

export function deleteProspect(id: string) {
  prospects = prospects.filter((p) => p.id !== id);
  scheduleSave();
}

/**
 * Brouillon de reponse suggere par l'IA pour une conversation donnee
 * (jamais envoye automatiquement : l'utilisateur le relit et confirme).
 */
export function getSuggestedReply(jid: string): string | undefined {
  return suggestedReplies.get(jid);
}

export function setSuggestedReply(jid: string, text: string) {
  suggestedReplies.set(jid, text);
  scheduleSave();
}

export function clearSuggestedReply(jid: string) {
  if (suggestedReplies.delete(jid)) scheduleSave();
}
