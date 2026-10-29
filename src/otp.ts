/**
 * Envoi de codes de verification (OTP) par WhatsApp, pour la connexion et
 * l'inscription dans l'application Delivrou.
 *
 * Principes :
 *  - le code n'est JAMAIS enregistre : ni dans les conversations, ni dans le
 *    journal d'envoi, ni dans les logs, ni dans la reponse ;
 *  - seul l'envoi est fait ici ; la generation, le hachage, l'expiration et le
 *    comptage des essais de verification restent dans l'application ;
 *  - defense en profondeur : meme si l'application etait mal appelee, ce
 *    service refuse les numeros hors pays autorises, limite le debit par
 *    numero, par adresse et au total (cout Meta), et coupe en cas d'echecs.
 *
 * Variables (toutes facultatives) :
 *   OTP_DISABLED=true            interrupteur d'urgence
 *   OTP_ALLOWED_PREFIXES=224     indicatifs acceptes (virgule)
 *   OTP_PER_PHONE_10MIN=3        envois max par numero sur 10 minutes
 *   OTP_PER_PHONE_DAY=10         envois max par numero sur 24 h
 *   OTP_MIN_GAP_SECONDS=30       delai minimum entre deux envois au meme numero
 *   OTP_PER_IP_HOUR=10           envois max par adresse internet et par heure
 *   OTP_GLOBAL_PER_HOUR=120      envois max au total par heure
 *   OTP_GLOBAL_PER_DAY=600       envois max au total par jour
 *   WHATSAPP_OTP_TEMPLATE=code_verification   nom du modele « Authentification »
 */

import { metaClient } from "./whatsapp-meta.js";
import { whatsapp } from "./whatsapp-client.js";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export type OtpEventKind = "sent" | "blocked" | "failed";
export interface OtpEvent {
  at: number;
  kind: OtpEventKind;
  reason: string;
  phone: string; // masque
  ip: string; // masque
}

const MAX_EVENTS = 300;
const events: OtpEvent[] = [];

const perPhone = new Map<string, number[]>();
const perIp = new Map<string, number[]>();
const globalAttempts: number[] = [];
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

const mask = (s: string) => (s.length <= 5 ? "***" : `${s.slice(0, 3)}***${s.slice(-2)}`);

function record(kind: OtpEventKind, reason: string, phone: string, ip: string) {
  events.push({ at: Date.now(), kind, reason, phone: mask(phone), ip: ip ? mask(ip) : "" });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (kind !== "sent") console.error(`[delivrou-notify] OTP ${kind} : ${reason} (${mask(phone)})`);
}

function prune(list: number[], windowMs: number) {
  const cutoff = Date.now() - windowMs;
  while (list.length && list[0] < cutoff) list.shift();
}

function count(map: Map<string, number[]>, key: string, windowMs: number): number {
  const list = map.get(key);
  if (!list) return 0;
  prune(list, windowMs);
  if (!list.length) map.delete(key);
  return list.length;
}

function push(map: Map<string, number[]>, key: string) {
  const list = map.get(key) ?? [];
  list.push(Date.now());
  map.set(key, list);
}

/** Nettoie les tables de comptage de temps en temps pour qu'elles ne grossissent pas. */
setInterval(() => {
  for (const [k, v] of perPhone) {
    prune(v, 24 * 3600_000);
    if (!v.length) perPhone.delete(k);
  }
  for (const [k, v] of perIp) {
    prune(v, 3600_000);
    if (!v.length) perIp.delete(k);
  }
  prune(globalAttempts, 24 * 3600_000);
}, 10 * 60_000).unref();

/** Numero en chiffres uniquement, avec indicatif ; null si invalide. */
export function normalizeOtpPhone(raw: string): string | null {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (!d) return null;
  // Numero local guineen a 9 chiffres : on ajoute l'indicatif.
  if (d.length === 9 && d.startsWith("6")) d = "224" + d;
  if (d.length < 8 || d.length > 15) return null;
  if (d.startsWith("224") && !/^2246\d{8}$/.test(d)) return null; // mobile guineen : 224 6xx xx xx xx
  return d;
}

export interface OtpResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function sendOtp(rawPhone: string, code: string, rawIp = ""): Promise<OtpResult> {
  const ip = String(rawIp || "").slice(0, 64);
  const phone = normalizeOtpPhone(rawPhone);

