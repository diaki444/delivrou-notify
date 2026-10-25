/**
 * Boite email de Delivrou dans le QG : lecture (IMAP), classement et
 * brouillons par l'IA, envoi des reponses (SMTP). Prevu pour Gmail avec un
 * mot de passe d'application.
 *
 * Meme regle que pour WhatsApp : l'IA classe et propose, un humain relit et
 * envoie. Rien ne part tout seul.
 *
 * Variables : GMAIL_USER, GMAIL_APP_PASSWORD. Sans elles le module reste
 * inactif et le reste du service n'est pas touche.
 */

import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { askGeminiEmail, isGeminiConfigured } from "./gemini.js";

const USER = process.env.GMAIL_USER;
const PASS = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FILE = path.join(AUTH_DIR, "emails.json");
const POLL_MS = 2 * 60_000;
const MAX_KEPT = 400;
const FETCH_LAST = 40;

export const CLASSES = ["client", "collaborateur", "partenaire", "prospect", "facture", "pub", "autre"] as const;
export type MailClass = (typeof CLASSES)[number];
export const CLASS_LABELS: Record<MailClass, string> = {
  client: "Client",
  collaborateur: "Collaborateur",
  partenaire: "Partenaire / commerce",
  prospect: "Demande de contact",
  facture: "Facture / paiement",
  pub: "Pub / newsletter",
  autre: "Autre",
};

function isMailClass(v: unknown): v is MailClass {
  return typeof v === "string" && (CLASSES as readonly string[]).includes(v);
}

export interface MailMessage {
  id: string; // Message-ID
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  date: number;
  references?: string[];
  fromMe: boolean;
}

export interface MailThread {
  key: string;
  subject: string;
  contact: string; // adresse de l'autre personne
  contactName: string;
  lastDate: number;
  lastFromMe: boolean;
  lastText: string;
  unread: boolean;
  klass?: MailClass;
  urgent?: boolean;
  resume?: string;
  draft?: string;
  archived?: boolean;
  messages: MailMessage[];
}

let threads = new Map<string, MailThread>();
let lastSync = 0;
let lastError: string | null = null;
let syncing = false;

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as { threads?: MailThread[]; lastSync?: number };
    threads = new Map((parsed.threads ?? []).map((t) => [t.key, t]));
    lastSync = parsed.lastSync ?? 0;
  } catch (err) {
    console.error("[delivrou-notify] emails.json illisible, on repart a vide:", err instanceof Error ? err.message : err);
  }
}

function save() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const kept = [...threads.values()].sort((a, b) => b.lastDate - a.lastDate).slice(0, MAX_KEPT);
    threads = new Map(kept.map((t) => [t.key, t]));
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ threads: kept, lastSync }), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error("[delivrou-notify] Ecriture de emails.json impossible:", err instanceof Error ? err.message : err);
  }
}

load();

export function isEmailConfigured(): boolean {
  return Boolean(USER && PASS);
}

export function emailStatus() {
  return {
    configured: isEmailConfigured(),
    address: USER ?? null,
    lastSync: lastSync || null,
    error: lastError,
    ia: isGeminiConfigured(),
  };
}

const normSubject = (s: string) => s.replace(/^\s*((re|fwd?|tr)\s*:\s*)+/gi, "").trim().toLowerCase();

export function listThreads() {
  return [...threads.values()]
    .filter((t) => !t.archived)
    .sort((a, b) => b.lastDate - a.lastDate)
    .map((t) => ({
      key: t.key,
      subject: t.subject,
      contact: t.contact,
      contactName: t.contactName,
      lastDate: t.lastDate,
      lastFromMe: t.lastFromMe,
      lastText: t.lastText,
      unread: t.unread,
      klass: t.klass ?? null,
      klassLabel: t.klass ? CLASS_LABELS[t.klass] : null,
      urgent: Boolean(t.urgent),
      resume: t.resume ?? null,
    }));
}

export function getThread(key: string): MailThread | undefined {
  return threads.get(key);
}

export function markRead(key: string) {
  const t = threads.get(key);
  if (t && t.unread) {
    t.unread = false;
    save();
  }
}

export function setClass(key: string, klass: MailClass): boolean {
  const t = threads.get(key);
  if (!t) return false;
  t.klass = klass;
  save();
  return true;
}

export function archiveThread(key: string): boolean {
  const t = threads.get(key);
  if (!t) return false;
  t.archived = true;
  save();
  return true;
}

export function unreadCount(): number {
  let n = 0;
  for (const t of threads.values()) if (!t.archived && t.unread && t.klass !== "pub") n++;
  return n;
}

