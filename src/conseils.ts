/**
 * Le rapport de mise a jour du QG, refait toutes les 6 heures sans que personne n'ait rien a lancer.
 *  - les chiffres viennent de Zernio et sont calcules ici : ce qui marche, ce qui ne marche pas ;
 *  - Gemini en tire des suggestions sur les affiches, les videos, les horaires et les mots-cles.
 * Une suggestion ne publie jamais rien : « Appliquer » prepare le travail dans le QG, l'humain decide.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { getLastRun, getSnapshots, getLatestByPlatform } from "./stats.js";
import { lister, statistiquesPost } from "./zernio-publish.js";
import { askGeminiJson, isGeminiConfigured } from "./gemini.js";
import { verifierRegles } from "./studio.js";
import { tousFilms } from "./films.js";
import { tousJobs } from "./affiches-captures.js";
import { isZernioConfigured } from "./zernio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FICHIER = path.join(AUTH_DIR, "qg", "conseils.json");
const PERIODE = Number(process.env.CONSEILS_PERIODE_MS || 6 * 3600_000);
const JOUR = 24 * 3600_000;
const MAX_POSTS = 30;

const DOMAINES = ["affiche", "video", "programmation", "motcle", "application"] as const;
type Domaine = (typeof DOMAINES)[number];
type StatutConseil = "a_faire" | "appliquee" | "ignoree";

export interface Suggestion { id: string; domaine: Domaine; titre: string; pourquoi: string; idee: string; heure?: string; statut: StatutConseil; date: string }
interface LignePost { titre: string; reseau: string; type: string; quand: string; tranche: string; vues: number; reactions: number; url: string | null }
interface Periode { portee: number; vues: number; engagement: number; posts: number }
interface Chiffres {
  abonnes: Array<{ reseau: string; nombre: number | null }>;
  semaine: Record<string, { actuelle: Periode; precedente: Periode }>;
  publications: number;
  echecs: number;
  meilleures: LignePost[];
  faibles: LignePost[];
  parType: Array<{ cle: string; posts: number; vuesMoyennes: number; reactionsMoyennes: number }>;
  parTranche: Array<{ cle: string; posts: number; vuesMoyennes: number; reactionsMoyennes: number }>;
  statsPublications: boolean;
}
export interface Rapport {
  date: string;
  chiffres: Chiffres;
  resume: string;
  marche: string[];
  marchePas: string[];
  suggestions: Suggestion[];
  historique: Suggestion[];
  erreurIA?: string;
}

const lire = (): Rapport | null => { try { return JSON.parse(fs.readFileSync(FICHIER, "utf8")) as Rapport; } catch { return null; } };
const ecrire = (r: Rapport) => { fs.mkdirSync(path.dirname(FICHIER), { recursive: true }); const tmp = FICHIER + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, FICHIER); };
const t = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

/** La tranche horaire d'une publication, heure de Conakry (GMT). */
const trancheDe = (iso: string) => { const h = new Date(iso).getUTCHours(); return h < 11 ? "matin (avant 11 h)" : h < 15 ? "midi (11 h - 15 h)" : h < 19 ? "après-midi (15 h - 19 h)" : "soir (après 19 h)"; };
const moyennes = (posts: LignePost[], cle: (p: LignePost) => string) => {
  const m = new Map<string, LignePost[]>();
  for (const p of posts) m.set(cle(p), [...(m.get(cle(p)) ?? []), p]);
  return [...m.entries()].map(([k, l]) => ({ cle: k, posts: l.length, vuesMoyennes: Math.round(l.reduce((a, p) => a + p.vues, 0) / l.length), reactionsMoyennes: Math.round((10 * l.reduce((a, p) => a + p.reactions, 0)) / l.length) / 10 })).sort((a, b) => b.vuesMoyennes - a.vuesMoyennes);
};

function periodes(): Chiffres["semaine"] {
  const jour = (d: number) => new Date(Date.now() - d * JOUR).toISOString().slice(0, 10);
  const res: Chiffres["semaine"] = {};
  const vide = (): Periode => ({ portee: 0, vues: 0, engagement: 0, posts: 0 });
  for (const s of getSnapshots()) {
    const quand = s.date > jour(7) ? "actuelle" : s.date > jour(14) ? "precedente" : null;
    if (!quand) continue;
    const p = (res[s.platform] ??= { actuelle: vide(), precedente: vide() })[quand];
    p.portee += s.reach ?? 0; p.vues += s.views ?? 0; p.posts += s.posts ?? 0;
    p.engagement += (s.likes ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);
  }
  return res;
}

