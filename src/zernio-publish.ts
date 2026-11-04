/**
 * Programmation des posts du QG sur Facebook et TikTok, via Zernio.
 *
 * Le calendrier du QG envoie un post (date, heure, fichier, legende) ; ce
 * module envoie le fichier a Zernio puis cree le post programme. Rien n'est
 * publie sans clic : la route qui l'appelle est derriere le mot de passe du
 * QG et l'interface demande une confirmation.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listAccounts, zernioRequest, type ZernioAccount } from "./zernio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const QG_DIR = path.join(AUTH_DIR, "qg");
/** Conakry est a GMT toute l'annee, sans heure d'ete. */
const TIMEZONE = "Africa/Conakry";
/** Marge minimale : Zernio publie tout de suite une date deja passee. */
const MIN_LEAD_MS = 5 * 60_000;

export type Reseau = "fb" | "tt";
export type ModeTikTok = "brouillon" | "direct";

export interface DemandeProgrammation {
  id: string;
  date: string;
  heure: string;
  reseaux: Reseau[];
  type: "image" | "video";
  facebookFile: string | null;
  tiktokFile: string | null;
  facebook: string;
  tiktok: string;
  tiktokMode: ModeTikTok;
}

export interface ResultatReseau {
  reseau: Reseau;
  ok: boolean;
  postId?: string;
  statut?: string;
  erreur?: string;
}

const PLATEFORME: Record<Reseau, string> = { fb: "facebook", tt: "tiktok" };
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };

