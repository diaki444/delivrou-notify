/**
 * Affiches fabriquees avec les vraies captures de l'appli. Le QG met une demande en file, le PC de l'equipe
 * (outils/affiche-usine.mjs) la fabrique et renvoie l'image. Meme principe que les films animes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const DIR = path.join(AUTH_DIR, "qg", "affiches-captures-jobs");

interface Job {
  id: string;
  date: string;
  format: "4:5" | "9:16";
  statut: "a_produire" | "en_production" | "pret" | "echec";
  fichier?: string;
  fichier2?: string;
  titre?: string;
  sujet?: string;
  layout?: string;
  fond?: string;
  erreur?: string;
}
const chemin = (id: string) => path.join(DIR, id.replace(/[^a-z0-9-]/gi, "") + ".json");
const lire = (id: string): Job | null => { try { return JSON.parse(fs.readFileSync(chemin(id), "utf8")) as Job; } catch { return null; } };
const ecrire = (j: Job) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(chemin(j.id), JSON.stringify(j)); };
const tous = (): Job[] => {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => lire(f.slice(0, -5))).filter((j): j is Job => !!j).sort((a, b) => b.date.localeCompare(a.date));
};
let dernierPassagePc = 0;

export const affichesCapturesRouter = express.Router();
affichesCapturesRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, jobs: tous().slice(0, 30), pcVuIlYA: dernierPassagePc ? Math.round((Date.now() - dernierPassagePc) / 1000) : null });
});
affichesCapturesRouter.post("/demander", express.json({ limit: "4kb" }), (req: Request, res: Response) => {
  const format = (req.body as { format?: string } | undefined)?.format === "9:16" ? "9:16" : "4:5";
  if (tous().filter((j) => j.statut === "a_produire" || j.statut === "en_production").length >= 6) {
    res.status(429).json({ ok: false, erreur: "Déjà 6 affiches en attente : laisse le PC finir." });
    return;
  }
  const job: Job = { id: `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`, date: new Date().toISOString(), format, statut: "a_produire" };
  ecrire(job);
  res.json({ ok: true, job });
});
affichesCapturesRouter.post("/:id/supprimer", (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const sid = id.replace(/[^a-z0-9-]/gi, "");
    fs.rmSync(chemin(id), { force: true });
    for (const n of [sid + ".png", sid + "-tiktok.png"]) fs.rmSync(path.join(AUTH_DIR, "qg", "affiches-captures", n), { force: true });
  } catch { /* deja supprime */ }
  res.json({ ok: true });
});

export const affichesMachineRouter = express.Router();
affichesMachineRouter.get("/a-produire", (_req, res) => {
  res.set("Cache-Control", "no-store");
  dernierPassagePc = Date.now();
  const recents = tous().filter((j) => j.statut === "pret").slice(0, 12).map((j) => ({ sujet: j.sujet, layout: j.layout, fond: j.fond }));
  res.json({ ok: true, jobs: tous().filter((j) => j.statut === "a_produire").map((j) => ({ id: j.id, format: j.format, recents })) });
});
affichesMachineRouter.post("/:id/statut", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
  const j = lire(String(req.params.id));
  if (!j) { res.status(404).json({ ok: false }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const st = String(b.statut);
  if (!["en_production", "pret", "echec"].includes(st)) { res.status(400).json({ ok: false }); return; }
  const c = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  j.statut = st as Job["statut"];
  dernierPassagePc = Date.now();
  if (st === "pret") { j.fichier = c(b.fichier, 120); j.fichier2 = c(b.fichier2, 120) || undefined; j.titre = c(b.titre, 120); j.sujet = c(b.sujet, 20); j.layout = c(b.layout, 20); j.fond = c(b.fond, 20); delete j.erreur; }
  if (st === "echec") j.erreur = c(b.erreur, 200);
  ecrire(j);
  res.json({ ok: true });
});
