/**
 * Client minimal de l'API Zernio (https://zernio.com), utilise pour recuperer
 * les statistiques des comptes sociaux de Delivrou (page Facebook, compte
 * TikTok) sans avoir a creer et faire valider une application Meta ou TikTok.
 *
 * Necessite ZERNIO_API_KEY. Sans cle, toutes les fonctions renvoient
 * ok:false sans jamais faire planter le reste du service.
 *
 * Les chemins exacts de l'API n'etant pas publies sur une page accessible
 * sans compte, chaque appel essaie plusieurs chemins connus (releves dans
 * les SDK generes Go et Rust) et retient celui qui repond. Le chemin qui a
 * marche est memorise pour la duree du process, donc un seul appel est
 * "gaspille" au premier passage. `probe()` sert a verifier tout ca depuis le
 * tableau de bord, sans acces SSH.
 */

const API_KEY = process.env.ZERNIO_API_KEY;
const BASES = (process.env.ZERNIO_BASE_URL || "https://api.zernio.com,https://zernio.com/api").split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.ZERNIO_TIMEOUT_MS || 15000);

export function isZernioConfigured(): boolean {
  return Boolean(API_KEY);
}

export type ZernioResult<T> = { ok: true; data: T; via: string } | { ok: false; error: string; status?: number };

/** Chemin qui a repondu pour un usage donne, memorise pour eviter de re-essayer a chaque fois. */
const resolved = new Map<string, string>();