/** Fils ou l'autre a ecrit en dernier, le plus ancien d'abord. */
export function waitingThreads() {
  const now = Date.now();
  return [...threads.values()]
    .filter((t) => !t.archived && !t.lastFromMe && t.klass !== "pub")
    .sort((a, b) => a.lastDate - b.lastDate)
    .slice(0, 20)
    .map((t) => ({
      key: t.key,
      name: t.contactName || t.contact,
      subject: t.subject,
      waitingHours: Math.round(((now - t.lastDate) / 3600_000) * 10) / 10,
    }));
}

function addMessage(m: MailMessage, unread: boolean) {
  const contact = m.fromMe ? m.to : m.from;
  if (!contact) return;
  // Un fil = meme correspondant + meme sujet (sans Re:). Simple et suffisant ici.
  const key = `${contact}|${normSubject(m.subject)}`;
  let t = threads.get(key);
  if (!t) {
    t = {
      key,
      subject: m.subject || "(sans objet)",
      contact,
      contactName: m.fromMe ? "" : m.fromName,
      lastDate: 0,
      lastFromMe: m.fromMe,
      lastText: "",
      unread: false,
      messages: [],
    };
    threads.set(key, t);
  }
  if (t.messages.some((x) => x.id === m.id)) return;
  t.messages.push(m);
  t.messages.sort((a, b) => a.date - b.date);
  if (!m.fromMe && m.fromName && !t.contactName) t.contactName = m.fromName;
  const last = t.messages[t.messages.length - 1];
  t.lastDate = last.date;
  t.lastFromMe = last.fromMe;
  t.lastText = last.text.replace(/\s+/g, " ").slice(0, 160);
  if (!m.fromMe && unread) {
    t.unread = true;
    t.archived = false;
    t.draft = undefined; // nouveau message : l'ancien brouillon ne convient plus
    t.klass = undefined; // a reclasser
  }
}

