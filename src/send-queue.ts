import { whatsapp } from "./whatsapp-client.js";
import { checkCanSend, recordSentSuccess, recordSentFailure } from "./safety.js";
import { addSendLogEntry } from "./store.js";
import { MetaError } from "./whatsapp-meta.js";

const SEND_TIMEOUT_MS = Number(process.env.WHATSAPP_SEND_TIMEOUT_MS || 20000);

type Job = () => Promise<void>;
const queue: Job[] = [];
let processing = false;
const MIN_DELAY_MS = Number(process.env.WHATSAPP_MIN_DELAY_MS || 1500);

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

export function queueLength(): number {
  return queue.length;
}

/** Un parametre de modele tient sur une ligne : pas de retour a la ligne ni de longues series d'espaces. */
function oneLine(text: string): string {
  return text.replace(/\s*[
	]+\s*/g, " · ").replace(/ {2,}/g, " ").trim().slice(0, 700);
}

export type SendSource = "auto" | "manual";
export type SendResult = { ok: boolean; error?: string; blocked?: boolean };

/**
 * Point d'entree unique pour tout envoi WhatsApp (API externe comme
 * tableau de bord) : verifie les garde-fous anti-blocage, met en file,
 * et journalise le resultat dans l'historique visible du tableau de bord.
 */
export type SendTemplate = { name: string; params?: string[]; lang?: string };

export function sendWithGuards(phone: string, text: string, source: SendSource, template?: SendTemplate): Promise<SendResult> {
  if (process.env.WHATSAPP_DISABLED === "true") {
    const reason = "WhatsApp desactive (WHATSAPP_DISABLED=true) : envoi suspendu volontairement.";
    addSendLogEntry({ phone, text, source, status: "blocked", error: reason });
    return Promise.resolve({ ok: false, error: reason, blocked: true });
  }

  const safety = checkCanSend(phone);
  if (!safety.allowed) {
    addSendLogEntry({ phone, text, source, status: "blocked", error: safety.reason });
    return Promise.resolve({ ok: false, error: safety.reason, blocked: true });
  }

  return new Promise((resolve) => {
    const job: Job = async () => {
      try {
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Timeout d'envoi WhatsApp")), SEND_TIMEOUT_MS),
        );
        let usedFallback = false;
        try {
          await Promise.race([template ? whatsapp.sendTemplate(phone, template.name, template.params ?? [], template.lang ?? "fr") : whatsapp.sendText(phone, text), timeout]);
        } catch (err) {
          // Fenetre de 24 h fermee sur un message automatique : on renvoie le meme texte dans le modele de secours approuve.
          const fb = process.env.WHATSAPP_FALLBACK_TEMPLATE;
          if (fb && !template && source === "auto" && err instanceof MetaError && err.windowClosed) {
            await Promise.race([whatsapp.sendTemplate(phone, fb, [oneLine(text)], process.env.WHATSAPP_FALLBACK_LANG || "fr", text), timeout]);
            usedFallback = true;
          } else {
            throw err;
          }
        }
        recordSentSuccess(phone);
        addSendLogEntry({ phone, text: usedFallback ? `[modele de secours] ${text}` : text, source, status: "sent" });
        resolve({ ok: true });
      } catch (err) {
        recordSentFailure();
        const message = err instanceof Error ? err.message : String(err);
        addSendLogEntry({ phone, text, source, status: "failed", error: message });
        resolve({ ok: false, error: message });
      }
    };
    queue.push(job);
    void drainQueue();
  });
}
