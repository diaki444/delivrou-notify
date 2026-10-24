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
} from "./store.js";
import { CATEGORY_LABELS, CATEGORY_ORDER, DEFAULT_TEMPLATES, personalizeMessage, type ProspectCategory } from "./categories.js";

export const qgApiRouter = express.Router();
qgApiRouter.use(express.json({ limit: "256kb" }));

/** Etat du service : connexion WhatsApp et quotas d'envoi. */
qgApiRouter.get("/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, connected: whatsapp.isConnected(), queueLength: queueLength(), safety: getSafetyStatus() });
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
    compteurs: countProspectsByBucket(),
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