/** Les vrais chiffres : rien ici ne vient de l'IA. */
async function calculerChiffres(): Promise<Chiffres> {
  const lignes: LignePost[] = [];
  let echecs = 0, publications = 0, statsPublications = true;
  const l = await lister();
  if (l.ok) {
    const passes = l.posts.filter((p) => p.quand && new Date(p.quand).getTime() < Date.now());
    echecs = passes.filter((p) => p.statut === "failed" || p.statutPost === "failed").length;
    const publies = passes.filter((p) => p.statut !== "failed" && p.statutPost !== "failed" && p.statutPost !== "cancelled");
    publications = publies.length;
    for (const p of publies.slice(0, MAX_POSTS)) {
      const s = await statistiquesPost(p.id);
      if (!s.ok) { statsPublications = false; break; }
      if (s.attente) continue;
      lignes.push({
        titre: t(p.texte, 90), reseau: p.reseau, type: p.mediaType === "video" ? "vidéo" : "affiche", quand: p.quand as string, tranche: trancheDe(p.quand as string),
        vues: s.stats.vues ?? s.stats.impressions ?? 0, reactions: (s.stats.likes ?? 0) + (s.stats.commentaires ?? 0) + (s.stats.partages ?? 0), url: s.stats.url,
      });
    }
  }
  const tries = [...lignes].sort((a, b) => b.reactions - a.reactions || b.vues - a.vues);
  return {
    abonnes: getLatestByPlatform().map((p) => ({ reseau: p.platform, nombre: p.followers })),
    semaine: periodes(), publications, echecs,
    meilleures: tries.slice(0, 3),
    // Une publication de moins de 24 h n'a pas encore eu sa chance.
    faibles: tries.filter((p) => Date.now() - new Date(p.quand).getTime() > JOUR).slice(-3).reverse().filter((p) => !tries.slice(0, 3).includes(p)),
    parType: moyennes(lignes, (p) => p.type),
    parTranche: moyennes(lignes, (p) => p.tranche),
    statsPublications,
  };
}

const CE_QUE_FAIT_LE_QG = `Ce que le QG Delivrou sait déjà faire, à ne jamais proposer comme nouveauté :
- Affiches avec les vraies captures de l'appli (Facebook 4:5, TikTok carré), plusieurs mises en page et personnages. Affiches IA dans le Studio.
- Films en motion design (carré par défaut), voix ElevenLabs, tons dont drôle et rigolo, sujet au hasard choisi par l'IA.
- Programmation Facebook et TikTok depuis le calendrier, partage en story Facebook.
- Mots-clés : un commentaire déclenche un message privé avec le lien. Quiz. Idées, accroches et fins générées par l'IA.
- Réponses aux commentaires et messages, prospects, statistiques.`;

function consigne(c: Chiffres, recents: string, deja: Suggestion[]) {
  return [
    "Tu es le responsable marketing de Delivrou, à Conakry. Voici l'état réel des publications. Dis ce qui marche, ce qui ne marche pas, et ce qu'on doit faire ensuite.",
    "CHIFFRES RÉELS (7 derniers jours comparés aux 7 d'avant, puis publications des 14 derniers jours) :\n" + JSON.stringify(c),
    "CE QUI A ÉTÉ PRODUIT RÉCEMMENT :\n" + recents,
    CE_QUE_FAIT_LE_QG,
    deja.length ? "DÉJÀ PROPOSÉ (appliqué ou refusé), ne le propose pas de nouveau :\n" + deja.map((s) => `- ${s.titre} (${s.statut})`).join("\n") : "",
    "RÈGLES : n'écris aucun chiffre qui n'est pas dans les données. Si les données sont trop faibles pour conclure (peu de publications, statistiques absentes), dis-le franchement au lieu d'inventer une tendance. Une corrélation sur 1 ou 2 publications n'est pas une preuve : présente-la comme une piste à tester.",
    "Les textes prêts à l'emploi (champ idee) respectent : tutoiement, français simple de Conakry, le seul service est le COLIS, aucun prix ni délai chiffré, aucune promesse de rapidité (jamais « vite », « rapide », « express »), aucun faux avis, pas de paiement en espèces, rien de religieux, ethnique ou politique.",
    `Propose 4 à 6 suggestions concrètes, en couvrant plusieurs domaines. domaine vaut "affiche", "video", "programmation", "motcle" ou "application". titre : l'action en moins de 10 mots. pourquoi : une phrase, appuyée sur un chiffre donné si possible. idee : pour affiche ou video, le sujet prêt à coller dans le formulaire ; pour motcle, le mot et son message ; sinon une précision courte. heure : seulement pour programmation, un horaire HH:MM à tester.`,
    'Réponds UNIQUEMENT en JSON : {"resume":"2 phrases","marche":["..."],"marchePas":["..."],"suggestions":[{"domaine":"","titre":"","pourquoi":"","idee":"","heure":""}]}',
  ].filter(Boolean).join("\n\n");
}

const lireJson = (texte: string): Record<string, unknown> | null => {
  const m = texte.match(/\{[\s\S]*\}/);
  try { return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null; } catch { return null; }
};
const liste = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : []).map((x) => t(x, n)).filter(Boolean).slice(0, max);

