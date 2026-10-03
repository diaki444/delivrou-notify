import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import QRCode from "qrcode";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
import { dashboardRouter } from "./dashboard.js";
import { isDashboardConfigured } from "./auth.js";

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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
app.get("/", (_req, res) => {
  res.redirect("/dashboard");
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

  if (!phone || !text) {
    res.status(400).json({ ok: false, error: "phone et text sont requis" });
    return;
  }
  if (!whatsapp.isConnected()) {
    res.status(503).json({ ok: false, error: "WhatsApp non connecte (QR pas encore scanne ou reconnexion en cours)" });
    return;
  }

  const result = await sendWithGuards(phone, text, "auto");
  if (!result.ok) {
    res.status(result.blocked ? 429 : 500).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

// Tableau de bord web (conversations, envoi manuel, journal). Desactive
// automatiquement si DASHBOARD_PASSWORD n'est pas configure.
app.use("/dashboard", dashboardRouter);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[delivrou-notify] API HTTP demarree sur le port ${PORT}`);
});

if (process.env.WHATSAPP_DISABLED === "true") {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] WHATSAPP_DISABLED=true : connexion WhatsApp desactivee volontairement. " +
      "Le tableau de bord reste accessible mais aucun message ne peut etre envoye ou recu.",
  );
} else {
  void whatsapp.connect().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Erreur de connexion WhatsApp:", err);
  });
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
