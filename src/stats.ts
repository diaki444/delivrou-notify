/**
 * Collecte automatique des statistiques des reseaux sociaux de Delivrou
 * (page Facebook, compte TikTok) via l'API Zernio, pour alimenter le
 * tableau de bord et le QG marketing sans saisie manuelle.
 *
 * Tourne toutes les heures, garde un instantane par jour et par compte dans
 * un fichier JSON a cote des conversations (meme volume persistant). Si
 * Zernio n'est pas configure ou repond mal, le service continue de tourner
 * normalement : les statistiques sont simplement absentes.
 */

import fs from "node:fs";
import path from "node:path";
import { isZernioConfigured, listAccounts, followerStats, dailyMetrics, type ZernioAccount } from "./zernio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const STATS_FILE = path.join(AUTH_DIR, "social_stats.json");
const INTERVAL_MS = Number(process.env.ZERNIO_POLL_MS || 60 * 60_000);
const MAX_DAYS = Number(process.env.ZERNIO_HISTORY_DAYS || 400);

/** Un instantane par compte et par jour. Les champs absents restent null. */
export interface DailySnapshot {
  date: string; // AAAA-MM-JJ
  accountId: string;
  platform: string;
  name: string;
  followers: number | null;
  reach: number | null;
  impressions: number | null;
  engagement: number | null;
  posts: number | null;
  collectedAt: number;
}

interface StatsShape {
  snapshots: DailySnapshot[];
  lastRun?: { at: number; ok: boolean; error?: string; accounts: number };
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

/**
 * Cherche un nombre dans une reponse JSON de forme inconnue, en testant
 * plusieurs noms de champ courants, a n'importe quelle profondeur. Evite de
 * dependre d'un schema Zernio exact qui n'est pas documente publiquement.
 */
function findNumber(obj: unknown, names: string[], depth = 0): number | null {
  if (obj == null || depth > 6) return null;
  if (Array.isArray(obj)) {
    // Sur une serie temporelle, la derniere entree est la plus recente.
    for (let i = obj.length - 1; i >= 0; i--) {
      const v = findNumber(obj[i], names, depth + 1);
      if (v != null) return v;
    }
    return null;
  }
  if (typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = names.map(norm);
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "number" && Number.isFinite(v) && wanted.includes(norm(k))) return v;
  }
  for (const v of Object.values(rec)) {
    const found = findNumber(v, names, depth + 1);
    if (found != null) return found;
  }
  return null;
}

const FIELDS = {
  followers: ["followers", "followerCount", "followersCount", "follower_count", "fans", "pageFans", "subscriberCount"],
  reach: ["reach", "pageImpressionsUnique", "uniqueImpressions", "accountsReached"],
  impressions: ["impressions", "views", "videoViews", "pageImpressions", "profileViews"],
  engagement: ["engagement", "engagements", "totalEngagement", "pageEngagement", "interactions", "likes"],
  posts: ["posts", "postCount", "postsCount", "videoCount"],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lance une collecte immediate. Renvoie le nombre de comptes releves. */
export async function collectNow(): Promise<{ ok: boolean; accounts: number; error?: string }> {
  load();
  if (!isZernioConfigured()) {
    const error = "ZERNIO_API_KEY non configuree.";
    data.lastRun = { at: Date.now(), ok: false, error, accounts: 0 };
    persist();
    return { ok: false, accounts: 0, error };
  }

  const accounts = await listAccounts();
  if (!accounts.ok) {
    data.lastRun = { at: Date.now(), ok: false, error: accounts.error, accounts: 0 };
    persist();
    return { ok: false, accounts: 0, error: accounts.error };
  }

  const end = today();
  const start = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  let count = 0;

  for (const acc of accounts.data as ZernioAccount[]) {
    const id = String(acc.id ?? "");
    if (!id) continue;
    const [fs_, dm] = await Promise.all([followerStats(id, start, end), dailyMetrics(id, start, end)]);
    const blob = { followers: fs_.ok ? fs_.data : null, metrics: dm.ok ? dm.data : null, account: acc };

    const snap: DailySnapshot = {
      date: end,
      accountId: id,
      platform: String(acc.platform ?? "inconnu").toLowerCase(),
      name: String(acc.name ?? acc.username ?? id),
      followers: findNumber(blob, FIELDS.followers),
      reach: findNumber(blob.metrics, FIELDS.reach),
      impressions: findNumber(blob.metrics, FIELDS.impressions),
      engagement: findNumber(blob.metrics, FIELDS.engagement),
      posts: findNumber(blob.metrics, FIELDS.posts),
      collectedAt: Date.now(),
    };

    // Un seul instantane par jour et par compte : le plus recent gagne.
    const i = data.snapshots.findIndex((s) => s.date === snap.date && s.accountId === snap.accountId);
    if (i >= 0) data.snapshots[i] = snap;
    else data.snapshots.push(snap);
    count++;
  }

  // Purge de l'historique trop ancien.
  const cutoff = new Date(Date.now() - MAX_DAYS * 86400_000).toISOString().slice(0, 10);
  data.snapshots = data.snapshots.filter((s) => s.date >= cutoff).sort((a, b) => (a.date < b.date ? -1 : 1));
  data.lastRun = { at: Date.now(), ok: true, accounts: count };
  persist();
  return { ok: true, accounts: count };
}

/** Tout l'historique, le plus ancien en premier. */
export function getSnapshots(): DailySnapshot[] {
  load();
  return data.snapshots;
}

/** Dernier instantane connu par compte. */
export function getLatestByAccount(): DailySnapshot[] {
  load();
  const byId = new Map<string, DailySnapshot>();
  for (const s of data.snapshots) byId.set(s.accountId, s);
  return [...byId.values()];
}

export function getLastRun() {
  load();
  return data.lastRun ?? null;
}

/**
 * Agrege l'historique par semaine (lundi), au format attendu par le
 * graphique du QG marketing.
 */
export function weeklySeries() {
  load();
  const weekOf = (iso: string) => {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const weeks = new Map<string, Record<string, unknown>>();
  for (const s of data.snapshots) {
    const w = weekOf(s.date);
    const row = weeks.get(w) ?? { semaine: w };
    const key = s.platform.includes("tiktok") ? "tiktok" : s.platform.includes("facebook") ? "facebook" : s.platform;
    // Le dernier jour de la semaine ecrase les precedents : on veut l'etat de fin de semaine.
    row[key] = { abonnes: s.followers, portee: s.reach, vues: s.impressions, engagement: s.engagement };
    weeks.set(w, row);
  }
  return [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
}

let timer: NodeJS.Timeout | null = null;

/** Demarre la collecte periodique (appele au demarrage du service). */
export function startStatsCollector() {
  if (timer || !isZernioConfigured()) {
    if (!isZernioConfigured()) {
      // eslint-disable-next-line no-console
      console.error("[delivrou-notify] Info : ZERNIO_API_KEY non definie, collecte des statistiques sociales desactivee.");
    }
    return;
  }
  const run = () => {
    collectNow()
      .then((r) => {
        if (!r.ok) console.error("[delivrou-notify] Collecte Zernio en echec:", r.error);
      })
      .catch((err) => console.error("[delivrou-notify] Collecte Zernio en erreur:", err instanceof Error ? err.message : err));
  };
  // Premier passage 20s apres le demarrage, pour ne pas ralentir le boot.
  setTimeout(run, 20_000);
  timer = setInterval(run, INTERVAL_MS);
}
