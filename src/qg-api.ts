/**
 * API JSON du QG : conversations, prospects, journal et etat du service.
 *
 * Le tableau de bord d'origine rend des pages HTML completes cote serveur.
 * Le QG, lui, est une seule page qui change d'onglet sans rechargement : il
 * lui faut les memes donnees en JSON. C'est le seul role de ce fichier —
 * aucune logique metier n'est dupliquee, tout vient de store.ts, de la file
 * d'envoi et des garde-fous existants.
 *
 * Monte sous /qg/api, donc deja derriere le mot de passe du tableau de bord
 * (voir qg.ts).
 */

import express from "express";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
import {
  listChats,
  getChat,
  getMessages,
  markChatViewed,
  isChatUnread,
  formatJidLabel,
  listSendLog,
  listProspects,
  countProspectsByBucket,
  getProspect,
  markProspectContacted,
  deleteProspect,
  getSuggestedReply,
  findProspectByPhone,
  getContactNote,
  setContactNote,
  allTags,
  contactKey,
  setProspectStage,
  countProspectsByStage,
} from "./store.js";
import { STAGES, STAGE_LABELS, STAGE_HINTS, isStage, defaultStage } from "./pipeline.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, DEFAULT_TEMPLATES, personalizeMessage, type ProspectCategory } from "./categories.js";
import { searchPlaces, phoneToDigits, isPlacesConfigured } from "./places.js";
import { askGemini, isGeminiConfigured, generateProspectPitch } from "./gemini.js";
import {
  CLASSES,
  CLASS_LABELS,
  emailStatus,
  listThreads,
  getThread,
  markRead,
  setClass,
  archiveThread,
  unreadCount,
  waitingThreads,
  syncEmails,
  draftReply,
  sendReply as sendMailReply,
} from "./email.js";
import { responseStats, pendingChats } from "./metrics.js";
import { addProspects, listChats as listChatsForCount, isChatUnread as unread } from "./store.js";

export const qgApiRouter = express.Router();
qgApiRouter.use(express.json({ limit: "256kb" }));

/** Etat du service : connexion WhatsApp et quotas d'envoi. */
qgApiRouter.get("/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, connected: whatsapp.isConnected(), provider: whatsapp.getInfo(), queueLength: queueLength(), safety: getSafetyStatus() });
});

/** Liste des conversations, les plus recentes d'abord. */
qgApiRouter.get("/chats", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    chats: listChats(100).map((c) => ({
      jid: c.jid,
      name: c.name || formatJidLabel(c.jid),
      isGroup: c.isGroup,
      lastText: c.lastText ?? "",
      lastTimestamp: c.lastTimestamp ?? null,
      lastFromMe: Boolean(c.lastFromMe),
      unread: isChatUnread(c),
      prospect: findProspectByPhone(c.jid.split("@")[0])?.name ?? null,
      tags: getContactNote(c.jid)?.tags ?? [],
    })),
  });
});

/** Messages d'une conversation. L'ouvrir la marque comme lue. */
qgApiRouter.get("/chats/:jid", (req, res) => {
  const jid = String(req.params.jid || "");
  const chat = getChat(jid);
  if (!chat) {
    res.status(404).json({ ok: false, error: "Conversation inconnue" });
    return;
  }
  markChatViewed(jid);
  const prospect = findProspectByPhone(jid.split("@")[0]);
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    jid,
    name: chat.name || formatJidLabel(jid),
    isGroup: chat.isGroup,
    prospect: prospect ? { name: prospect.name, bucket: CATEGORY_LABELS[prospect.bucket], contacted: prospect.contacted } : null,
    suggestion: getSuggestedReply(jid) ?? null,
    phone: contactKey(jid),
    fiche: getContactNote(jid) ?? { phone: contactKey(jid), note: "", tags: [], updatedAt: 0 },
    messages: getMessages(jid, 120).map((m) => ({ id: m.id, fromMe: m.fromMe, text: m.text, timestamp: m.timestamp, senderName: m.senderName ?? null })),
  });
});

/** Repondre dans une conversation. Passe par les memes garde-fous que tout envoi. */
qgApiRouter.post("/chats/:jid/send", async (req, res) => {
  const jid = String(req.params.jid || "");
  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ ok: false, error: "Message vide" });
    return;
  }
  if (jid.endsWith("@g.us")) {
    res.status(400).json({ ok: false, error: "Envoi en groupe non pris en charge" });
    return;
  }
  const phone = jid.split("@")[0].replace(/\D/g, "");
  if (!phone) {
    res.status(400).json({ ok: false, error: "Numero illisible" });
    return;
  }
  const r = await sendWithGuards(phone, text, "manual");
  res.status(r.ok ? 200 : r.blocked ? 429 : 502).json(r);
});

/** Envoi libre a un numero qui n'a pas encore de conversation. */
qgApiRouter.post("/send", async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  const text = String(req.body?.text || "").trim();
  if (!phone || !text) {
    res.status(400).json({ ok: false, error: "Numero ou message manquant" });
    return;
  }
  const r = await sendWithGuards(phone, text, "manual");
  res.status(r.ok ? 200 : r.blocked ? 429 : 502).json(r);
});

