/**
 * Garde-fous anti-blocage WhatsApp : au-dela du simple delai entre deux
 * envois, on limite le volume par destinataire, par minute et par jour, et
 * on coupe automatiquement les envois si WhatsApp se met a refuser les
 * messages (signe possible de restriction en cours).
 *
 * Tout est en memoire (redemarre a zero si le service redemarre) — c'est
 * suffisant pour ce service, l'objectif est d'eviter les rafales, pas de
 * tenir une comptabilite exacte entre deux redemarrages.
 */

const PER_RECIPIENT_COOLDOWN_MS = Number(process.env.WHATSAPP_PER_RECIPIENT_COOLDOWN_MS || 10_000);
const MAX_PER_MINUTE = Number(process.env.WHATSAPP_MAX_PER_MINUTE || 20);
const MAX_PER_DAY = Number(process.env.WHATSAPP_MAX_PER_DAY || 500);
const CIRCUIT_FAILURE_THRESHOLD = Number(process.env.WHATSAPP_CIRCUIT_FAILURE_THRESHOLD || 5);
const CIRCUIT_COOLDOWN_MS = Number(process.env.WHATSAPP_CIRCUIT_COOLDOWN_MS || 5 * 60_000);

const lastSentByPhone = new Map<string, number>();
const sentTimestampsLastMinute: number[] = [];
let sentCountToday = 0;
let todayKey = dayKey(new Date());

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const key = dayKey(new Date());
  if (key !== todayKey) {
    todayKey = key;
    sentCountToday = 0;
  }
}

function pruneLastMinute() {
  const cutoff = Date.now() - 60_000;
  while (sentTimestampsLastMinute.length > 0 && sentTimestampsLastMinute[0] < cutoff) {
    sentTimestampsLastMinute.shift();
  }
}

export type SafetyCheck = { allowed: true } | { allowed: false; reason: string; retryAfterMs?: number };

/** A appeler AVANT de tenter un envoi. Ne modifie aucun compteur. */
export function checkCanSend(phone: string): SafetyCheck {
  if (Date.now() < circuitOpenUntil) {
    return {
      allowed: false,
      reason: "Envois temporairement suspendus (trop d'echecs recents, protection anti-blocage WhatsApp active).",
      retryAfterMs: circuitOpenUntil - Date.now(),
    };
  }

  const lastSent = lastSentByPhone.get(phone);
  if (lastSent && Date.now() - lastSent < PER_RECIPIENT_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: `Un message a deja ete envoye a ce numero il y a moins de ${Math.round(PER_RECIPIENT_COOLDOWN_MS / 1000)}s.`,
      retryAfterMs: PER_RECIPIENT_COOLDOWN_MS - (Date.now() - lastSent),
    };
  }

  pruneLastMinute();
  if (sentTimestampsLastMinute.length >= MAX_PER_MINUTE) {
    return { allowed: false, reason: `Limite de ${MAX_PER_MINUTE} messages/minute atteinte, patientez.` };
  }

  resetDailyCounterIfNeeded();
  if (sentCountToday >= MAX_PER_DAY) {
    return { allowed: false, reason: `Limite de ${MAX_PER_DAY} messages/jour atteinte.` };
  }

  return { allowed: true };
}

/** A appeler APRES un envoi reussi, pour mettre a jour les compteurs. */
export function recordSentSuccess(phone: string) {
  const now = Date.now();
  lastSentByPhone.set(phone, now);
  pruneLastMinute();
  sentTimestampsLastMinute.push(now);
  resetDailyCounterIfNeeded();
  sentCountToday += 1;
  consecutiveFailures = 0;
}

/** A appeler APRES un envoi en echec, pour declencher le coupe-circuit si besoin. */
export function recordSentFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    // eslint-disable-next-line no-console
    console.error(
      `[delivrou-notify] ⚠️ ${consecutiveFailures} echecs d'envoi consecutifs : ` +
        `envois suspendus ${Math.round(CIRCUIT_COOLDOWN_MS / 60_000)} min par securite ` +
        `(risque de restriction WhatsApp en cours).`,
    );
  }
}

export function getSafetyStatus() {
  resetDailyCounterIfNeeded();
  pruneLastMinute();
  return {
    sentLastMinute: sentTimestampsLastMinute.length,
    maxPerMinute: MAX_PER_MINUTE,
    sentToday: sentCountToday,
    maxPerDay: MAX_PER_DAY,
    consecutiveFailures,
    circuitOpen: Date.now() < circuitOpenUntil,
    circuitOpenUntil: Date.now() < circuitOpenUntil ? new Date(circuitOpenUntil).toISOString() : null,
  };
}
