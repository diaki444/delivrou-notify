/**
 * Commentaires Facebook et TikTok, lus et repondus depuis le QG via Zernio.
 *
 * Rien n'est publie sans validation : l'IA ne fait que proposer un texte,
 * et la reponse part uniquement quand quelqu'un clique sur « Envoyer ».
 */

import crypto from "node:crypto";
import express from "express";
import { zernioRequest } from "./zernio.js";
import { askGemini, isGeminiConfigured } from "./gemini.js";

export const commentairesRouter = express.Router();

interface PostCommente {
  id: string;
  platform: string;
  accountId: string;
  accountUsername?: string;
  content?: string;
  permalink?: string | null;
  createdTime?: string;
  commentCount?: number;
}

interface CommentaireZernio {
  id: string;
  message?: string;
  createdTime?: string;
  from?: { name?: string; username?: string; isOwner?: boolean };
  replies?: Array<{ from?: { isOwner?: boolean } }>;
  replyCount?: number;
  canReply?: boolean;
}

export interface CommentaireQg {
  postId: string;
  accountId: string;
  plateforme: string;
  postTitre: string;
  permalink: string | null;
  commentId: string;
  auteur: string;
  message: string;
  date: string | null;
  repondu: boolean;
}

const MAX_POSTS = 12;

/** Message clair selon la cause de l'echec chez Zernio. */
function expliquer(status: number | undefined, erreur: string): { code: string; message: string } {
  if (status === 403) return { code: "option", message: "Votre formule Zernio n'inclut pas la boîte de commentaires (option « Inbox »). Activez-la dans Zernio pour lire et répondre aux commentaires ici." };
  if (status === 400 && /PLATFORM_LIMITATION/i.test(erreur)) return { code: "tiktok", message: "TikTok : les commentaires ne sont lisibles que si le compte est relié à Zernio via « TikTok for Business »." };
  return { code: "zernio", message: erreur };
}

/** Les commentaires recents des derniers posts, avec ceux qui attendent encore une reponse. */
/** Les commentaires recents des derniers posts (sans les notres). */
export async function lireCommentaires(): Promise<{ ok: true; commentaires: CommentaireQg[]; avertissements: string[] } | { ok: false; code: string; error: string }> {
  const liste = await zernioRequest<{ data?: PostCommente[] }>("GET", `/v1/inbox/comments?minComments=1&limit=${MAX_POSTS}`);
  if (!liste.ok) {
    const e = expliquer(liste.status, liste.error);
    return { ok: false, code: e.code, error: e.message };
  }
  const posts = (liste.data?.data ?? []).slice(0, MAX_POSTS);
  const commentaires: CommentaireQg[] = [];
  const avertissements: string[] = [];
  for (const p of posts) {
    const r = await zernioRequest<{ comments?: CommentaireZernio[] }>("GET", `/v1/inbox/comments/${encodeURIComponent(p.id)}?accountId=${encodeURIComponent(p.accountId)}&limit=25`);
    if (!r.ok) {
      avertissements.push(`${p.platform} : ${expliquer(r.status, r.error).message}`);
      continue;
    }
    for (const c of r.data?.comments ?? []) {
      if (c.from?.isOwner) continue; // nos propres commentaires
      commentaires.push({
        postId: p.id,
        accountId: p.accountId,
        plateforme: p.platform,
        postTitre: (p.content || "").replace(/\s+/g, " ").trim().slice(0, 90),
        permalink: p.permalink ?? null,
        commentId: c.id,
        auteur: c.from?.name || c.from?.username || "Quelqu'un",
        message: String(c.message ?? ""),
        date: c.createdTime ?? null,
        repondu: (c.replies ?? []).some((x) => x.from?.isOwner),
      });
    }
  }
  commentaires.sort((a, b) => Number(a.repondu) - Number(b.repondu) || String(b.date).localeCompare(String(a.date)));
  return { ok: true, commentaires, avertissements };
}

commentairesRouter.get("/", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const r = await lireCommentaires();
  if (!r.ok) { res.status(502).json({ ok: false, code: r.code, error: r.error }); return; }
  res.json({ ...r, ia: isGeminiConfigured() });
});

/** Propose une reponse (jamais envoyee toute seule). */
commentairesRouter.post("/suggestion", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const message = String(b.message ?? "").slice(0, 600);
  if (!message) {
    res.status(400).json({ ok: false, error: "Commentaire vide" });
    return;
  }
  if (!isGeminiConfigured()) {
    res.status(503).json({ ok: false, error: "L'IA n'est pas configurée sur le serveur (GEMINI_API_KEY)." });
    return;
  }
  const r = await askGemini(
    `Tu réponds, au nom de Delivrou, à un commentaire public sur ${b.plateforme === "tiktok" ? "TikTok" : "Facebook"}.\n` +
      `Post concerné : « ${String(b.postTitre ?? "").slice(0, 120)} »\n` +
      `Commentaire de ${String(b.auteur ?? "un internaute").slice(0, 40)} : « ${message} »\n\n` +
      `Écris UNE réponse courte (1 à 2 phrases), chaleureuse, au tutoiement, en français simple de Conakry. ` +
      `Remercie ou réponds précisément à la question. Si la personne demande comment faire, renvoie vers www.delivrou.com ou WhatsApp wa.me/224628901285. ` +
      `Règles : seul le colis est disponible (jamais repas, pharmacie, épicerie) ; ne parle pas de paiement en espèces ; n'invente aucun chiffre, délai ni prix ; ` +
      `pas de fausse urgence ; rien de religieux ; si c'est une plainte ou un problème de livraison, excuse-toi simplement et invite à écrire en privé sur WhatsApp, sans rien promettre. ` +
      `Si le commentaire est une insulte ou du spam, réponds seulement « SANS_REPONSE ». Donne uniquement le texte de la réponse.`,
  );
  if (!r.ok || !r.text) {
    res.status(502).json({ ok: false, error: r.error || "Pas de réponse de l'IA." });
    return;
  }
  const texte = r.text.trim().replace(/^["«]\s*|\s*["»]$/g, "");
  res.json({ ok: true, texte: texte === "SANS_REPONSE" ? "" : texte, sansReponse: texte === "SANS_REPONSE" });
});

/** Envoie la reponse validee, sous le commentaire d'origine. */
commentairesRouter.post("/repondre", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const postId = String(b.postId ?? "");
  const accountId = String(b.accountId ?? "");
  const commentId = String(b.commentId ?? "");
  const message = String(b.message ?? "").trim();
  if (!postId || !accountId || !commentId || !message) {
    res.status(400).json({ ok: false, error: "Réponse incomplète" });
    return;
  }
  if (message.length > 1000) {
    res.status(400).json({ ok: false, error: "Réponse trop longue" });
    return;
  }
  const cle = crypto.createHash("sha1").update(JSON.stringify([postId, commentId, message])).digest("hex");
  const r = await zernioRequest("POST", `/v1/inbox/comments/${encodeURIComponent(postId)}`, { accountId, message, commentId }, { "Idempotency-Key": cle });
  if (!r.ok) {
    res.status(502).json({ ok: false, error: expliquer(r.status, r.error).message });
    return;
  }
  res.json({ ok: true });
});