  if (process.env.OTP_DISABLED === "true") {
    record("blocked", "interrupteur OTP_DISABLED", String(rawPhone), ip);
    return { ok: false, status: 503, error: "Envoi de codes suspendu." };
  }
  if (!/^\d{4,8}$/.test(String(code || ""))) {
    record("blocked", "code invalide", String(rawPhone), ip);
    return { ok: false, status: 400, error: "Code invalide." };
  }
  if (!phone) {
    record("blocked", "numero invalide", String(rawPhone), ip);
    return { ok: false, status: 400, error: "Numero invalide." };
  }
  const prefixes = (process.env.OTP_ALLOWED_PREFIXES || "224").split(",").map((s) => s.trim()).filter(Boolean);
  if (!prefixes.some((p) => phone.startsWith(p))) {
    record("blocked", "indicatif non autorise", phone, ip);
    return { ok: false, status: 400, error: "Pays non autorise." };
  }

  const now = Date.now();
  if (now < circuitOpenUntil) {
    record("blocked", "coupe-circuit ouvert", phone, ip);
    return { ok: false, status: 503, error: "Service momentanement indisponible." };
  }

  const gap = num(process.env.OTP_MIN_GAP_SECONDS, 30) * 1000;
  const last = (perPhone.get(phone) ?? []).slice(-1)[0];
  if (last && now - last < gap) {
    record("blocked", "renvoi trop rapide", phone, ip);
    return { ok: false, status: 429, error: "Patientez avant de redemander un code." };
  }
  if (count(perPhone, phone, 10 * 60_000) >= num(process.env.OTP_PER_PHONE_10MIN, 3)) {
    record("blocked", "trop de demandes (10 min)", phone, ip);
    return { ok: false, status: 429, error: "Trop de demandes. Reessayez plus tard." };
  }
  if (count(perPhone, phone, 24 * 3600_000) >= num(process.env.OTP_PER_PHONE_DAY, 10)) {
    record("blocked", "trop de demandes (24 h)", phone, ip);
    return { ok: false, status: 429, error: "Trop de demandes aujourd'hui." };
  }
  if (ip && count(perIp, ip, 3600_000) >= num(process.env.OTP_PER_IP_HOUR, 10)) {
    record("blocked", "trop de demandes depuis une meme adresse", phone, ip);
    return { ok: false, status: 429, error: "Trop de demandes. Reessayez plus tard." };
  }
  prune(globalAttempts, 24 * 3600_000);
  const lastHour = globalAttempts.filter((t) => t > now - 3600_000).length;
  if (lastHour >= num(process.env.OTP_GLOBAL_PER_HOUR, 120) || globalAttempts.length >= num(process.env.OTP_GLOBAL_PER_DAY, 600)) {
    record("blocked", "plafond global atteint (cout)", phone, ip);
    return { ok: false, status: 429, error: "Service tres sollicite. Reessayez plus tard." };
  }

  if (whatsapp.provider !== "meta") {
    record("failed", "API officielle requise", phone, ip);
    return { ok: false, status: 503, error: "Envoi de codes indisponible." };
  }
  if (!whatsapp.isConnected()) {
    record("failed", "WhatsApp non connecte", phone, ip);
    return { ok: false, status: 503, error: "Service momentanement indisponible." };
  }

  // On compte la tentative AVANT l'appel : un echec ne doit pas permettre de recommencer sans limite.
  push(perPhone, phone);
  if (ip) push(perIp, ip);
  globalAttempts.push(now);

  try {
    await metaClient.sendOtpTemplate(phone, String(code), process.env.WHATSAPP_OTP_TEMPLATE || "code_verification", process.env.WHATSAPP_OTP_LANG || "fr");
    consecutiveFailures = 0;
    record("sent", "ok", phone, ip);
    return { ok: true, status: 200 };
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= 5) {
      circuitOpenUntil = Date.now() + 5 * 60_000;
      consecutiveFailures = 0;
    }
    // Le message d'erreur de Meta ne contient jamais le code ; on ne garde que la raison.
    record("failed", err instanceof Error ? err.message.slice(0, 120) : "erreur", phone, ip);
    return { ok: false, status: 502, error: "Envoi impossible pour le moment." };
  }
}

/** Resume pour le QG : jamais de code, numeros masques. */
export function otpSecuritySummary() {
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = events.filter((e) => e.at > dayAgo);
  const by = (k: OtpEventKind) => recent.filter((e) => e.kind === k).length;
  const reasons: Record<string, number> = {};
  for (const e of recent) if (e.kind !== "sent") reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  return {
    last24h: { sent: by("sent"), blocked: by("blocked"), failed: by("failed") },
    reasons,
    circuitOpen: Date.now() < circuitOpenUntil,
    disabled: process.env.OTP_DISABLED === "true",
    events: events.slice(-60).reverse(),
  };
}
