/**
 * Notifications du QG sur le telephone (Web Push), pour reagir en direct :
 * messages WhatsApp, emails, commentaires, video ou affiche prete, publication
 * en echec, PC des usines injoignable. Chaque type peut etre coupe depuis le QG.
 * Les commentaires et les publications sont releves toutes les 5 minutes chez Zernio.
 */
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { dernierEnvoi, getVapidPublicKey, isPushConfigured, notifyAllSubscriptions } from "./push.js";
import { addPushSubscription, listPushSubscriptions, removePushSubscriptionByEndpoint } from "./store.js";
import { isZernioConfigured } from "./zernio.js";
import { lister } from "./zernio-publish.js";
import { lireCommentaires } from "./qg-commentaires.js";
import { tousFilms, pcVuFilms } from "./films.js";
import { tousJobs, pcVuAffiches } from "./affiches-captures.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FICHIER = path.join(AUTH_DIR, "qg", "notifications.json");
const RELEVE_MS = 5 * 60_000;

export const TYPES = {
  whatsapp: "Messages WhatsApp",
  email: "Emails reçus",
  commentaire: "Commentaires Facebook et TikTok",
  production: "Vidéo ou affiche prête (ou en échec)",
  publication: "Publication programmée en échec",
  pc: "PC des usines injoignable",
} as const;
export type TypeNotif = keyof typeof TYPES;

interface Etat { coupes: TypeNotif[]; vusCommentaires: string[]; vusEchecs: string[]; pcAlerte: number; premierReleve: boolean }
const lire = (): Etat => { try { return { coupes: [], vusCommentaires: [], vusEchecs: [], pcAlerte: 0, premierReleve: true, ...JSON.parse(fs.readFileSync(FICHIER, "utf8")) }; } catch { return { coupes: [], vusCommentaires: [], vusEchecs: [], pcAlerte: 0, premierReleve: true }; } };
const ecrire = (e: Etat) => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); fs.writeFileSync(FICHIER, JSON.stringify(e)); };

/** Envoie une notification si ce type n'est pas coupe. `url` ouvre la bonne page du QG. */
export function notifier(type: TypeNotif, title: string, body: string, url = "/qg"): void {
  if (lire().coupes.includes(type)) return;
  void notifyAllSubscriptions({ title, body: body.slice(0, 160), url }).catch(() => {});
}

// ───────── relevé périodique : commentaires, publications en échec, PC ─────────
async function relever() {
  const e = lire();
  const premier = e.premierReleve;
  // Commentaires : seulement ceux qui attendent une reponse, jamais deux fois le meme.
  const c = await lireCommentaires();
  if (c.ok) {
    const nouveaux = c.commentaires.filter((x) => !x.repondu && !e.vusCommentaires.includes(x.commentId));
    if (!premier && nouveaux.length) {
      const x = nouveaux[0];
      const res = x.plateforme === "tiktok" ? "TikTok" : "Facebook";
      notifier("commentaire", nouveaux.length > 1 ? `${nouveaux.length} nouveaux commentaires` : `${x.auteur} · ${res}`, nouveaux.length > 1 ? `${x.auteur} : ${x.message}` : x.message, "/qg#commentaires");
    }
    e.vusCommentaires = [...new Set([...c.commentaires.map((x) => x.commentId), ...e.vusCommentaires])].slice(0, 600);
  }
  // Publications programmees depuis le QG qui ont echoue chez Zernio.
  const l = await lister();
  if (l.ok) {
    const echecs = l.posts.filter((p) => p.statut === "failed" || p.statutPost === "failed");
    for (const p of echecs.filter((x) => !e.vusEchecs.includes(x.id))) if (!premier) notifier("publication", `Publication en échec · ${p.reseau === "tiktok" ? "TikTok" : "Facebook"}`, p.texte || "Une publication programmée n'est pas partie. Ouvre le calendrier pour la reprogrammer.", "/qg#calendrier");
    e.vusEchecs = [...new Set([...echecs.map((x) => x.id), ...e.vusEchecs])].slice(0, 300);
  }
  // Une demande attend depuis plus de 10 min et le PC ne s'est pas manifeste depuis 5 min.
  const attente = [...tousFilms().filter((f) => f.statut === "a_produire").map((f) => f.maj ?? f.date), ...tousJobs().filter((j) => j.statut === "a_produire").map((j) => j.date)]
    .map((d) => new Date(d).getTime()).filter((t) => Date.now() - t > 10 * 60_000);
  const pc = Math.max(pcVuFilms(), pcVuAffiches());
  if (attente.length && Date.now() - pc > 5 * 60_000 && Date.now() - e.pcAlerte > 3 * 3600_000) {
    notifier("pc", "Le PC des usines ne répond pas", `${attente.length} demande(s) attendent. Vérifie que l'ordinateur est allumé et que la session Windows est ouverte.`, "/qg#studio");
    e.pcAlerte = Date.now();
  }
  e.premierReleve = false;
  ecrire(e);
}

let minuteur: NodeJS.Timeout | null = null;
export function demarrerNotifications() {
  if (minuteur || !isPushConfigured() || !isZernioConfigured()) return;
  const tour = () => void relever().catch((err) => console.error("[delivrou-notify] Releve des notifications en erreur:", err instanceof Error ? err.message : err));
  setTimeout(tour, 60_000);
  minuteur = setInterval(tour, RELEVE_MS);
}

// ───────── routes du QG : abonner ce telephone, tester, choisir les types ─────────
export const notificationsRouter = express.Router();
notificationsRouter.use(express.json({ limit: "16kb" }));

notificationsRouter.get("/", (_req: Request, res: Response) => {
  const e = lire();
  res.json({ ok: true, configure: isPushConfigured(), cle: getVapidPublicKey() ?? null, appareils: listPushSubscriptions().length, dernierEnvoi: dernierEnvoi(), types: Object.entries(TYPES).map(([id, nom]) => ({ id, nom, actif: !e.coupes.includes(id as TypeNotif) })) });
});

notificationsRouter.post("/abonner", (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof b.endpoint !== "string" || typeof b.keys?.p256dh !== "string" || typeof b.keys?.auth !== "string") { res.status(400).json({ ok: false, erreur: "Abonnement invalide." }); return; }
  addPushSubscription({ endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } });
  res.json({ ok: true, appareils: listPushSubscriptions().length });
});

notificationsRouter.post("/desabonner", (req: Request, res: Response) => {
  const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
  if (typeof endpoint === "string") removePushSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

notificationsRouter.post("/tester", async (_req: Request, res: Response) => {
  if (!isPushConfigured()) { res.status(503).json({ ok: false, erreur: "Les clés VAPID ne sont pas configurées sur le serveur." }); return; }
  const r = await notifyAllSubscriptions({ title: "QG Delivrou", body: "Les notifications marchent sur ce téléphone.", url: "/qg" });
  res.json({ ok: true, appareils: listPushSubscriptions().length, envoi: r });
});

notificationsRouter.post("/types", (req: Request, res: Response) => {
  const b = (req.body ?? {}) as { id?: unknown; actif?: unknown };
  if (typeof b.id !== "string" || !(b.id in TYPES)) { res.status(400).json({ ok: false }); return; }
  const e = lire(), id = b.id as TypeNotif;
  e.coupes = b.actif ? e.coupes.filter((x) => x !== id) : [...new Set([...e.coupes, id])];
  ecrire(e);
  res.json({ ok: true });
});