/** Prospects, avec les compteurs par famille et le modele de message. */
qgApiRouter.get("/prospects", (req, res) => {
  const catParam = String(req.query.cat || "");
  const cat = (CATEGORY_ORDER as string[]).includes(catParam) ? (catParam as ProspectCategory) : undefined;
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    familles: CATEGORY_ORDER.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })),
    etapes: STAGES.map((st) => ({ id: st, label: STAGE_LABELS[st], aide: STAGE_HINTS[st] })),
    compteurs: countProspectsByBucket(),
    compteursEtape: countProspectsByStage(),
    modele: cat ? DEFAULT_TEMPLATES[cat] : "",
    prospects: listProspects(300, cat).map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      address: p.address ?? null,
      bucket: p.bucket,
      bucketLabel: CATEGORY_LABELS[p.bucket],
      contacted: p.contacted,
      addedAt: p.addedAt,
      note: getContactNote(p.phone)?.note ?? "",
      tags: getContactNote(p.phone)?.tags ?? [],
      stage: isStage(p.stage) ? p.stage : defaultStage(p.contacted),
    })),
  });
});

/** Contacter un prospect, un par un : le message est personnalise avec son nom. */
qgApiRouter.post("/prospects/:id/send", async (req, res) => {
  const p = getProspect(String(req.params.id || ""));
  if (!p) {
    res.status(404).json({ ok: false, error: "Prospect inconnu" });
    return;
  }
  const raw = String(req.body?.text || "").trim() || DEFAULT_TEMPLATES[p.bucket];
  const r = await sendWithGuards(p.phone, personalizeMessage(raw, p.name), "manual");
  if (r.ok) markProspectContacted(p.id);
  res.status(r.ok ? 200 : r.blocked ? 429 : 502).json(r);
});

qgApiRouter.post("/prospects/:id/delete", (req, res) => {
  deleteProspect(String(req.params.id || ""));
  res.json({ ok: true });
});

/** Journal des envois, pour comprendre ce qui est parti et ce qui a ete bloque. */
qgApiRouter.get("/log", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, entries: listSendLog(200) });
});

/**
 * Compteurs pour les pastilles d'onglet : ce qui a change depuis la derniere
 * visite. Appele regulierement par le QG, donc volontairement leger.
 */
qgApiRouter.get("/counts", (_req, res) => {
  const chats = listChatsForCount(200);
  const log = listSendLog(200);
  const dayAgo = Date.now() - 86400_000;
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    messages: chats.filter(unread).length,
    journal: log.filter((e) => e.timestamp > dayAgo && e.status !== "sent").length,
    prospects: listProspects(1000).filter((p) => !p.contacted).length,
    emails: unreadCount(),
    connected: whatsapp.isConnected(),
  });
});

/** Recherche de commerces reels a Conakry, ajoutes comme prospects. */
qgApiRouter.post("/prospects/search", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) {
    res.status(400).json({ ok: false, error: "Recherche vide." });
    return;
  }
  if (!isPlacesConfigured()) {
    res.status(503).json({ ok: false, error: "GOOGLE_PLACES_API_KEY non configuree sur le serveur." });
    return;
  }
  const result = await searchPlaces(query);
  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error || "Recherche echouee." });
    return;
  }
  // Un prospect sans numero n'est pas contactable : on l'ecarte tout de suite.
  const withPhone = result.results
    .map((r) => {
      const phone = r.phone ? phoneToDigits(r.phone) : null;
      return phone ? { id: r.id, name: r.name, phone, address: r.address, category: r.category } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const { added, duplicates } = addProspects(query, withPhone);
  res.json({ ok: true, trouves: result.results.length, added, duplicates });
});

/**
 * Brouillons de reponse a un commentaire ou message recu sur Facebook,
 * TikTok ou WhatsApp. Rien n'est jamais publie : le QG propose, un humain
 * relit et envoie.
 */
qgApiRouter.post("/ai/reply", async (req, res) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ ok: false, error: "GEMINI_API_KEY non configuree sur le serveur." });
    return;
  }
  const message = String(req.body?.message || "").trim();
  const where = String(req.body?.where || "commentaire public").slice(0, 40);
  const network = String(req.body?.network || "Facebook").slice(0, 20);
  if (!message) {
    res.status(400).json({ ok: false, error: "Message vide." });
    return;
  }
  const base =
    `Tu es le community manager de Delivrou. Voici un ${where} recu sur ${network} :\n"""${message.slice(0, 1500)}"""\n\n`;
  const [court, complet] = await Promise.all([
    askGemini(base + "Redige UNE reponse tres courte, une phrase, prete a envoyer."),
    askGemini(base + "Redige UNE reponse un peu plus complete, deux phrases maximum, prete a envoyer."),
  ]);
  const reponses = [court, complet].filter((r) => r.ok && r.text).map((r) => r.text as string);
  if (!reponses.length) {
    res.status(502).json({ ok: false, error: court.error || complet.error || "Aucune proposition." });
    return;
  }
  res.json({ ok: true, reponses });
});

