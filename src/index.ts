import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
import { dashboardRouter } from "./dashboard.js";
import { isDashboardConfigured } from "./auth.js";

const PORT = Number(process.env.PORT || 3300);
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

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
if (!whatsapp.isConfigured()) {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] ATTENTION : WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN non definis. " +
      "Aucun message ne pourra etre envoye tant que l'API WhatsApp Business (Meta Cloud API) n'est pas configuree.",
  );
}
if (process.env.WHATSAPP_DISABLED === "true") {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] WHATSAPP_DISABLED=true : envoi WhatsApp suspendu volontairement. " +
      "Le tableau de bord reste accessible, mais aucun message ne peut etre envoye.",
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

// --- Webhook WhatsApp (Meta Cloud API) ---
// Meta appelle GET une seule fois pour verifier l'URL (handshake), puis
// POST a chaque message recu ou mise a jour de statut. A configurer dans
// developers.facebook.com > votre app > WhatsApp > Configuration >
// Webhooks, avec l'URL https://votre-domaine/webhook/whatsapp et le meme
// token que WHATSAPP_WEBHOOK_VERIFY_TOKEN.
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && WEBHOOK_VERIFY_TOKEN && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }
  res.sendStatus(403);
});

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

app.post("/webhook/whatsapp", (req, res) => {
  // Accuser reception immediatement : Meta reessaie/abandonne si la reponse tarde.
  res.sendStatus(200);

  try {
    const payload = req.body as WhatsAppWebhookPayload;
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages ?? [];
    if (messages.length === 0) return;

    const nameByWaId = new Map<string, string | undefined>(
      (value?.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name]),
    );

    for (const m of messages) {
      if (!m.from || !m.id) continue;
      const text = m.text?.body ?? (m.type ? `[message ${m.type}]` : "");
      if (!text) continue;
      whatsapp.handleIncomingMessage({
        from: m.from,
        id: m.id,
        timestamp: (Number(m.timestamp) || 0) * 1000 || Date.now(),
        text,
        senderName: nameByWaId.get(m.from) || undefined,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Erreur traitement webhook WhatsApp:", err);
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
    res.status(503).json({ ok: false, error: "API WhatsApp non configuree" });
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

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
