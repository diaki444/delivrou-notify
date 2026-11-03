/**
 * Affiches fabriquees avec les vraies captures de l'appli. Le QG met une demande en file, le PC de l'equipe
 * (outils/affiche-usine.mjs) la fabrique (versions Facebook 4:5 et TikTok 9:16) et renvoie les images.
 * Memes actions que les creations du Studio : refaire, corriger, supprimer, approuver et programmer (legendes comprises).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { legendesIA, legendesModele, type Legs } from "./films.js";
import { verifierRegles } from "./studio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const DIR = path.join(AUTH_DIR, "qg", "affiches-captures-jobs");
const CATALOGUE = path.join(AUTH_DIR, "qg", "affiches-catalogue.json");

interface Reglages { sujet?: string; layout?: string; fond?: string; perso?: string; titre?: string; sous?: string }
interface Job {
  id: string;
  date: string;
  format: "4:5" | "9:16";
  statut: "a_produire" | "en_production" | "pret" | "echec";
  fichier?: string;
  fichier2?: string;
  titre?: string;
  texte?: string;
  sujet?: string;
  layout?: string;
  fond?: string;
  perso?: string;
  erreur?: string;
  reglages?: Reglages;
  legendes?: Legs;
}
const chemin = (id: string) => path.join(DIR, id.replace(/[^a-z0-9-]/gi, "") + ".json");
const lire = (id: string): Job | null => { try { return JSON.parse(fs.readFileSync(chemin(id), "utf8")) as Job; } catch { return null; } };
const ecrire = (j: Job) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(chemin(j.id), JSON.stringify(j)); };
const tous = (): Job[] => {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => lire(f.slice(0, -5))).filter((j): j is Job => !!j).sort((a, b) => b.date.localeCompare(a.date));
};
const c = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const catalogue = (): unknown => { try { return JSON.parse(fs.readFileSync(CATALOGUE, "utf8")); } catch { return { sujets: [], layouts: [], fonds: [] }; } };
let dernierPassagePc = 0;

/** Reglages saisis dans le QG : on ne garde que du texte court, et les memes regles de marque que partout. */
function nettoyerReglages(b: unknown): Reglages | { erreur: string } {
  const o = (b ?? {}) as Record<string, unknown>;
  const r: Reglages = {};
  for (const [k, n] of [["sujet", 20], ["layout", 20], ["fond", 20], ["perso", 24], ["titre", 80], ["sous", 120]] as const) if (c(o[k], n)) r[k] = c(o[k], n);
  const alertes = verifierRegles(r.titre ?? "", r.sous ?? "");
  if (alertes.length) return { erreur: alertes[0] };
  return r;
}
function nouveau(reglages?: Reglages): Job {
  return { id: `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`, date: new Date().toISOString(), format: "4:5", statut: "a_produire", ...(reglages && Object.keys(reglages).length ? { reglages } : {}) };
}
const supprimerFichiers = (id: string) => {
  const sid = id.replace(/[^a-z0-9-]/gi, "");
  try {
    fs.rmSync(chemin(id), { force: true });
    for (const n of [sid + ".png", sid + "-tiktok.png"]) fs.rmSync(path.join(AUTH_DIR, "qg", "affiches-captures", n), { force: true });
  } catch { /* deja supprime */ }
};

export const affichesCapturesRouter = express.Router();
affichesCapturesRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, jobs: tous().slice(0, 30), catalogue: catalogue(), pcVuIlYA: dernierPassagePc ? Math.round((Date.now() - dernierPassagePc) / 1000) : null });
});
affichesCapturesRouter.post("/demander", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
  if (tous().filter((j) => j.statut === "a_produire" || j.statut === "en_production").length >= 6) {
    res.status(429).json({ ok: false, erreur: "Déjà 6 affiches en attente : laisse le PC finir." });
    return;
  }
  const reg = nettoyerReglages((req.body as { reglages?: unknown } | undefined)?.reglages);
  if ("erreur" in reg) { res.status(400).json({ ok: false, erreur: reg.erreur }); return; }
  const job = nouveau(reg);
  ecrire(job);
  res.json({ ok: true, job });
});
/** Refaire (sans reglages : tout est retire au hasard) ou corriger (avec les reglages choisis). L'ancienne reste. */
affichesCapturesRouter.post("/:id/refaire", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
  if (!lire(String(req.params.id))) { res.status(404).json({ ok: false, erreur: "Affiche inconnue" }); return; }
  const reg = nettoyerReglages((req.body as { reglages?: unknown } | undefined)?.reglages);
  if ("erreur" in reg) { res.status(400).json({ ok: false, erreur: reg.erreur }); return; }
  const job = nouveau(reg);
  ecrire(job);
  res.json({ ok: true, job });
});
affichesCapturesRouter.post("/:id/supprimer", (req: Request, res: Response) => {
  supprimerFichiers(String(req.params.id));
  res.json({ ok: true });
});

