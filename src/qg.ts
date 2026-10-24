/**
 * QG marketing servi par le serveur Delivrou.
 *
 * Le QG etait publie comme page figee : les chiffres devaient etre reinjectes
 * a la main, et il fallait un compte Claude pour l'ouvrir. Servi ici, il lit
 * les statistiques en direct (collecteur Zernio), s'ouvre avec le mot de passe
 * du tableau de bord, et son etat (publications programmees, actions cochees)
 * est partage entre Ibrahima et Bachir au lieu d'etre local a chaque appareil.
 *
 * Le contenu (page, donnees, visuels) vit dans le volume persistant, a cote
 * des conversations, et se met a jour par `PUT /qg/file/<chemin>` depuis le
 * poste qui prepare les semaines. Rien n'est embarque dans l'image Docker :
 * une nouvelle semaine ne demande donc aucun redeploiement.
 */

import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { requireDashboardAuth } from "./auth.js";
import { getLatestByPlatform, weeklySeries, getLastRun } from "./stats.js";
import { qgApiRouter } from "./qg-api.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const QG_DIR = path.join(AUTH_DIR, "qg");
const STATE_FILE = path.join(QG_DIR, "state.json");
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

export const qgRouter = express.Router();

/** Etat partage : qui a programme quoi, quelles actions sont faites. */
interface QgState {
  programme: Record<string, Record<string, boolean>>;
  actions: Record<string, boolean>;
  notes: Record<string, string>;
  updatedAt?: number;
}

let state: QgState = { programme: {}, actions: {}, notes: {} };
let stateLoaded = false;

function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<QgState>;
      state = { programme: parsed.programme ?? {}, actions: parsed.actions ?? {}, notes: parsed.notes ?? {}, updatedAt: parsed.updatedAt };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] qg/state.json illisible, on repart a vide:", err instanceof Error ? err.message : err);
  }
}

function persistState() {
  try {
    fs.mkdirSync(QG_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Ecriture de qg/state.json impossible:", err instanceof Error ? err.message : err);
  }
}

/**
 * Resout un chemin demande a l'interieur de QG_DIR et refuse tout ce qui en
 * sort (`..`, chemin absolu, lien symbolique remontant). Renvoie null si le
 * chemin est hors limites.
 */
function safePath(rel: string): string | null {
  const clean = path.posix.normalize(rel.replace(/\\/g, "/")).replace(/^(\.\.(\/|$))+/, "");
  if (!clean || clean.startsWith("/") || clean.includes("..")) return null;
  const full = path.resolve(QG_DIR, clean);
  const root = path.resolve(QG_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function requireNotifyKey(req: Request, res: Response, next: NextFunction) {
  if (!NOTIFY_SECRET) {
    res.status(503).json({ ok: false, error: "NOTIFY_SECRET non configure" });
    return;
  }
  if (req.header("x-notify-key") !== NOTIFY_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// --- Mise a jour du contenu depuis le poste qui prepare les semaines ---
// Avant l'authentification par mot de passe : c'est une API machine.

/** Depose ou remplace un fichier du QG (page, donnees, visuel). */
qgRouter.put("/file/*", requireNotifyKey, express.raw({ type: "*/*", limit: "60mb" }), (req, res) => {
  const rel = String((req.params as Record<string, string>)[0] || "");
  const full = safePath(rel);
  if (!full) {
    res.status(400).json({ ok: false, error: "Chemin invalide" });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ ok: false, error: "Corps vide" });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, req.body);
    res.json({ ok: true, path: rel, bytes: req.body.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** Liste ce qui est deja en place (pour n'envoyer que le nouveau). */
qgRouter.get("/files", requireNotifyKey, (_req, res) => {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push({ path: rel, bytes: fs.statSync(path.join(dir, entry.name)).size });
    }
  };
  walk(QG_DIR, "");
  res.json({ ok: true, files: out });
});

/** Supprime un fichier devenu inutile (ancienne semaine, visuel remplace). */
qgRouter.delete("/file/*", requireNotifyKey, (req, res) => {
  const full = safePath(String((req.params as Record<string, string>)[0] || ""));
  if (!full) {
    res.status(400).json({ ok: false, error: "Chemin invalide" });
    return;
  }
  try {
    if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// --- A partir d'ici : reserve a Ibrahima et Bachir (mot de passe) ---
qgRouter.use(requireDashboardAuth);

// Conversations, prospects, journal : les memes donnees que le tableau de
// bord, en JSON, pour que le QG les affiche dans ses propres onglets.
qgRouter.use("/api", qgApiRouter);

/** Etat partage, lu par les deux appareils. */
qgRouter.get("/state", (_req, res) => {
  loadState();
  res.json({ ok: true, ...state });
});

/** Fusion d'une modification (une case cochee, une note). */
qgRouter.post("/state", express.json({ limit: "256kb" }), (req, res) => {
  loadState();
  const body = (req.body ?? {}) as Partial<QgState>;
  if (body.programme && typeof body.programme === "object") state.programme = body.programme as QgState["programme"];
  if (body.actions && typeof body.actions === "object") state.actions = body.actions as QgState["actions"];
  if (body.notes && typeof body.notes === "object") state.notes = body.notes as QgState["notes"];
  state.updatedAt = Date.now();
  persistState();
  res.json({ ok: true, updatedAt: state.updatedAt });
});

/**
 * Les statistiques sont servies en direct depuis le collecteur, jamais
 * depuis un fichier depose : le QG affiche donc toujours les derniers
 * chiffres, sans que personne ait a republier quoi que ce soit.
 */
qgRouter.get("/data/suivi.json", (_req, res) => {
  loadState();
  const run = getLastRun();
  res.set("Cache-Control", "no-store");
  res.json({
    maj: run ? new Date(run.at).toISOString().slice(0, 10) : null,
    source: "notify.delivrou.com (Zernio)",
    plateformes: getLatestByPlatform().map((p) => ({ platform: p.platform, name: p.name, followers: p.followers, date: p.date })),
    semaines: weeklySeries(),
    notes: state.notes,
  });
});

/** Page du QG. */
qgRouter.get("/", (_req, res) => {
  const index = path.join(QG_DIR, "index.html");
  if (!fs.existsSync(index)) {
    res
      .status(503)
      .type("html")
      .send(
        "<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;padding:40px;max-width:40em;margin:auto'>" +
          "<h1>QG pas encore installe</h1><p>Le contenu du QG n'a pas encore ete envoye sur ce serveur. " +
          "Lancez <code>node outils/deploy-qg.mjs</code> depuis le poste qui prepare les semaines.</p></body>",
      );
    return;
  }
  res.set("Cache-Control", "no-store");
  res.type("html").send(fs.readFileSync(index));
});

/** Donnees et visuels deposes (tout sauf suivi.json, traite plus haut). */
qgRouter.get("/*", (req, res) => {
  const full = safePath(String((req.params as Record<string, string>)[0] || ""));
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.status(404).type("txt").send("Not found");
    return;
  }
  const type = TYPES[path.extname(full).toLowerCase()];
  if (type) res.type(type);
  // Les visuels ne changent jamais sous le meme nom : on peut les garder en
  // cache. Les donnees, elles, doivent rester fraiches.
  res.set("Cache-Control", full.includes(`${path.sep}media${path.sep}`) ? "private, max-age=86400" : "no-store");
  res.sendFile(full);
});
