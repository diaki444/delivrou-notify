/**
 * Temps de reponse et conversations en attente.
 *
 * La strategie du QG vise « 100 % des messages traites en moins de 24 h »,
 * mais rien ne le mesurait. On le calcule ici a partir des messages deja
 * stockes : aucune donnee supplementaire a collecter.
 *
 * Regle de calcul : pour chaque message recu qui a fini par recevoir une
 * reponse, on compte le delai jusqu'au premier message sortant qui suit.
 * Les rafales du client (plusieurs messages d'affilee) comptent pour une
 * seule attente, celle du premier.
 */

import { listChats, getMessages, isChatUnread, type ChatMeta } from "./store.js";

export interface ResponseStats {
  /** Delais en minutes, sur la periode. */
  median: number | null;
  average: number | null;
  /** Nombre d'echanges pris en compte. */
  answered: number;
  /** Conversations dont le dernier message vient du client. */
  pending: number;
  /** Depuis combien d'heures attend la plus ancienne. */
  oldestPendingHours: number | null;
  /** Conversations jamais ouvertes dans le tableau de bord. */
  unread: number;
  days: number;
}

const MIN = 60_000;

export function responseStats(days = 14): ResponseStats {
  const since = Date.now() - days * 86400_000;
  const delays: number[] = [];
  let pending = 0;
  let oldestPending: number | null = null;
  let unread = 0;

  for (const chat of listChats(300) as ChatMeta[]) {
    if (chat.isGroup) continue;
    if (isChatUnread(chat)) unread++;

    const msgs = getMessages(chat.jid, 300);
    let waitingSince: number | null = null;
    for (const m of msgs) {
      if (!m.fromMe) {
        // Rafale du client : seule la premiere attente compte.
        if (waitingSince === null) waitingSince = m.timestamp;
      } else if (waitingSince !== null) {
        if (waitingSince >= since) delays.push((m.timestamp - waitingSince) / MIN);
        waitingSince = null;
      }
    }
    // Reste une attente en cours ? La conversation attend une reponse.
    if (waitingSince !== null) {
      pending++;
      if (oldestPending === null || waitingSince < oldestPending) oldestPending = waitingSince;
    }
  }

  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const average = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;

  return {
    median: median === null ? null : Math.round(median),
    average: average === null ? null : Math.round(average),
    answered: sorted.length,
    pending,
    oldestPendingHours: oldestPending === null ? null : Math.round(((Date.now() - oldestPending) / 3600_000) * 10) / 10,
    unread,
    days,
  };
}

/** Les conversations qui attendent une reponse, la plus ancienne d'abord. */
export function pendingChats(): Array<{ jid: string; name: string; waitingHours: number; lastText: string }> {
  const out: Array<{ jid: string; name: string; waitingHours: number; lastText: string }> = [];
  for (const chat of listChats(300) as ChatMeta[]) {
    if (chat.isGroup) continue;
    const msgs = getMessages(chat.jid, 60);
    const last = msgs[msgs.length - 1];
    if (!last || last.fromMe) continue;
    // Debut de l'attente : le premier message recu apres notre derniere reponse.
    let start = last.timestamp;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].fromMe) break;
      start = msgs[i].timestamp;
    }
    out.push({
      jid: chat.jid,
      name: chat.name || chat.jid.split("@")[0],
      waitingHours: Math.round(((Date.now() - start) / 3600_000) * 10) / 10,
      lastText: last.text.slice(0, 120),
    });
  }
  return out.sort((a, b) => b.waitingHours - a.waitingHours);
}