const texteDe = (j: Job) => `${j.titre ?? ""}. ${j.texte ?? ""}`;
affichesCapturesRouter.get("/:id/legendes", async (req: Request, res: Response) => {
  const j = lire(String(req.params.id));
  if (!j) { res.status(404).json({ ok: false, erreur: "Affiche inconnue" }); return; }
  if (!j.legendes) {
    j.legendes = (await legendesIA({ titre: j.titre ?? "Delivrou", texte: texteDe(j), genre: "cette affiche" })) ?? legendesModele({ id: j.id, titre: j.titre ?? "Delivrou", texte: texteDe(j) });
    ecrire(j);
  }
  res.json({ ok: true, ...j.legendes });
});
affichesCapturesRouter.post("/:id/legendes/regenerer", async (req: Request, res: Response) => {
  const j = lire(String(req.params.id));
  if (!j) { res.status(404).json({ ok: false, erreur: "Affiche inconnue" }); return; }
  const n = await legendesIA({ titre: j.titre ?? "Delivrou", texte: texteDe(j), genre: "cette affiche" });
  if (!n) { res.status(503).json({ ok: false, erreur: "L'IA n'a pas pu écrire les légendes. Réessaie." }); return; }
  j.legendes = n;
  ecrire(j);
  res.json({ ok: true, ...n });
});
affichesCapturesRouter.put("/:id/legendes", express.json({ limit: "16kb" }), (req: Request, res: Response) => {
  const j = lire(String(req.params.id));
  if (!j) { res.status(404).json({ ok: false, erreur: "Affiche inconnue" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const liste = (v: unknown, n: number) => (Array.isArray(v) ? v : []).map((x) => c(x, 80)).filter(Boolean).slice(0, n);
  const l: Legs = { facebook: c(b.facebook, 2000), tiktok: c(b.tiktok, 300), hashtags: liste(b.hashtags, 12), motsCles: liste(b.motsCles, 16) };
  if (!l.facebook || !l.tiktok) { res.status(400).json({ ok: false, erreur: "Les deux légendes sont nécessaires." }); return; }
  const alertes = verifierRegles(l.facebook, l.tiktok);
  if (alertes.length) { res.status(400).json({ ok: false, erreur: alertes[0] }); return; }
  j.legendes = l;
  ecrire(j);
  res.json({ ok: true });
});

export const affichesMachineRouter = express.Router();
affichesMachineRouter.get("/a-produire", (_req, res) => {
  res.set("Cache-Control", "no-store");
  dernierPassagePc = Date.now();
  const recents = tous().filter((j) => j.statut === "pret").slice(0, 12).map((j) => ({ sujet: j.sujet, layout: j.layout, fond: j.fond, perso: j.perso }));
  res.json({ ok: true, jobs: tous().filter((j) => j.statut === "a_produire").map((j) => ({ id: j.id, format: j.format, reglages: j.reglages ?? null, recents })) });
});
/** Le PC publie la liste de ses sujets, mises en page et fonds : le QG s'en sert pour les menus « Corriger ». */
affichesMachineRouter.post("/catalogue", express.json({ limit: "32kb" }), (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const l = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 40);
  const sujets = l(b.sujets).map((x) => ({ id: c((x as Record<string, unknown>)?.id, 20), titre: c((x as Record<string, unknown>)?.titre, 90), sous: c((x as Record<string, unknown>)?.sous, 140), layouts: l((x as Record<string, unknown>)?.layouts).map((y) => c(y, 20)), persos: l((x as Record<string, unknown>)?.persos).map((y) => c(y, 24)) }));
  const cat = { sujets, layouts: l(b.layouts).map((x) => c(x, 20)), fonds: l(b.fonds).map((x) => c(x, 20)) };
  fs.mkdirSync(path.dirname(CATALOGUE), { recursive: true });
  fs.writeFileSync(CATALOGUE, JSON.stringify(cat));
  dernierPassagePc = Date.now();
  res.json({ ok: true });
});
affichesMachineRouter.post("/:id/statut", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
  const j = lire(String(req.params.id));
  if (!j) { res.status(404).json({ ok: false }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const st = String(b.statut);
  if (!["en_production", "pret", "echec"].includes(st)) { res.status(400).json({ ok: false }); return; }
  j.statut = st as Job["statut"];
  dernierPassagePc = Date.now();
  if (st === "pret") { j.fichier = c(b.fichier, 120); j.fichier2 = c(b.fichier2, 120) || undefined; j.titre = c(b.titre, 120); j.texte = c(b.texte, 400); j.sujet = c(b.sujet, 20); j.layout = c(b.layout, 20); j.fond = c(b.fond, 20); j.perso = c(b.perso, 24) || undefined; delete j.erreur; }
  if (st === "echec") j.erreur = c(b.erreur, 200);
  ecrire(j);
  res.json({ ok: true });
});
