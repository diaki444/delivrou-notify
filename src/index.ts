import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import QRCode from "qrcode";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
import { dashboardRouter } from "./dashboard.js";
import { qgRouter } from "./qg.js";
import { isDashboardConfigured } from "./auth.js";
import { startEmailPolling } from "./email.js";
import { metaClient, type IncomingWebhook } from "./whatsapp-meta.js";
import { startStatsCollector, collectNow, getLatestByPlatform, weeklySeries, getLastRun } from "./stats.js";
import { probe as zernioProbe } from "./zernio.js";

const PORT = Number(process.env.PORT || 3300);
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

if (!NOTIFY_SECRET) {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] ATTENTION : NOTIFY_SECRET n'est pas defini. " +
      "Definissez-le dans l'environnement avant de deployer en production " +
      "(sinon n'importe qui pourrait envoyer des messages depuis votre numero).",
  );
}
if (!isDashboardConfigured()) {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] Info : DASHBOARD_PASSWORD n'est pas defini, le tableau de bord web (/dashboard) est desactive.",
  );
}

const app = express();
app.use(
  express.json({
    // Garde le corps brut : Meta signe ses webhooks, la signature se verifie sur les octets d'origine.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));
// Manifest, icones et service worker pour pouvoir installer le tableau de
// bord sur l'ecran d'accueil du telephone (PWA) et recevoir des
// notifications push.
app.use(express.static(path.join(process.cwd(), "public")));

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!NOTIFY_SECRET) {
    res.status(503).json({ ok: false, error: "NOTIFY_SECRET non configure cote serveur" });
    return;
  }
  const provided = req.header("x-notify-key");
  if (provided !== NOTIFY_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

// Redirige la racine vers le tableau de bord, pour eviter un "Cannot GET /"
// confus quand on visite juste le domaine.
app.get("/", (req, res) => {
  // Deux portes d'entree pour le meme outil : qg.delivrou.com ouvre le QG
  // marketing, notify.delivrou.com garde les conversations WhatsApp.
  const host = String(req.headers.host || "").toLowerCase();
  res.redirect(host.startsWith("qg.") ? "/qg/" : "/dashboard");
});

// Pas d'authentification : juste pour un check de vie basique (load balancer, uptime monitor).
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    connected: whatsapp.isConnected(),
    queueLength: queueLength(),
    safety: getSafetyStatus(),
  });
});

// --- Statistiques des reseaux sociaux (via Zernio) ---

// Chiffres a jour : dernier releve par compte + serie hebdomadaire pour le
// graphique du QG marketing.
app.get("/stats", requireAuth, (_req, res) => {
  res.json({ ok: true, lastRun: getLastRun(), plateformes: getLatestByPlatform(), semaines: weeklySeries() });
});

// Force une collecte immediate, sans attendre le prochain passage horaire.
app.post("/stats/collect", requireAuth, async (_req, res) => {
  const r = await collectNow();
  res.status(r.ok ? 200 : 502).json(r);
});

// Diagnostic : quels endpoints Zernio repondent, avec un extrait de reponse.
// Ne revele jamais la cle API.
app.get("/stats/probe", requireAuth, async (_req, res) => {
  res.json(await zernioProbe());
});

// Lecture publique des chiffres agreges, pour alimenter le QG marketing
// (une page publiee sur claude.ai ne peut pas envoyer d'en-tete
// personnalise, donc pas de x-notify-key possible). Desactivee par defaut :
// mettre STATS_PUBLIC=true pour l'ouvrir. N'expose que des agregats
// (abonnes, portee, vues, engagement par semaine) : ni identifiants de
// compte, ni jetons, ni conversations.
app.get("/stats/public", (_req, res) => {
  if (process.env.STATS_PUBLIC !== "true") {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }
  const run = getLastRun();
  res.set("Cache-Control", "public, max-age=600");
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    ok: true,
    maj: run ? new Date(run.at).toISOString() : null,
    plateformes: getLatestByPlatform().map((p) => ({
      platform: p.platform,
      name: p.name,
      followers: p.followers,
      date: p.date,
    })),
    semaines: weeklySeries(),
  });
});

// Page web pour scanner le QR code depuis un navigateur (plus fiable que les
// logs en mode texte d'un panneau comme EasyPanel). Protegee par ?key=...
// car un GET classique de navigateur ne permet pas d'envoyer un en-tete
// personnalise facilement.
app.get("/qr", async (req, res) => {
  if (!NOTIFY_SECRET || req.query.key !== NOTIFY_SECRET) {
    res.status(401).send("Unauthorized");
    return;
  }

  if (whatsapp.isConnected()) {
    res.send(
      "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;text-align:center;padding:40px'>" +
        "<h1>✅ WhatsApp deja connecte</h1><p>Rien a scanner, le service est pret.</p></body>",
    );
    return;
  }

  const qr = whatsapp.getLastQr();
  if (!qr) {
    res.send(
      "<!doctype html><meta charset='utf-8'><meta http-equiv='refresh' content='3'>" +
        "<body style='font-family:sans-serif;text-align:center;padding:40px'>" +
        "<h1>⏳ En attente du QR code...</h1><p>Cette page se rafraichit automatiquement.</p></body>",
    );
    return;
  }

  const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
  res.send(
    "<!doctype html><meta charset='utf-8'><meta http-equiv='refresh' content='20'>" +
      "<body style='font-family:sans-serif;text-align:center;padding:40px'>" +
      "<h1>Scannez ce QR code</h1>" +
      "<p>WhatsApp &gt; Parametres &gt; Appareils lies &gt; Lier un appareil</p>" +
      `<img src="${dataUrl}" alt="QR code WhatsApp" style="margin:20px auto" />` +
      "<p style='color:#888'>Cette page se rafraichit automatiquement toutes les 20 secondes.</p></body>",
  );
});