/** Fichier du QG autorise : uniquement sous media/ ou studio/creations/, jamais en dehors du dossier. */
function resoudreFichier(rel: string): string | null {
  const clean = path.posix.normalize(String(rel).replace(/\\/g, "/"));
  if (!clean || clean.startsWith("/") || clean.includes("..")) return null;
  if (!["media/", "studio/creations/", "films/", "affiches-captures/"].some((p) => clean.startsWith(p))) return null;
  const full = path.resolve(QG_DIR, clean);
  if (!full.startsWith(path.resolve(QG_DIR) + path.sep)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

async function televerser(full: string): Promise<{ ok: true; url: string; mime: string } | { ok: false; erreur: string }> {
  const mime = MIME[path.extname(full).toLowerCase()];
  if (!mime) return { ok: false, erreur: `Format non pris en charge : ${path.extname(full)}` };
  const st = fs.statSync(full);

  const pre = await zernioRequest<{ uploadUrl?: string; publicUrl?: string }>("POST", "/v1/media/presign", { filename: path.basename(full), contentType: mime, size: st.size });
  if (!pre.ok) return { ok: false, erreur: pre.error };
  const { uploadUrl, publicUrl } = pre.data ?? {};
  if (!uploadUrl || !publicUrl) return { ok: false, erreur: "Zernio n'a pas donne d'adresse d'envoi." };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5 * 60_000);
  try {
    const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: fs.readFileSync(full), signal: ctrl.signal });
    if (!put.ok) return { ok: false, erreur: `Envoi du fichier refuse (HTTP ${put.status}).` };
  } catch (err) {
    return { ok: false, erreur: `Envoi du fichier impossible : ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, url: publicUrl, mime };
}

async function trouverCompte(plateforme: string): Promise<{ ok: true; compte: ZernioAccount } | { ok: false; erreur: string }> {
  const r = await listAccounts();
  if (!r.ok) return { ok: false, erreur: r.error };
  const candidats = r.data.filter((a) => String(a.platform ?? "").toLowerCase() === plateforme && a.isActive !== false);
  if (candidats.length === 0) return { ok: false, erreur: `Aucun compte ${plateforme} connecte dans Zernio.` };
  return { ok: true, compte: candidats[0] };
}

/** Verifie la demande et renvoie un message d'erreur, ou null si tout est bon. */
export function verifierDemande(d: DemandeProgrammation, maintenant = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}$/.test(d.heure)) return "Date ou heure illisible.";
  const quand = Date.parse(`${d.date}T${d.heure}:00Z`);
  if (!Number.isFinite(quand)) return "Date ou heure illisible.";
  if (quand < maintenant + MIN_LEAD_MS) return "L'heure est deja passee (ou dans moins de 5 minutes) : Zernio publierait tout de suite. Reportez le post d'abord.";
  if (!Array.isArray(d.reseaux) || d.reseaux.length === 0) return "Aucun reseau choisi.";
  if (d.reseaux.some((r) => r !== "fb" && r !== "tt")) return "Reseau inconnu.";
  return null;
}

/**
 * Modifier une programmation = supprimer l'ancienne chez Zernio puis recreer.
 * Un post deja publie ne peut pas etre supprime : on le laisse, et le nouveau
 * est cree avec un nouveau fichier envoye, donc sans conflit de doublon.
 */
async function supprimerAnciens(qgId: string, reseau: Reseau): Promise<string | null> {
  const l = await lister();
  if (!l.ok) return l.erreur;
  for (const p of l.posts) {
    if (p.qgId !== qgId || p.reseau !== reseau || !p.id || p.statutPost === "published") continue;
    const r = await zernioRequest("DELETE", `/v1/posts/${encodeURIComponent(p.id)}`);
    if (!r.ok) return r.error;
  }
  return null;
}

async function programmerUn(d: DemandeProgrammation, reseau: Reseau): Promise<ResultatReseau> {
  const plateforme = PLATEFORME[reseau];
  const rel = reseau === "tt" ? d.tiktokFile || d.facebookFile : d.facebookFile;
  const full = rel ? resoudreFichier(rel) : null;
  if (!full) return { reseau, ok: false, erreur: "Fichier du post introuvable sur le serveur." };

  const nettoyage = await supprimerAnciens(d.id, reseau);
  if (nettoyage) return { reseau, ok: false, erreur: "Impossible de remplacer l'ancienne programmation : " + nettoyage };

  const compte = await trouverCompte(plateforme);
  if (!compte.ok) return { reseau, ok: false, erreur: compte.erreur };
  const media = await televerser(full);
  if (!media.ok) return { reseau, ok: false, erreur: media.erreur };

  const texte = (reseau === "tt" ? d.tiktok : d.facebook) || "";
  const corps: Record<string, unknown> = {
    content: texte,
    mediaItems: [{ type: media.mime.startsWith("video/") ? "video" : "image", url: media.url }],
    platforms: [{ platform: plateforme, accountId: compte.compte.id }],
    scheduledFor: `${d.date}T${d.heure}:00Z`,
    timezone: TIMEZONE,
    metadata: { qgId: d.id, qgReseau: reseau },
  };
  if (reseau === "tt") {
    corps.tiktokSettings =
      d.tiktokMode === "direct"
        ? { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContentType: "none", contentPreviewConfirmed: true, expressConsentGiven: true }
        : { draft: true };
    // Photos : TikTok peut ajouter lui-meme une musique recommandee (impossible pour les videos).
    if (media.mime.startsWith("image/")) (corps.tiktokSettings as Record<string, unknown>).autoAddMusic = true;
  }

  // Meme post, meme contenu, meme heure = meme cle : un double clic ne programme pas deux fois.
  const cle = crypto.createHash("sha1").update(JSON.stringify([d.id, reseau, d.date, d.heure, rel, texte, d.tiktokMode])).digest("hex");
  const r = await zernioRequest<{ post?: { _id?: string; status?: string } }>("POST", "/v1/posts", corps, { "Idempotency-Key": cle });
  if (!r.ok) return { reseau, ok: false, erreur: r.error };
  return { reseau, ok: true, postId: r.data?.post?._id, statut: r.data?.post?.status };
}

export async function programmer(d: DemandeProgrammation): Promise<ResultatReseau[]> {
  const out: ResultatReseau[] = [];
  for (const reseau of d.reseaux) out.push(await programmerUn(d, reseau));
  return out;
}

export interface PostProgramme {
  id: string;
  statutPost: string;
  qgId: string;
  reseau: string;
  statut: string;
  quand: string | null;
  url: string | null;
  texte: string;
  media: string | null;
  mediaType: "image" | "video";
}

/** Change la date et l'heure des programmations pas encore publiees d'un post du QG. */
export async function modifierHoraire(qgId: string, date: string, heure: string): Promise<{ ok: true; modifies: number } | { ok: false; erreur: string }> {
  const l = await lister();
  if (!l.ok) return l;
  let modifies = 0;
  for (const p of l.posts) {
    if (p.qgId !== qgId || !p.id || p.statutPost === "published" || p.statutPost === "cancelled") continue;
    const r = await zernioRequest("PUT", `/v1/posts/${encodeURIComponent(p.id)}`, { scheduledFor: `${date}T${heure}:00Z`, timezone: TIMEZONE });
    if (!r.ok) return { ok: false, erreur: r.error };
    modifies++;
  }
  if (!modifies) return { ok: false, erreur: "Aucune programmation a modifier : deja publie ou introuvable chez Zernio." };
  return { ok: true, modifies };
}

/** Annule chez Zernio les programmations pas encore publiees d'un post du QG. Un post deja publie reste en ligne. */
export async function annuler(qgId: string): Promise<{ ok: true; annules: number; publies: number } | { ok: false; erreur: string }> {
  const l = await lister();
  if (!l.ok) return l;
  let annules = 0;
  let publies = 0;
  for (const p of l.posts) {
    if (p.qgId !== qgId || !p.id) continue;
    if (p.statutPost === "published") { publies++; continue; }
    const r = await zernioRequest("DELETE", `/v1/posts/${encodeURIComponent(p.id)}`);
    if (!r.ok) return { ok: false, erreur: r.error };
    annules++;
  }
  return { ok: true, annules, publies };
}

/** Etat reel des posts envoyes par le QG, relu chez Zernio. */
export async function lister(): Promise<{ ok: true; posts: PostProgramme[] } | { ok: false; erreur: string }> {
  const depuis = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const r = await zernioRequest<{ posts?: Array<Record<string, unknown>> }>("GET", `/v1/posts?limit=100&fromDate=${depuis}&fields=status,scheduledFor,platforms,metadata,content,mediaItems`);
  if (!r.ok) return { ok: false, erreur: r.error };
  const posts: PostProgramme[] = [];
  for (const p of r.data?.posts ?? []) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.qgId !== "string") continue;
    const plat = Array.isArray(p.platforms) ? (p.platforms[0] as Record<string, unknown> | undefined) : undefined;
    const m0 = Array.isArray(p.mediaItems) ? (p.mediaItems[0] as Record<string, unknown> | undefined) : undefined;
    posts.push({
      texte: typeof p.content === "string" ? p.content : "",
      media: typeof m0?.url === "string" ? m0.url : null,
      mediaType: m0?.type === "video" ? "video" : "image",
      id: String(p._id ?? ""),
      statutPost: String(p.status ?? ""),
      qgId: meta.qgId,
      reseau: String(meta.qgReseau ?? ""),
      statut: String(plat?.status ?? p.status ?? ""),
      quand: typeof p.scheduledFor === "string" ? p.scheduledFor : null,
      url: typeof plat?.platformPostUrl === "string" ? plat.platformPostUrl : null,
    });
  }
  return { ok: true, posts };
}

/** Chiffres d'une publication (vues, likes, commentaires, partages...), relevés chez Zernio. */
export interface StatsPost {
  vues: number | null;
  impressions: number | null;
  portee: number | null;
  likes: number | null;
  commentaires: number | null;
  partages: number | null;
  enregistrements: number | null;
  clics: number | null;
  taux: number | null;
  url: string | null;
  maj: string | null;
}

const nb = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Statistiques d'une publication, par son identifiant Zernio (GET /v1/analytics?postId=). */
export async function statistiquesPost(postId: string): Promise<{ ok: true; stats: StatsPost; attente: boolean } | { ok: false; erreur: string }> {
  const r = await zernioRequest<Record<string, unknown>>("GET", `/v1/analytics?postId=${encodeURIComponent(postId)}`);
  if (!r.ok) {
    return { ok: false, erreur: r.status === 402 ? "Les statistiques par publication demandent l'option Analytics de Zernio." : r.error };
  }
  const d = r.data ?? {};
  const plateformes = Array.isArray(d.platformAnalytics) ? (d.platformAnalytics as Record<string, unknown>[]) : [];
  const p = plateformes[0] ?? {};
  const a = ((p.analytics && typeof p.analytics === "object" ? p.analytics : d.analytics) ?? {}) as Record<string, unknown>;
  const stats: StatsPost = {
    vues: nb(a.views),
    impressions: nb(a.impressions),
    portee: nb(a.reach),
    likes: nb(a.likes),
    commentaires: nb(a.comments),
    partages: nb(a.shares),
    enregistrements: nb(a.saves),
    clics: nb(a.clicks),
    taux: nb(a.engagementRate),
    url: typeof p.platformPostUrl === "string" ? p.platformPostUrl : null,
    maj: typeof a.lastUpdated === "string" ? a.lastUpdated : null,
  };
  const vide = Object.entries(stats).every(([k, v]) => k === "url" || k === "maj" || v === null);
  return { ok: true, stats, attente: vide };
}
