/**
 * Collecte automatique des statistiques des reseaux sociaux de Delivrou
 * (page Facebook, compte TikTok) via l'API Zernio, pour alimenter le
 * tableau de bord et le QG marketing sans saisie manuelle.
 *
 * Deux sources, relevees toutes les heures :
 *  - `/v1/accounts` : les comptes connectes, avec leur nombre d'abonnes
 *    actuel (`followersCount`). Pas d'historique : on date le releve du jour.
 *  - `/v1/analytics/daily-metrics` : une ligne par jour et par plateforme
 *    (impressions, portee, likes, commentaires, partages, clics, vues,
 *    nombre de publications). Zernio renvoie l'historique complet, donc le
 *    graphique est rempli des la premiere collecte.
 *
 * Tout est persiste dans un JSON a cote des conversations (meme volume).
 * Sans ZERNIO_API_KEY, la collecte est desactivee et le reste du service
 * (WhatsApp, tableau de bord) continue de tourner normalement.
 */

import fs from "node:fs";
import path from "node:path";
import { isZernioConfigured, listAccounts, dailyMetrics, type ZernioAccount } from "./zernio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const STATS_FILE = path.join(AUTH_DIR, "social_stats.json");
const INTERVAL_MS = Number(process.env.ZERNIO_POLL_MS || 60 * 60_000);
const MAX_DAYS = Number(process.env.ZERNIO_HISTORY_DAYS || 400);

/** Un releve par jour et par plateforme. Les champs inconnus restent null. */
export interface DailySnapshot {
  date: string; // AAAA-MM-JJ
  platform: string; // "facebook", "tiktok", ...
  accountId: string | null;
  name: string | null;
  followers: number | null;
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  posts: number | null;
  collectedAt: number;
}

interface StatsShape {
  snapshots: DailySnapshot[];
  lastRun?: { at: number; ok: boolean; error?: string; accounts: number; days: number };
}

let data: StatsShape = { snapshots: [] };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STATS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf8")) as StatsShape;
      if (parsed && Array.isArray(parsed.snapshots)) data = parsed;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] social_stats.json illisible, on repart a vide:", err instanceof Error ? err.message : err);
  }
}