// --- Webhook de l'API officielle Meta (public : Meta l'appelle depuis ses serveurs) ---
// Poignee de main de verification, puis messages entrants. Actif seulement
// des que WHATSAPP_VERIFY_TOKEN est defini (sinon 404). Les messages ne sont
// traites que si WHATSAPP_PROVIDER=meta : on peut donc brancher et verifier le
// webhook chez Meta pendant que le service reste en mode QR code.
app.get("/webhook/whatsapp", (req, res) => {
  if (!process.env.WHATSAPP_VERIFY_TOKEN) return res.sendStatus(404);
  if (metaClient.verifyHandshake(req.query["hub.mode"], req.query["hub.verify_token"])) {
    return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
  }
  return res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  if (!process.env.WHATSAPP_VERIFY_TOKEN) return res.sendStatus(404);
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!metaClient.verifySignature(raw, req.header("x-hub-signature-256"))) return res.sendStatus(401);
  // Accuser reception tout de suite : Meta reessaie si la reponse tarde.
  res.sendStatus(200);
  if (process.env.WHATSAPP_PROVIDER !== "meta") return; // mode QR code : on ignore les messages Meta
  try {
    metaClient.handleWebhook(req.body as IncomingWebhook);
  } catch (err) {
    console.error("[delivrou-notify] Erreur traitement webhook WhatsApp:", err);
  }
});

app.post("/check", requireAuth, async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  if (!phone) {
    res.status(400).json({ ok: false, error: "phone manquant" });
    return;
  }
  if (!whatsapp.isConnected()) {
    res.status(503).json({ ok: false, error: "WhatsApp non connecte" });
    return;
  }
  try {
    const exists = await whatsapp.numberHasWhatsApp(phone);
    res.json({ ok: true, phone, exists });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/send", requireAuth, async (req, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  const text = String(req.body?.text || "").trim();
  // Message modele (API officielle) : { phone, template: "nom", params: ["a","b"], lang: "fr" }
  const tpl = req.body?.template ? String(req.body.template) : "";
  const params = Array.isArray(req.body?.params) ? (req.body.params as unknown[]).map(String) : [];
  const lang = req.body?.lang ? String(req.body.lang) : "fr";

  if (!phone || (!text && !tpl)) {
    res.status(400).json({ ok: false, error: "phone et text (ou template) sont requis" });
    return;
  }
  if (!whatsapp.isConnected()) {
    res.status(503).json({ ok: false, error: "WhatsApp non connecte (QR pas encore scanne ou reconnexion en cours)" });
    return;
  }

  const result = await sendWithGuards(phone, text || `[modele ${tpl}] ${params.join(" | ")}`, "auto", tpl ? { name: tpl, params, lang } : undefined);
  if (!result.ok) {
    res.status(result.blocked ? 429 : 500).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

// Tableau de bord web (conversations, envoi manuel, journal). Desactive
// automatiquement si DASHBOARD_PASSWORD n'est pas configure.
app.use("/dashboard", dashboardRouter);
// QG marketing (calendrier des posts, reponses, croissance, strategie).
// Sans la barre finale, le navigateur resout les chemins relatifs de la page
// (data/, media/, logo.png) a la racine du site au lieu du dossier /qg/.
app.get("/qg", (req, res, next) => {
  // Express traite `/qg` et `/qg/` comme la meme route : sans ce test, la
  // redirection se renverrait vers elle-meme en boucle.
  if (req.originalUrl.split("?")[0].endsWith("/")) return next();
  res.redirect(302, "/qg/");
});
app.use("/qg", qgRouter);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[delivrou-notify] API HTTP demarree sur le port ${PORT}`);
});

// Collecte horaire des statistiques Facebook / TikTok. Independante de
// WhatsApp : elle tourne meme si la connexion WhatsApp est suspendue.
startStatsCollector();

// Boite email du QG (inactive tant que GMAIL_USER / GMAIL_APP_PASSWORD sont absents).
startEmailPolling();

if (process.env.WHATSAPP_DISABLED === "true") {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] WHATSAPP_DISABLED=true : connexion WhatsApp desactivee volontairement. " +
      "Le tableau de bord reste accessible mais aucun message ne peut etre envoye ou recu.",
  );
} else {
  // Interrupteur ponctuel : WHATSAPP_WIPE_AUTH=true efface une session
  // auth_info/ corrompue ou deconnectee (ex: code 401 au redemarrage) avant
  // de relancer la connexion, pour forcer un nouveau scan de QR. A retirer
  // de l'environnement une fois le nouveau QR scanne avec succes.
  if (process.env.WHATSAPP_WIPE_AUTH === "true") {
    const authDir = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
    try {
      // authDir est le point de montage du volume Docker : on ne peut pas
      // supprimer le dossier lui-meme (EBUSY), seulement son contenu. On
      // garde dashboard_data.json (conversations, prospects, journal),
      // stocke dans le meme dossier que les cles de session WhatsApp : seule
      // la session doit etre effacee, pas les donnees du tableau de bord.
      if (fs.existsSync(authDir)) {
        for (const entry of fs.readdirSync(authDir)) {
          if (entry === "dashboard_data.json" || entry === "social_stats.json") continue;
          fs.rmSync(path.join(authDir, entry), { recursive: true, force: true });
        }
      }
      // eslint-disable-next-line no-console
      console.error(
        `[delivrou-notify] WHATSAPP_WIPE_AUTH=true : session WhatsApp (${authDir}) effacee. ` +
          "Retirez cette variable apres avoir rescanne le QR.",
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[delivrou-notify] Echec de l'effacement de auth_info:", err);
    }
  }
  void whatsapp.connect().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Erreur de connexion WhatsApp:", err);
  });
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