async function fetchJson(url: string, query?: Record<string, string>): Promise<{ status: number; body: unknown; text: string }> {
  const u = new URL(url);
  if (query) for (const [k, v] of Object.entries(query)) if (v) u.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Essaie chaque base x chaque chemin candidat jusqu'a une reponse 200 avec du
 * JSON. `key` identifie l'usage (accounts, follower-stats...) pour memoriser
 * le chemin gagnant.
 */
async function tryPaths<T>(key: string, paths: string[], query?: Record<string, string>): Promise<ZernioResult<T>> {
  if (!API_KEY) return { ok: false, error: "ZERNIO_API_KEY non configuree sur le serveur." };

  const known = resolved.get(key);
  const candidates: string[] = [];
  if (known) candidates.push(known);
  for (const base of BASES) for (const p of paths) {
    const full = base.replace(/\/+$/, "") + p;
    if (full !== known) candidates.push(full);
  }

  let lastStatus: number | undefined;
  let lastError = "Aucun chemin Zernio n'a repondu.";
  for (const url of candidates) {
    try {
      const { status, body, text } = await fetchJson(url, query);
      if (status === 200 && body !== null) {
        resolved.set(key, url);
        return { ok: true, data: body as T, via: url };
      }
      if (status === 401 || status === 403) {
        // La cle est refusee : inutile d'essayer les autres chemins.
        return { ok: false, error: `Cle Zernio refusee (HTTP ${status}). Verifiez ZERNIO_API_KEY.`, status };
      }
      lastStatus = status;
      lastError = `HTTP ${status} sur ${url}${text ? ` : ${text.slice(0, 160)}` : ""}`;
    } catch (err) {
      lastError = `${url} : ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

export interface ZernioAccount {
  id: string;
  platform?: string;
  name?: string;
  username?: string;
  [k: string]: unknown;
}

/** Liste les comptes sociaux connectes dans Zernio, avec leur identifiant. */
export async function listAccounts(): Promise<ZernioResult<ZernioAccount[]>> {
  const r = await tryPaths<unknown>("accounts", ["/v1/accounts", "/accounts"]);
  if (!r.ok) return r;
  // La reponse peut etre un tableau nu, ou enveloppee dans {data|accounts|results}.
  const raw = r.data as Record<string, unknown> | unknown[];
  const arr = Array.isArray(raw)
    ? raw
    : (["data", "accounts", "results", "items"] as const).map((k) => (raw as Record<string, unknown>)[k]).find(Array.isArray);
  if (!Array.isArray(arr)) return { ok: false, error: `Reponse inattendue (pas de liste de comptes) depuis ${r.via}.` };
  return { ok: true, data: arr as ZernioAccount[], via: r.via };
}

/** Statistiques d'abonnes pour un compte (ou tous si accountId omis). */
export async function followerStats(accountId?: string, start?: string, end?: string): Promise<ZernioResult<unknown>> {
  const q: Record<string, string> = {};
  if (accountId) q.accountId = accountId;
  if (start) q.start = start;
  if (end) q.end = end;
  return tryPaths("follower-stats", ["/v1/accounts/follower-stats", "/accounts/follower-stats"], q);
}

/** Metriques quotidiennes agregees (portee, impressions, engagement). */
export async function dailyMetrics(accountId?: string, start?: string, end?: string): Promise<ZernioResult<unknown>> {
  const q: Record<string, string> = {};
  if (accountId) q.accountId = accountId;
  if (start) q.start = start;
  if (end) q.end = end;
  return tryPaths("daily-metrics", ["/v1/analytics/daily-metrics", "/analytics/daily-metrics"], q);
}

/** Analytics au niveau d'un compte, sur une periode. */
export async function accountAnalytics(accountId: string, start?: string, end?: string): Promise<ZernioResult<unknown>> {
  const q: Record<string, string> = {};
  if (start) q.start = start;
  if (end) q.end = end;
  return tryPaths(`account-analytics`, [`/v1/analytics/account/${encodeURIComponent(accountId)}`, `/analytics/account/${encodeURIComponent(accountId)}`], q);
}

/** Insights specifiques a une page Facebook. */
export async function facebookPageInsights(accountId: string, start?: string, end?: string): Promise<ZernioResult<unknown>> {
  const q: Record<string, string> = { accountId };
  if (start) q.start = start;
  if (end) q.end = end;
  return tryPaths("facebook-insights", ["/v1/analytics/facebook/page-insights", "/analytics/facebook/page-insights"], q);
}

/** Insights specifiques a un compte TikTok. */
export async function tiktokAccountInsights(accountId: string, start?: string, end?: string): Promise<ZernioResult<unknown>> {
  const q: Record<string, string> = { accountId };
  if (start) q.start = start;
  if (end) q.end = end;
  return tryPaths("tiktok-insights", ["/v1/analytics/tiktok/account-insights", "/analytics/tiktok/account-insights"], q);
}

/**
 * Diagnostic : teste chaque endpoint et renvoie ce qui marche, avec un
 * extrait de la reponse. Permet de corriger les chemins sans acces SSH.
 * N'expose jamais la cle.
 */
export async function probe(): Promise<Record<string, unknown>> {
  if (!API_KEY) return { configured: false, hint: "Ajoutez ZERNIO_API_KEY dans les variables d'environnement, puis redemarrez le service." };

  const out: Record<string, unknown> = { configured: true, bases: BASES };
  const accounts = await listAccounts();
  out.accounts = accounts.ok
    ? { ok: true, via: accounts.via, count: accounts.data.length, sample: accounts.data.slice(0, 4) }
    : { ok: false, error: accounts.error };

  const firstId = accounts.ok ? String(accounts.data[0]?.id ?? "") : "";
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);

  const checks: Array<[string, Promise<ZernioResult<unknown>>]> = [
    ["followerStats", followerStats(firstId || undefined, start, end)],
    ["dailyMetrics", dailyMetrics(firstId || undefined, start, end)],
  ];
  if (firstId) {
    checks.push(["accountAnalytics", accountAnalytics(firstId, start, end)]);
    const platform = String((accounts.ok && accounts.data[0]?.platform) || "").toLowerCase();
    if (platform.includes("facebook")) checks.push(["facebookPageInsights", facebookPageInsights(firstId, start, end)]);
    if (platform.includes("tiktok")) checks.push(["tiktokAccountInsights", tiktokAccountInsights(firstId, start, end)]);
  }

  for (const [name, p] of checks) {
    const r = await p;
    out[name] = r.ok ? { ok: true, via: r.via, sample: JSON.stringify(r.data).slice(0, 700) } : { ok: false, error: r.error };
  }
  return out;
}