/**
 * Reactivite de l'equipe : delai de reponse et conversations laissees sans
 * reponse. C'est l'objectif « 100 % traites en moins de 24 h » du QG, rendu
 * mesurable a partir des messages deja stockes.
 */
qgApiRouter.get("/metrics", (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, reponse: responseStats(days), enAttente: pendingChats().slice(0, 20) });
});

/** Fiche interne d'un contact : note privee et etiquettes. */
qgApiRouter.get("/contacts/:phone", (req, res) => {
  const phone = contactKey(String(req.params.phone || ""));
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    fiche: getContactNote(phone) ?? { phone, note: "", tags: [], updatedAt: 0 },
    etiquettes: allTags(),
  });
});

/**
 * Enregistre la fiche. Ces notes ne partent jamais au client : elles
 * servent a se souvenir ("rappeler lundi", "vend des cosmetiques") et a
 * retrouver les contacts par etiquette.
 */
qgApiRouter.post("/contacts/:phone", (req, res) => {
  const phone = contactKey(String(req.params.phone || ""));
  if (!phone) {
    res.status(400).json({ ok: false, error: "Numero illisible" });
    return;
  }
  const note = String(req.body?.note ?? "");
  const rawTags = req.body?.tags;
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(",");
  const fiche = setContactNote(phone, note, tags);
  res.json({ ok: true, fiche: fiche ?? { phone, note: "", tags: [], updatedAt: 0 }, etiquettes: allTags() });
});

/** Deplace un prospect d'une etape a l'autre du parcours. */
qgApiRouter.post("/prospects/:id/stage", (req, res) => {
  const stage = String(req.body?.stage || "");
  if (!isStage(stage)) {
    res.status(400).json({ ok: false, error: "Etape inconnue" });
    return;
  }
  const p = setProspectStage(String(req.params.id || ""), stage);
  if (!p) {
    res.status(404).json({ ok: false, error: "Prospect inconnu" });
    return;
  }
  res.json({ ok: true, stage: p.stage, compteursEtape: countProspectsByStage() });
});

/** Brouillon de premier message, ecrit pour CE commerce et pas en serie. */
qgApiRouter.post("/prospects/:id/pitch", async (req, res) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ ok: false, error: "GEMINI_API_KEY non configuree sur le serveur." });
    return;
  }
  const p = getProspect(String(req.params.id || ""));
  if (!p) {
    res.status(404).json({ ok: false, error: "Prospect inconnu" });
    return;
  }
  const r = await generateProspectPitch({ name: p.name, categoryLabel: CATEGORY_LABELS[p.bucket], address: p.address });
  if (!r.ok) {
    res.status(502).json({ ok: false, error: r.error || "Brouillon indisponible." });
    return;
  }
  res.json({ ok: true, text: r.text });
});

// --- Emails : clients et collaborateurs, classes et repondus depuis le QG ---

qgApiRouter.get("/emails", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    etat: emailStatus(),
    classes: CLASSES.map((c) => ({ id: c, label: CLASS_LABELS[c] })),
    fils: listThreads(),
    enAttente: waitingThreads(),
  });
});

/** Releve la boite tout de suite, sans attendre le passage automatique. */
qgApiRouter.post("/emails/sync", async (_req, res) => {
  const r = await syncEmails();
  res.status(r.ok ? 200 : 502).json(r);
});

qgApiRouter.get("/emails/thread", (req, res) => {
  const t = getThread(String(req.query.key || ""));
  if (!t) {
    res.status(404).json({ ok: false, error: "Fil inconnu" });
    return;
  }
  markRead(t.key);
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    key: t.key,
    subject: t.subject,
    contact: t.contact,
    name: t.contactName || t.contact,
    klass: t.klass ?? null,
    resume: t.resume ?? null,
    draft: t.draft ?? null,
    messages: t.messages.map((m) => ({ id: m.id, fromMe: m.fromMe, text: m.text, date: m.date })),
  });
});

qgApiRouter.post("/emails/draft", async (req, res) => {
  const r = await draftReply(String(req.body?.key || ""), String(req.body?.consigne || ""));
  res.status(r.ok ? 200 : 502).json(r);
});

qgApiRouter.post("/emails/send", async (req, res) => {
  const r = await sendMailReply(String(req.body?.key || ""), String(req.body?.text || ""));
  res.status(r.ok ? 200 : 502).json(r);
});

qgApiRouter.post("/emails/class", (req, res) => {
  const klass = String(req.body?.klass || "");
  const ok = (CLASSES as readonly string[]).includes(klass) && setClass(String(req.body?.key || ""), klass as (typeof CLASSES)[number]);
  res.status(ok ? 200 : 400).json({ ok });
});

qgApiRouter.post("/emails/archive", (req, res) => {
  res.json({ ok: archiveThread(String(req.body?.key || "")) });
});
