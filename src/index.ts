import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { whatsapp } from "./whatsapp-client.js";

const PORT = Number(process.env.PORT || 3300);
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const MIN_DELAY_MS = Number(process.env.WHATSAPP_MIN_DELAY_MS || 1500);
const SEND_TIMEOUT_MS = Number(process.env.WHATSAPP_SEND_TIMEOUT_MS || 20000);

if (!NOTIFY_SECRET) {
  // eslint-disable-next-line no-console
  console.error(
    "[delivrou-notify] ATTENTION : NOTIFY_SECRET n'est pas defini. " +
      "Definissez-le dans l'environnement avant de deployer en production " +
      "(sinon n'importe qui pourrait envoyer des messages depuis votre numero).",
  );
}

// --- File d'attente simple pour serialiser les envois et respecter un delai
// minimum entre deux messages (reduit le risque de blocage WhatsApp lors
// d'un pic de notifications, ex: plusieurs commandes au meme moment). ---
type Job = () => Promise<void>;
const queue: Job[] = [];
let processing = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    await job();
    await sleep(MIN_DELAY_MS);
  }
  processing = false;
}

function enqueueSend(phone: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const job: Job = async () => {
      try {
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Timeout d'envoi WhatsApp")), SEND_TIMEOUT_MS),
        );
        await Promise.race([whatsapp.sendText(phone, text), timeout]);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    queue.push(job);
    void drainQueue();
  });
}

const app = express();
app.use(express.json());

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

// Pas d'authentification : juste pour un check de vie basique (load balancer, uptime monitor).
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", requireAuth, (_req, res) => {
  res.json({ ok: true, connected: whatsapp.isConnected(), queueLength: queue.length });
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

  try {
    await enqueueSend(phone, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[delivrou-notify] API HTTP demarree sur le port ${PORT}`);
});

void whatsapp.connect().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[delivrou-notify] Erreur de connexion WhatsApp:", err);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