/** Ne garde que les suggestions complètes dont le texte prêt à l'emploi respecte les règles de marque. */
function nettoyer(v: unknown): Suggestion[] {
  const date = new Date().toISOString();
  return (Array.isArray(v) ? (v as Record<string, unknown>[]) : []).flatMap((s) => {
    const domaine = DOMAINES.find((d) => d === s.domaine);
    const titre = t(s.titre, 120), pourquoi = t(s.pourquoi, 300), idee = t(s.idee, 500), heure = t(s.heure, 5);
    if (!domaine || !titre || verifierRegles(titre, idee).length) return [];
    return [{ id: crypto.randomBytes(4).toString("hex"), domaine, titre, pourquoi, idee, ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(heure) ? { heure } : {}), statut: "a_faire" as const, date }];
  }).slice(0, 6);
}

let enCours = false;

/** Refait le rapport. Si l'IA ne répond pas, les chiffres sont à jour et les suggestions précédentes restent. */
export async function genererRapport(): Promise<Rapport | null> {
  if (enCours) return null;
  enCours = true;
  try {
    const avant = lire();
    const chiffres = await calculerChiffres();
    const passees = avant?.suggestions.filter((s) => s.statut !== "a_faire") ?? [];
    const historique = [...passees, ...(avant?.historique ?? [])].slice(0, 30);
    const base: Rapport = { date: new Date().toISOString(), chiffres, resume: avant?.resume ?? "", marche: avant?.marche ?? [], marchePas: avant?.marchePas ?? [], suggestions: avant?.suggestions.filter((s) => s.statut === "a_faire") ?? [], historique };
    if (!isGeminiConfigured()) { base.erreurIA = "L'IA n'est pas configurée sur le serveur (GEMINI_API_KEY)."; ecrire(base); return base; }
    const recents = [
      "Films : " + (tousFilms().slice(0, 8).map((f) => `${f.titre} (${f.ton ?? "?"}, ${f.format}, ${f.statut})`).join(" ; ") || "aucun"),
      "Affiches : " + (tousJobs().slice(0, 8).map((j) => `${j.titre ?? "?"} (${j.layout ?? "?"}, ${j.statut})`).join(" ; ") || "aucune"),
    ].join("\n");
    const r = await askGeminiJson(consigne(chiffres, recents, historique));
    const o = r.ok && r.text ? lireJson(r.text) : null;
    const nouvelles = o ? nettoyer(o.suggestions) : [];
    if (!o || !nouvelles.length) { base.erreurIA = "L'IA n'a pas répondu à cette mise à jour : les chiffres sont à jour, les suggestions sont celles de la fois précédente."; ecrire(base); return base; }
    const rapport: Rapport = { ...base, resume: t(o.resume, 500), marche: liste(o.marche, 240, 5), marchePas: liste(o.marchePas, 240, 5), suggestions: nouvelles };
    ecrire(rapport);
    return rapport;
  } finally { enCours = false; }
}

export const conseilsRouter = express.Router();

conseilsRouter.get("/", (_req: Request, res: Response) => {
  const run = getLastRun();
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ia: isGeminiConfigured(), enCours, collecte: run?.ok ? run.at : null, periodeH: PERIODE / 3600_000, rapport: lire() });
});

/** « Actualiser » : au plus une fois toutes les 10 minutes. */
conseilsRouter.post("/generer", (_req: Request, res: Response) => {
  const d = lire()?.date;
  if (d && Date.now() - new Date(d).getTime() < 10 * 60_000) { res.status(429).json({ ok: false, erreur: "Le rapport vient d'être refait. Réessaie dans quelques minutes." }); return; }
  void genererRapport().catch((e) => console.error("[delivrou-notify] Rapport de conseils en erreur:", e instanceof Error ? e.message : e));
  res.json({ ok: true, enCours: true });
});

conseilsRouter.post("/:id/statut", express.json({ limit: "4kb" }), (req: Request, res: Response) => {
  const statut = t((req.body as Record<string, unknown> | undefined)?.statut, 12) as StatutConseil;
  const r = lire();
  const s = r?.suggestions.find((x) => x.id === req.params.id);
  if (!r || !s || !["a_faire", "appliquee", "ignoree"].includes(statut)) { res.status(404).json({ ok: false, erreur: "Suggestion introuvable." }); return; }
  s.statut = statut;
  ecrire(r);
  res.json({ ok: true });
});

let minuteur: NodeJS.Timeout | null = null;

/** Vérifie chaque heure si le rapport a plus de 6 heures : un redémarrage du serveur ne fait donc pas sauter de mise à jour. */
export function demarrerConseils() {
  if (minuteur || !isZernioConfigured()) return;
  const verifier = () => {
    const d = lire()?.date;
    if (d && Date.now() - new Date(d).getTime() < PERIODE) return;
    genererRapport().catch((e) => console.error("[delivrou-notify] Rapport de conseils en erreur:", e instanceof Error ? e.message : e));
  };
  // Après la première collecte des statistiques (20 s après le démarrage).
  setTimeout(verifier, 90_000);
  minuteur = setInterval(verifier, 3600_000);
}
