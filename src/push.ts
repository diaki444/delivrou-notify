/**
 * Notifications push (Web Push) pour l'app installee sur l'ecran d'accueil
 * du telephone : permet d'etre alerte des qu'un message WhatsApp arrive,
 * meme quand l'appli n'est pas ouverte. Necessite VAPID_PUBLIC_KEY et
 * VAPID_PRIVATE_KEY (generees une fois avec `npx web-push generate-vapid-keys`).
 */
import webpush from "web-push";
import {
  listPushSubscriptions,
  removePushSubscriptionByEndpoint,
  type StoredPushSubscription,
} from "./store.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || "mailto:prodiaki@gmail.com";

export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string | undefined {
  return VAPID_PUBLIC_KEY;
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export interface ResultatEnvoi { date: string; appareils: number; recus: number; erreurs: string[] }
let dernier: ResultatEnvoi | null = null;
export const dernierEnvoi = () => dernier;

/** Envoie une notification a tous les appareils abonnes (en general 1-2 : le ou les telephones du gerant). */
export async function notifyAllSubscriptions(payload: {
  title: string;
  body: string;
  url?: string;
}): Promise<ResultatEnvoi | null> {
  if (!isPushConfigured()) return null;
  const subs = listPushSubscriptions();
  const data = JSON.stringify(payload);
  const res: ResultatEnvoi = { date: new Date().toISOString(), appareils: subs.length, recus: 0, erreurs: [] };
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(toPushSubscription(sub), data);
        res.recus++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const hote = (() => { try { return new URL(sub.endpoint).host; } catch { return "?"; } })();
        res.erreurs.push(`${hote} : ${statusCode ?? ""} ${String((err as { body?: unknown })?.body ?? (err as Error)?.message ?? "").slice(0, 120)}`.trim());
        if (statusCode === 404 || statusCode === 410) {
          // Abonnement expire/revoque (appli desinstallee, permission retiree...) : on l'oublie.
          removePushSubscriptionByEndpoint(sub.endpoint);
        } else {
          // eslint-disable-next-line no-console
          console.error("[delivrou-notify] Echec notification push:", err);
        }
      }
    }),
  );
  dernier = res;
  return res;
}

function toPushSubscription(sub: StoredPushSubscription): webpush.PushSubscription {
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}