/** Retire citations et historique pour garder l'essentiel du message. */
function cleanBody(text: string): string {
  const out: string[] = [];
  for (const l of text.replace(/\r/g, "").split("\n")) {
    if (l.startsWith(">")) continue;
    if (/^(on|le) .{5,80} (wrote|a [ée]crit)\s*:?$/i.test(l.trim())) break;
    if (/^-{2,}\s*(original message|message d'origine)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}

async function pull(client: ImapFlow, box: string, fromMe: boolean, since: Date) {
  let lock;
  try {
    lock = await client.getMailboxLock(box);
  } catch {
    return; // dossier absent (le nom Gmail change selon la langue)
  }
  try {
    const uids = (await client.search({ since }, { uid: true })) || [];
    for (const uid of uids.slice(-FETCH_LAST)) {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const p = await simpleParser(msg.source);
      const from = p.from?.value?.[0];
      const toField = p.to ? (Array.isArray(p.to) ? p.to[0] : p.to) : undefined;
      const to = toField?.value?.[0];
      const html = typeof p.html === "string" ? p.html.replace(/<[^>]+>/g, " ") : "";
      addMessage(
        {
          id: p.messageId || `${box}-${uid}`,
          from: (from?.address || "").toLowerCase(),
          fromName: from?.name || "",
          to: (to?.address || "").toLowerCase(),
          subject: p.subject || "",
          text: cleanBody(p.text || html),
          date: (p.date || new Date()).getTime(),
          references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : undefined,
          fromMe,
        },
        !fromMe && !(msg.flags && msg.flags.has("\\Seen")),
      );
    }
  } finally {
    lock.release();
  }
}

/** Relit la boite : recus des 14 derniers jours et envoyes, pour voir qui a deja repondu. */
export async function syncEmails(): Promise<{ ok: boolean; error?: string }> {
  if (!isEmailConfigured()) return { ok: false, error: "GMAIL_USER / GMAIL_APP_PASSWORD non configures sur le serveur." };
  if (syncing) return { ok: true };
  syncing = true;
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: USER!, pass: PASS! }, logger: false });
  try {
    await client.connect();
    const since = new Date(Date.now() - 14 * 86400_000);
    await pull(client, "INBOX", false, since);
    await pull(client, "[Gmail]/Sent Mail", true, since);
    await pull(client, "[Gmail]/Messages envoyés", true, since);
    lastSync = Date.now();
    lastError = null;
    save();
    void classifyPending();
    return { ok: true };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: lastError };
  } finally {
    syncing = false;
    try {
      await client.logout();
    } catch {
      /* deja ferme */
    }
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(m[0]);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

let classifying = false;
/** Classe les fils recus pas encore classes : un appel par fil, 10 par passage au plus. */
export async function classifyPending() {
  if (classifying || !isGeminiConfigured()) return;
  classifying = true;
  try {
    const todo = [...threads.values()].filter((t) => !t.klass && !t.archived && !t.lastFromMe).slice(0, 10);
    for (const t of todo) {
      const last = t.messages[t.messages.length - 1];
      const r = await askGeminiEmail(
        `Classe cet email recu par Delivrou. Reponds UNIQUEMENT par un objet JSON, sans autre texte :\n` +
          `{"classe":"client|collaborateur|partenaire|prospect|facture|pub|autre","urgent":true,"resume":"une phrase"}\n` +
          `- client : utilise ou veut utiliser Delivrou pour un colis, ou reclame\n` +
          `- collaborateur : livreur, equipe, freelance, prestataire qui travaille avec Delivrou\n` +
          `- partenaire : commerce ou entreprise qui veut collaborer\n` +
          `- prospect : premiere prise de contact, question generale\n` +
          `- facture : facture, paiement, abonnement, banque\n` +
          `- pub : newsletter, publicite, notification automatique\n` +
          `urgent vaut true seulement pour une reclamation, un colis bloque ou un delai explicite, sinon false.\n\n` +
          `De : ${t.contactName} <${t.contact}>\nObjet : ${t.subject}\n"""${last.text.slice(0, 1500)}"""`,
      );
      if (!r.ok || !r.text) break; // quota ou erreur : on reessaiera au prochain passage
      const j = extractJson(r.text);
      t.klass = isMailClass(j?.classe) ? j.classe : "autre";
      t.urgent = j?.urgent === true;
      t.resume = typeof j?.resume === "string" ? j.resume.slice(0, 200) : undefined;
    }
    save();
  } finally {
    classifying = false;
  }
}

/** Brouillon de reponse. Jamais envoye : l'humain relit, modifie, puis envoie. */
export async function draftReply(key: string, consigne?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const t = threads.get(key);
  if (!t) return { ok: false, error: "Fil inconnu" };
  if (!isGeminiConfigured()) return { ok: false, error: "GEMINI_API_KEY non configuree sur le serveur." };
  const history = t.messages
    .slice(-5)
    .map((m) => `${m.fromMe ? "Delivrou" : t.contactName || t.contact} : ${m.text.slice(0, 1200)}`)
    .join("\n---\n");
  const r = await askGeminiEmail(
    `Tu rediges la reponse email de Delivrou. Interlocuteur classe comme : ${t.klass ? CLASS_LABELS[t.klass] : "inconnu"}.\n` +
      `Echange (le plus recent en dernier) :\n${history}\n\n` +
      (consigne ? `Consigne de l'humain pour cette reponse : ${consigne.slice(0, 300)}\n\n` : "") +
      `Ecris UNIQUEMENT le corps de l'email, en francais simple, poli et chaleureux : une salutation, 2 a 5 phrases, ` +
      `puis "Cordialement," et "L'equipe Delivrou" sur deux lignes. Pas d'objet, pas de markdown. ` +
      `Ne promets ni prix ni delai precis. Si une information manque, pose une question precise ou dis qu'on revient vers la personne.`,
  );
  if (!r.ok || !r.text) return { ok: false, error: r.error || "Brouillon indisponible." };
  t.draft = r.text.trim();
  save();
  return { ok: true, text: t.draft };
}

export async function sendReply(key: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const t = threads.get(key);
  if (!t) return { ok: false, error: "Fil inconnu" };
  if (!isEmailConfigured()) return { ok: false, error: "Email non configure sur le serveur." };
  const text = body.trim();
  if (!text) return { ok: false, error: "Message vide" };
  const lastIn = [...t.messages].reverse().find((m) => !m.fromMe);
  const transport = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: USER!, pass: PASS! } });
  try {
    const subject = /^re\s*:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
    const info = await transport.sendMail({
      from: `Delivrou <${USER}>`,
      to: t.contact,
      subject,
      text,
      inReplyTo: lastIn?.id,
      references: lastIn ? [...(lastIn.references ?? []), lastIn.id] : undefined,
    });
    addMessage(
      { id: info.messageId, from: (USER ?? "").toLowerCase(), fromName: "Delivrou", to: t.contact, subject, text, date: Date.now(), fromMe: true },
      false,
    );
    t.draft = undefined;
    t.unread = false;
    save();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function startEmailPolling() {
  if (!isEmailConfigured()) return;
  const tick = () =>
    void syncEmails().then((r) => {
      if (!r.ok) console.error("[delivrou-notify] email:", r.error);
    });
  setTimeout(tick, 10_000);
  setInterval(tick, POLL_MS).unref();
}