function persist() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const tmp = `${STATS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Ecriture de social_stats.json impossible:", err instanceof Error ? err.message : err);
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function emptySnapshot(date: string, platform: string): DailySnapshot {
  return {
    date,
    platform,
    accountId: null,
    name: null,
    followers: null,
    impressions: null,
    reach: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    clicks: null,
    posts: null,
    collectedAt: Date.now(),
  };
}

/** Recupere (ou cree) le releve d'un jour et d'une plateforme. */
function slot(date: string, platform: string): DailySnapshot {
  const found = data.snapshots.find((s) => s.date === date && s.platform === platform);
  if (found) return found;
  const fresh = emptySnapshot(date, platform);
  data.snapshots.push(fresh);
  return fresh;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lance une collecte immediate. */
export async function collectNow(): Promise<{ ok: boolean; accounts: number; days: number; error?: string }> {
  load();
  if (!isZernioConfigured()) {
    const error = "ZERNIO_API_KEY non configuree.";
    data.lastRun = { at: Date.now(), ok: false, error, accounts: 0, days: 0 };
    persist();
    return { ok: false, accounts: 0, days: 0, error };
  }

  // --- 1. Metriques quotidiennes (historique complet, toutes plateformes) ---
  let days = 0;
  const dm = await dailyMetrics();
  if (dm.ok) {
    const root = dm.data as Record<string, unknown>;
    const list = (Array.isArray(root) ? root : root.dailyData) as unknown;
    if (Array.isArray(list)) {
      for (const entry of list as Record<string, unknown>[]) {
        const date = String(entry.date ?? "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const perPlatform = (entry.platformMetrics ?? {}) as Record<string, Record<string, unknown>>;
        for (const [platform, m] of Object.entries(perPlatform)) {
          const s = slot(date, platform.toLowerCase());
          s.impressions = num(m.impressions);
          s.reach = num(m.reach);
          s.views = num(m.views);
          s.likes = num(m.likes);
          s.comments = num(m.comments);
          s.shares = num(m.shares);
          s.clicks = num(m.clicks);
          s.posts = num(m.postCount);
          s.collectedAt = Date.now();
        }
        days++;
      }
    }
  }

  // --- 2. Abonnes actuels, par compte connecte ---
  const accounts = await listAccounts();
  if (!accounts.ok) {
    const error = accounts.error;
    data.lastRun = { at: Date.now(), ok: false, error, accounts: 0, days };
    persist();
    return { ok: false, accounts: 0, days, error };
  }

  const d = today();
  let count = 0;
  for (const acc of accounts.data as ZernioAccount[]) {
    const platform = String(acc.platform ?? "").toLowerCase();
    if (!platform) continue;
    const meta = (acc.metadata ?? {}) as Record<string, unknown>;
    const profile = (meta.profileData ?? {}) as Record<string, unknown>;
    const s = slot(d, platform);
    s.accountId = String(acc.id ?? acc._id ?? "") || null;
    s.name = String(acc.displayName ?? acc.username ?? "") || null;
    s.followers = num(acc.followersCount) ?? num(profile.followersCount);
    s.collectedAt = Date.now();
    count++;
  }

  // Purge de l'historique trop ancien, puis tri chronologique.
  const cutoff = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString().slice(0, 10);
  data.snapshots = data.snapshots
    .filter((s) => s.date >= cutoff)
    .sort((a, b) => (a.date === b.date ? a.platform.localeCompare(b.platform) : a.date < b.date ? -1 : 1));
  data.lastRun = { at: Date.now(), ok: true, accounts: count, days };
  persist();
  return { ok: true, accounts: count, days };
}

/** Tout l'historique, le plus ancien en premier. */
export function getSnapshots(): DailySnapshot[] {
  load();
  return data.snapshots;
}

/** Dernier releve connu par plateforme. */
export function getLatestByPlatform(): DailySnapshot[] {
  load();
  const byPlatform = new Map<string, DailySnapshot>();
  for (const s of data.snapshots) {
    // On veut le dernier jour qui porte une vraie valeur d'abonnes.
    const prev = byPlatform.get(s.platform);
    if (!prev || s.date >= prev.date) byPlatform.set(s.platform, s);
  }
  // Complete les abonnes avec le dernier jour ou ils etaient connus.
  for (const [platform, snap] of byPlatform) {
    if (snap.followers == null) {
      const withFollowers = [...data.snapshots].reverse().find((s) => s.platform === platform && s.followers != null);
      if (withFollowers) byPlatform.set(platform, { ...snap, followers: withFollowers.followers, name: snap.name ?? withFollowers.name });
    }
  }
  return [...byPlatform.values()];
}

export function getLastRun() {
  load();
  return data.lastRun ?? null;
}

/** Lundi de la semaine contenant cette date. */
function weekOf(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Agrege par semaine (lundi), au format attendu par le graphique du QG :
 * les volumes sont additionnes sur la semaine, les abonnes sont ceux de fin
 * de semaine (dernier jour connu).
 */
export function weeklySeries() {
  load();
  type Agg = { abonnes: number | null; portee: number; vues: number; impressions: number; engagement: number; posts: number };
  const weeks = new Map<string, Map<string, Agg>>();

  for (const s of data.snapshots) {
    const w = weekOf(s.date);
    const byPlatform = weeks.get(w) ?? new Map<string, Agg>();
    const a = byPlatform.get(s.platform) ?? { abonnes: null, portee: 0, vues: 0, impressions: 0, engagement: 0, posts: 0 };
    a.portee += s.reach ?? 0;
    a.vues += s.views ?? 0;
    a.impressions += s.impressions ?? 0;
    a.engagement += (s.likes ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);
    a.posts += s.posts ?? 0;
    // Les instantanes sont tries par date : le dernier connu gagne.
    if (s.followers != null) a.abonnes = s.followers;
    byPlatform.set(s.platform, a);
    weeks.set(w, byPlatform);
  }

  return [...weeks.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([semaine, byPlatform]) => {
      const row: Record<string, unknown> = { semaine };
      for (const [platform, a] of byPlatform) row[platform] = a;
      return row;
    });
}

let timer: NodeJS.Timeout | null = null;

/** Demarre la collecte periodique (appele au demarrage du service). */
export function startStatsCollector() {
  if (timer) return;
  if (!isZernioConfigured()) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] Info : ZERNIO_API_KEY non definie, collecte des statistiques sociales desactivee.");
    return;
  }
  const run = () => {
    collectNow()
      .then((r) => {
        if (!r.ok) console.error("[delivrou-notify] Collecte Zernio en echec:", r.error);
        else console.log(`[delivrou-notify] Collecte Zernio : ${r.accounts} compte(s), ${r.days} jour(s) de metriques.`);
      })
      .catch((err) => console.error("[delivrou-notify] Collecte Zernio en erreur:", err instanceof Error ? err.message : err));
  };
  // Premier passage 20s apres le demarrage, pour ne pas ralentir le boot.
  setTimeout(run, 20_000);
  timer = setInterval(run, INTERVAL_MS);
}
