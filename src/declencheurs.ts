/**
 * Mots-cles : un commentaire (ou un message) qui contient un mot declenche une reponse.
 *
 *  - Facebook : automatisation « commentaire vers message prive » chez Zernio (message prive + reponse publique).
 *  - TikTok   : reponse publique sous le commentaire (TikTok n'a pas de messages prives pour les pages).
 *  - WhatsApp : reponse automatique quand quelqu'un ecrit le mot au numero Delivrou (gere ici, avec garde-fous).
 *
 * Le moteur Facebook/TikTok tourne chez Zernio, meme quand ce serveur est eteint. Ici on garde les regles,
 * on les envoie a Zernio, et on relit les chiffres.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { zernioRequest, listAccounts, isZernioConfigured, type ZernioAccount } from "./zernio.js";
import { addSendLogEntry } from "./store.js";
import { verifierRegles } from "./studio.js";
import { lister } from "./zernio-publish.js";
import { askGeminiJson, isGeminiConfigured } from "./gemini.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FICHIER = path.join(AUTH_DIR, "qg", "declencheurs.json");
const MAX_WA_PAR_HEURE = Number(process.env.DECLENCHEURS_WA_PAR_HEURE || 30);
const JOUR = 24 * 3600_000;

type Reseau = "facebook" | "tiktok" | "whatsapp";
type Mode = "mot" | "contient" | "exact";
interface Bouton { titre: string; url: string }
interface PostLie { qgId: string; titre: string; ids: { facebook?: string; tiktok?: string } }
interface Declencheur {
  id: string;
  nom: string;
  motsCles: string[];
  mode: Mode;
  messagePrive: string;
  reponsePublique: string;
  boutons: Bouton[];
  reseaux: Record<Reseau, boolean>;
  actif: boolean;
  cree: string;
  post: PostLie | null;
  zernio: { facebook?: string; tiktok?: string };
  wa: { declenches: number; dernier: number | null };
}
interface EntreeWa { t: number; declencheur: string; contact: string; statut: "envoye" | "echec"; erreur?: string }
interface Etat {
  items: Declencheur[];
  contacts: Record<string, number>;
  heures: number[];
  journalWa: EntreeWa[];
}

let etat: Etat = { items: [], contacts: {}, heures: [], journalWa: [] };
let charge = false;
function charger() {
  if (charge) return;
  charge = true;
  try {
    const j = JSON.parse(fs.readFileSync(FICHIER, "utf8")) as Partial<Etat>;
    etat = { items: j.items ?? [], contacts: j.contacts ?? {}, heures: j.heures ?? [], journalWa: j.journalWa ?? [] };
  } catch { /* premier demarrage */ }
}
function sauver() {
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const maintenant = Date.now();
    for (const k of Object.keys(etat.contacts)) if (maintenant - etat.contacts[k] > JOUR) delete etat.contacts[k];
    etat.journalWa = etat.journalWa.slice(-80);
    const tmp = FICHIER + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(etat));
    fs.renameSync(tmp, FICHIER);
  } catch (e) { console.error("[declencheurs] ecriture impossible:", e instanceof Error ? e.message : e); }
}

const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function correspond(d: Pick<Declencheur, "motsCles" | "mode">, texte: string): boolean {
  const txt = norm(texte);
  if (!txt) return false;
  return d.motsCles.map(norm).filter(Boolean).some((k) => (d.mode === "exact" ? txt === k : d.mode === "contient" ? txt.includes(k) : ` ${txt} `.includes(` ${k} `)));
}

// ---------- Zernio ----------
interface CompteZ { id: string; profileId: string; username: string }
function profilDe(a: ZernioAccount): string {
  const p = (a as Record<string, unknown>).profileId;
  if (typeof p === "string") return p;
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; return String(o._id ?? o.id ?? ""); }
  return "";
}
async function comptes(): Promise<{ ok: true; facebook?: CompteZ; tiktok?: CompteZ } | { ok: false; erreur: string }> {
  if (!isZernioConfigured()) return { ok: false, erreur: "Zernio n'est pas relié au serveur (ZERNIO_API_KEY)." };
  const r = await listAccounts();
  if (!r.ok) return { ok: false, erreur: r.error };
  const un = async (plateforme: string): Promise<CompteZ | undefined> => {
    const a = r.data.find((x) => String(x.platform ?? "").toLowerCase() === plateforme && x.isActive !== false);
    if (!a) return undefined;
    let profileId = profilDe(a);
    if (!profileId) {
      const p = await zernioRequest<{ profiles?: Array<{ _id?: string; id?: string }> }>("GET", "/v1/profiles");
      const first = p.ok ? p.data?.profiles?.[0] : undefined;
      profileId = String(first?._id ?? first?.id ?? "");
    }
    return { id: a.id, profileId, username: String(a.username ?? a.name ?? "") };
  };
  return { ok: true, facebook: await un("facebook"), tiktok: await un("tiktok") };
}

function corpsZernio(d: Declencheur, reseau: "facebook" | "tiktok", c: CompteZ, creation: boolean): Record<string, unknown> {
  const mode = d.mode === "mot" ? "word" : d.mode;
  const corps: Record<string, unknown> = {
    name: `QG · ${d.nom} · ${reseau === "facebook" ? "Facebook" : "TikTok"}`,
    keywords: d.motsCles,
    matchMode: mode,
    repeatPolicy: { mode: "once" },
    isActive: d.actif,
  };
  if (creation) { corps.profileId = c.profileId; corps.accountId = c.id; corps.trigger = "comment"; }
  if (d.post?.ids[reseau]) corps.postId = d.post.ids[reseau];
  if (reseau === "facebook") {
    corps.dmMessage = d.messagePrive;
    corps.buttons = d.boutons.map((b) => ({ type: "url", title: b.titre, url: b.url }));
    if (d.reponsePublique) { corps.commentReply = d.reponsePublique; corps.publicReplyPolicy = "after_dm"; }
  } else {
    corps.commentReply = d.reponsePublique;
  }
  return corps;
}

async function synchroniser(d: Declencheur): Promise<string[]> {
  const erreurs: string[] = [];
  const voulus = (["facebook", "tiktok"] as const).filter((r) => d.reseaux[r]);
  const c = await comptes();
  for (const r of ["facebook", "tiktok"] as const) {
    const existant = d.zernio[r];
    if (!d.reseaux[r]) {
      if (existant) {
        const x = await zernioRequest("DELETE", `/v1/comment-automations/${encodeURIComponent(existant)}`);
        if (x.ok || x.status === 404) delete d.zernio[r]; else erreurs.push(`${r} : ${x.error}`);
      }
      continue;
    }
    if (!voulus.includes(r)) continue;
    if (!c.ok) { erreurs.push(c.erreur); break; }
    const compte = c[r];
    if (!compte) { erreurs.push(`Aucun compte ${r === "facebook" ? "Facebook" : "TikTok"} relié à Zernio.`); continue; }
    if (!compte.profileId) { erreurs.push("Profil Zernio introuvable."); continue; }
    if (existant) {
      const x = await zernioRequest<{ automation?: { id?: string } }>("PATCH", `/v1/comment-automations/${encodeURIComponent(existant)}`, corpsZernio(d, r, compte, false));
      if (!x.ok) erreurs.push(`${r === "facebook" ? "Facebook" : "TikTok"} : ${x.error}`);
    } else {
      const x = await zernioRequest<{ automation?: { id?: string }; id?: string }>("POST", "/v1/comment-automations", corpsZernio(d, r, compte, true));
      if (!x.ok) erreurs.push(`${r === "facebook" ? "Facebook" : "TikTok"} : ${x.error}`);
      else { const id = x.data?.automation?.id ?? x.data?.id; if (id) d.zernio[r] = String(id); }
    }
  }
  return erreurs;
}

// ---------- validation ----------
const t = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
function valider(b: unknown, existant?: Declencheur): { ok: true; d: Declencheur } | { ok: false; erreur: string } {
  const o = (b ?? {}) as Record<string, unknown>;
  const nom = t(o.nom, 40);
  const motsCles = (Array.isArray(o.motsCles) ? o.motsCles : String(o.motsCles ?? "").split(/[,\n]/)).map((x) => t(x, 30)).filter(Boolean).slice(0, 8);
  const mode: Mode = o.mode === "exact" || o.mode === "contient" ? o.mode : "mot";
  const messagePrive = t(o.messagePrive, 900);
  const reponsePublique = t(o.reponsePublique, 280);
  const boutons = (Array.isArray(o.boutons) ? o.boutons : []).slice(0, 3)
    .map((x) => ({ titre: t((x as Record<string, unknown>)?.titre, 20), url: t((x as Record<string, unknown>)?.url, 400) }))
    .filter((x) => x.titre && /^https?:\/\//i.test(x.url));
  const r = (o.reseaux ?? {}) as Record<string, unknown>;
  const reseaux: Record<Reseau, boolean> = { facebook: Boolean(r.facebook), tiktok: Boolean(r.tiktok), whatsapp: Boolean(r.whatsapp) };
  if (!nom) return { ok: false, erreur: "Donne un nom à ce mot-clé." };
  if (!motsCles.length) return { ok: false, erreur: "Écris au moins un mot déclencheur." };
  if (!reseaux.facebook && !reseaux.tiktok && !reseaux.whatsapp) return { ok: false, erreur: "Choisis au moins un réseau." };
  if ((reseaux.facebook || reseaux.whatsapp) && !messagePrive) return { ok: false, erreur: "Écris le message privé qui sera envoyé." };
  if (reseaux.tiktok && !reponsePublique) return { ok: false, erreur: "TikTok n'a pas de messages privés : écris la réponse publique sous le commentaire." };
  if (reseaux.facebook && boutons.length && messagePrive.length > 640) return { ok: false, erreur: "Avec des boutons, le message privé fait 640 caractères au maximum." };
  const alertes = verifierRegles(messagePrive, reponsePublique);
  if (alertes.length) return { ok: false, erreur: alertes[0] };
  const post = ((): PostLie | null => {
    const p = (o.post ?? null) as Record<string, unknown> | null;
    if (!p || !p.qgId) return existant?.post && o.post === undefined ? existant.post : null;
    const ids = (p.ids ?? {}) as Record<string, unknown>;
    return { qgId: t(p.qgId, 80), titre: t(p.titre, 90), ids: { facebook: ids.facebook ? t(ids.facebook, 40) : undefined, tiktok: ids.tiktok ? t(ids.tiktok, 40) : undefined } };
  })();
  const d: Declencheur = {
    id: existant?.id ?? crypto.randomBytes(6).toString("hex"),
    nom, motsCles, mode, messagePrive, reponsePublique, boutons, reseaux, post,
    actif: o.actif === undefined ? existant?.actif ?? true : Boolean(o.actif),
    cree: existant?.cree ?? new Date().toISOString(),
    zernio: existant?.zernio ?? {},
    wa: existant?.wa ?? { declenches: 0, dernier: null },
  };
  return { ok: true, d };
}

// ---------- WhatsApp ----------
const dormir = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** Appelé pour chaque message reçu : répond une fois par personne et par mot-clé toutes les 24 h. */
export async function traiterMessageWhatsapp(jid: string, texte: string, nom: string | undefined, envoyer: (jid: string, texte: string) => Promise<void>): Promise<void> {
  if (jid.endsWith("@g.us") || jid === "status@broadcast" || texte.startsWith("[message non-texte]")) return;
  charger();
  const d = etat.items.find((x) => x.actif && x.reseaux.whatsapp && !x.post && correspond(x, texte));
  if (!d) return;
  const maintenant = Date.now();
  const cle = `${jid}|${d.id}`;
  if (maintenant - (etat.contacts[cle] ?? 0) < JOUR) return;
  etat.heures = etat.heures.filter((h) => maintenant - h < 3600_000);
  if (etat.heures.length >= MAX_WA_PAR_HEURE) return;
  etat.contacts[cle] = maintenant;
  etat.heures.push(maintenant);
  const prenom = (nom || "").trim().split(/\s+/)[0] || "";
  let msg = d.messagePrive.replace(/\{\{\s*first_name\s*\}\}/gi, prenom || "toi");
  if (d.boutons.length) msg += "\n\n" + d.boutons.map((b) => `${b.titre} : ${b.url}`).join("\n");
  const contact = "…" + jid.split("@")[0].slice(-4);
  await dormir(2000 + Math.floor(Math.random() * 3000));
  try {
    await envoyer(jid, msg);
    d.wa.declenches += 1; d.wa.dernier = maintenant;
    etat.journalWa.push({ t: maintenant, declencheur: d.nom, contact, statut: "envoye" });
    addSendLogEntry({ phone: jid.split("@")[0], text: `[mot-clé ${d.nom}] ${msg}`, source: "auto", status: "sent" });
  } catch (e) {
    const erreur = e instanceof Error ? e.message : String(e);
    etat.journalWa.push({ t: maintenant, declencheur: d.nom, contact, statut: "echec", erreur });
    addSendLogEntry({ phone: jid.split("@")[0], text: `[mot-clé ${d.nom}] ${msg}`, source: "auto", status: "failed", error: erreur });
  }
  sauver();
}

// ---------- API du QG ----------
export const declencheursRouter = express.Router();

interface StatsZ { triggered?: number; dmsSent?: number; dmsFailed?: number; linkClicks?: number; uniqueContacts?: number }
async function statsZernio(): Promise<Map<string, StatsZ & { isActive?: boolean }>> {
  const m = new Map<string, StatsZ & { isActive?: boolean }>();
  if (!isZernioConfigured()) return m;
  const r = await zernioRequest<{ automations?: Array<{ id?: string; isActive?: boolean; stats?: StatsZ }> }>("GET", "/v1/comment-automations");
  if (r.ok) for (const a of r.data?.automations ?? []) if (a.id) m.set(a.id, { ...(a.stats ?? {}), isActive: a.isActive });
  return m;
}

declencheursRouter.get("/", async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  charger();
  const [c, st] = await Promise.all([comptes(), statsZernio()]);
  const items = etat.items.map((d) => {
    const zs = (["facebook", "tiktok"] as const).map((r) => (d.zernio[r] ? st.get(d.zernio[r]!) : undefined));
    const somme = (k: keyof StatsZ) => zs.reduce((a, s) => a + (Number(s?.[k]) || 0), 0);
    return {
      ...d,
      stats: {
        declenches: somme("triggered") + d.wa.declenches,
        messages: somme("dmsSent") + d.wa.declenches,
        echecs: somme("dmsFailed"),
        clics: somme("linkClicks"),
        personnes: somme("uniqueContacts"),
      },
    };
  });
  res.json({
    ok: true,
    zernio: c.ok ? { ok: true, facebook: c.facebook ? { username: c.facebook.username } : null, tiktok: c.tiktok ? { username: c.tiktok.username } : null } : { ok: false, erreur: c.erreur },
    items,
  });
});

declencheursRouter.post("/", async (req: Request, res: Response) => {
  charger();
  const v = valider(req.body);
  if (!v.ok) { res.status(400).json({ ok: false, erreur: v.erreur }); return; }
  if (etat.items.length >= 40) { res.status(400).json({ ok: false, erreur: "Déjà 40 mots-clés : supprime ceux qui ne servent plus." }); return; }
  const avertissements = await synchroniser(v.d);
  etat.items.push(v.d);
  sauver();
  res.json({ ok: true, id: v.d.id, avertissements });
});

declencheursRouter.put("/:id", async (req: Request, res: Response) => {
  charger();
  const i = etat.items.findIndex((x) => x.id === req.params.id);
  if (i < 0) { res.status(404).json({ ok: false, erreur: "Mot-clé inconnu" }); return; }
  const v = valider(req.body, etat.items[i]);
  if (!v.ok) { res.status(400).json({ ok: false, erreur: v.erreur }); return; }
  const avertissements = await synchroniser(v.d);
  etat.items[i] = v.d;
  sauver();
  res.json({ ok: true, avertissements });
});

declencheursRouter.post("/:id/actif", async (req: Request, res: Response) => {
  charger();
  const d = etat.items.find((x) => x.id === req.params.id);
  if (!d) { res.status(404).json({ ok: false, erreur: "Mot-clé inconnu" }); return; }
  d.actif = Boolean((req.body as Record<string, unknown>)?.actif);
  const avertissements: string[] = [];
  for (const r of ["facebook", "tiktok"] as const) {
    const id = d.zernio[r];
    if (!id) continue;
    const x = await zernioRequest("PATCH", `/v1/comment-automations/${encodeURIComponent(id)}`, { isActive: d.actif });
    if (!x.ok) avertissements.push(`${r} : ${x.error}`);
  }
  sauver();
  res.json({ ok: true, actif: d.actif, avertissements });
});

declencheursRouter.post("/:id/supprimer", async (req: Request, res: Response) => {
  charger();
  const i = etat.items.findIndex((x) => x.id === req.params.id);
  if (i < 0) { res.json({ ok: true }); return; }
  const d = etat.items[i];
  const avertissements: string[] = [];
  for (const r of ["facebook", "tiktok"] as const) {
    const id = d.zernio[r];
    if (!id) continue;
    const x = await zernioRequest("DELETE", `/v1/comment-automations/${encodeURIComponent(id)}`);
    if (!x.ok && x.status !== 404) avertissements.push(`${r} : ${x.error}`);
  }
  etat.items.splice(i, 1);
  sauver();
  res.json({ ok: true, avertissements });
});

// ───────────── Idées écrites par Gemini (toujours validées par l'équipe avant d'être utilisées) ─────────────
const FICHIER_IA = path.join(AUTH_DIR, "qg", "declencheurs-ia.json");
const REGLES_IA = "RÈGLES STRICTES : tutoiement, français simple de Conakry. Le seul service est le COLIS (jamais repas, pharmacie, épicerie). Aucun prix ni délai chiffré, aucune promesse de rapidité (jamais « vite », « rapide », « express »), aucun chiffre inventé, aucun faux avis ni témoignage, pas de paiement en espèces, rien de religieux, ethnique ou politique. N'utilise que des faits donnés plus haut sur Delivrou. Une accroche ne commence jamais par « Salut », « Bonjour », « Découvrez ».";
interface IdeesIA { date: string; idees: Array<Record<string, string>>; quiz: Array<{ q: string; a: string[]; bonne: string; expl: string }>; accroches: string[]; fins: string[] }
let genEnCours = false;
const appelsIA: number[] = [];
const quotaIA = () => {
  const m = Date.now();
  while (appelsIA.length && m - appelsIA[0] > 3600_000) appelsIA.shift();
  if (appelsIA.length >= 30) return false;
  appelsIA.push(m);
  return true;
};
const texteSur = (v: unknown, n: number) => { const s = t(v, n); return s && !verifierRegles(s).length ? s : ""; };
const listeSure = (v: unknown, n: number, max: number) => [...new Set((Array.isArray(v) ? v : []).map((x) => texteSur(x, n)).filter(Boolean))].slice(0, max);
const json = (texte: string): Record<string, unknown> | null => {
  const a = texte.indexOf("{"), z = texte.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(texte.slice(a, z + 1)) as Record<string, unknown>; } catch { return null; }
};
const lireIA = (): IdeesIA | null => { try { return JSON.parse(fs.readFileSync(FICHIER_IA, "utf8")) as IdeesIA; } catch { return null; } };

async function genererIdees(): Promise<IdeesIA | null> {
  charger();
  const avant = lireIA();
  const dejaVus = [...etat.items.map((d) => d.nom), ...(avant?.idees ?? []).map((x) => x.nom), ...(avant?.quiz ?? []).map((x) => x.q), ...(avant?.accroches ?? [])].join(" | ");
  const r = await askGeminiJson([
    "Tu aides l'équipe marketing de Delivrou à faire réagir les gens sur Facebook et TikTok. Un commentaire qui contient un mot-clé déclenche un message privé.",
    REGLES_IA,
    "Propose du NEUF, drôle ou intrigant, qui donne envie de commenter. Évite ce qui existe déjà : " + (dejaVus || "rien pour l'instant") + ".",
    'Réponds UNIQUEMENT en JSON : {"idees":[6 objets {"nom":"UN MOT EN MAJUSCULES","mots":"2 ou 3 mots déclencheurs séparés par des virgules","prive":"message privé commençant par Salut {{first_name}} !","pub":"réponse publique courte avec un emoji","bt":"texte du bouton, 3 mots maximum"}],"quiz":[4 objets {"q":"question amusante sur l\'envoi de colis, dont la réponse est dans les faits donnés","a":["réponse A","réponse B","réponse C"],"bonne":"A, B ou C","expl":"explication d\'une phrase"}],"accroches":[8 débuts de vidéo ou de légende, 12 mots maximum, qui arrêtent le pouce],"fins":[6 phrases de fin qui font réagir, dont certaines demandent de commenter un mot]}',
  ].join("\n\n"));
  const o = r.ok && r.text ? json(r.text) : null;
  if (!o) return null;
  const idees = (Array.isArray(o.idees) ? (o.idees as Array<Record<string, unknown>>) : []).map((x) => ({
    nom: t(x.nom, 24).toUpperCase().replace(/[^A-Z0-9À-Ý ]/g, "").trim(), mots: texteSur(x.mots, 80), prive: texteSur(x.prive, 600), pub: texteSur(x.pub, 200), bouton: "site", bt: texteSur(x.bt, 24) || "Ouvrir Delivrou",
  })).filter((x) => x.nom && x.mots && x.prive && x.pub && !verifierRegles(x.nom).length);
  const quiz = (Array.isArray(o.quiz) ? (o.quiz as Array<Record<string, unknown>>) : []).map((x) => ({
    q: texteSur(x.q, 200), a: (Array.isArray(x.a) ? x.a : []).map((y) => texteSur(y, 80)), bonne: String(x.bonne ?? "").trim().toUpperCase().slice(0, 1), expl: texteSur(x.expl, 240),
  })).filter((x) => x.q && x.expl && x.a.length === 3 && x.a.every(Boolean) && ["A", "B", "C"].includes(x.bonne));
  const accroches = listeSure(o.accroches, 110, 8), fins = listeSure(o.fins, 130, 6);
  if (!idees.length && !quiz.length && !accroches.length) return null;
  const sortie: IdeesIA = { date: new Date().toISOString(), idees, quiz, accroches, fins };
  fs.mkdirSync(path.dirname(FICHIER_IA), { recursive: true });
  fs.writeFileSync(FICHIER_IA, JSON.stringify(sortie, null, 2));
  return sortie;
}
const lancerGeneration = () => {
  if (genEnCours || !isGeminiConfigured() || !quotaIA()) return false;
  genEnCours = true;
  genererIdees().catch((e) => console.error("[declencheurs] idees IA :", e)).finally(() => { genEnCours = false; });
  return true;
};

/** Les dernières idées. Si elles ont plus d'un jour, de nouvelles sont écrites en arrière-plan. */
declencheursRouter.get("/ia", (_req: Request, res: Response) => {
  const c = lireIA();
  if (!c || Date.now() - new Date(c.date).getTime() > JOUR) lancerGeneration();
  res.json({ ok: true, ia: isGeminiConfigured(), enCours: genEnCours, ...(c ?? { idees: [], quiz: [], accroches: [], fins: [] }) });
});
/** « Générer avec l'IA » : de nouvelles idées tout de suite. */
declencheursRouter.post("/ia", (_req: Request, res: Response) => {
  if (!isGeminiConfigured()) { res.status(503).json({ ok: false, erreur: "L'IA n'est pas configurée sur le serveur (GEMINI_API_KEY)." }); return; }
  if (!genEnCours && !lancerGeneration()) { res.status(429).json({ ok: false, erreur: "Trop de demandes cette heure. Réessaie plus tard." }); return; }
  res.json({ ok: true, enCours: true });
});
/** À chaque programmation : accroches, fins et mot-clé pensés pour cette publication. */
declencheursRouter.post("/ia/publication", async (req: Request, res: Response) => {
  if (!isGeminiConfigured()) { res.status(503).json({ ok: false, erreur: "IA non configurée." }); return; }
  if (!quotaIA()) { res.status(429).json({ ok: false, erreur: "Trop de demandes cette heure." }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const r = await askGeminiJson([
    "Pour cette publication Delivrou, propose de quoi faire réagir.",
    "Titre : " + t(b.titre, 120) + "\nTexte : " + t(b.texte, 900),
    REGLES_IA,
    'Réponds UNIQUEMENT en JSON : {"accroches":[3 débuts de légende, 12 mots maximum],"fins":[3 phrases de fin qui font commenter],"motCle":"un mot en majuscules à faire commenter"}',
  ].join("\n\n"));
  const o = r.ok && r.text ? json(r.text) : null;
  if (!o) { res.status(502).json({ ok: false, erreur: "Pas de réponse de l'IA." }); return; }
  res.json({ ok: true, accroches: listeSure(o.accroches, 110, 3), fins: listeSure(o.fins, 130, 3), motCle: t(o.motCle, 24).toUpperCase().replace(/[^A-Z0-9À-Ý ]/g, "").trim() });
});

/** Simule un commentaire : quel mot-clé se déclencherait, et qu'est-ce qui serait envoyé ? */
declencheursRouter.post("/tester", (req: Request, res: Response) => {
  charger();
  const texte = t((req.body as Record<string, unknown>)?.texte, 300);
  const d = etat.items.find((x) => x.actif && correspond(x, texte));
  res.json({ ok: true, trouve: d ? { id: d.id, nom: d.nom, messagePrive: d.messagePrive, reponsePublique: d.reponsePublique, reseaux: d.reseaux, boutons: d.boutons } : null });
});

/** Publications programmées (pour limiter un mot-clé à une seule publication, par exemple un quiz). */
declencheursRouter.get("/publications", async (_req: Request, res: Response) => {
  const l = await lister();
  if (!l.ok) { res.status(502).json({ ok: false, erreur: l.erreur }); return; }
  const par = new Map<string, PostLie & { quand: string | null }>();
  for (const p of l.posts) {
    if (p.statutPost === "published" || !p.id || !p.qgId) continue;
    const e = par.get(p.qgId) ?? { qgId: p.qgId, titre: (p.texte || "Publication").split("\n")[0].slice(0, 80), ids: {}, quand: p.quand };
    if (p.reseau === "fb") e.ids.facebook = p.id;
    if (p.reseau === "tt") e.ids.tiktok = p.id;
    par.set(p.qgId, e);
  }
  res.json({ ok: true, publications: [...par.values()].sort((a, b) => String(a.quand).localeCompare(String(b.quand))) });
});

/** Derniers déclenchements : ce que Zernio a traité + ce que WhatsApp a répondu. */
declencheursRouter.get("/journal", async (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  charger();
  const entrees: Array<{ t: number; reseau: string; declencheur: string; qui: string; texte: string; statut: string; erreur?: string }> = [];
  for (const d of etat.items) {
    for (const r of ["facebook", "tiktok"] as const) {
      const id = d.zernio[r];
      if (!id) continue;
      const x = await zernioRequest<{ logs?: Array<Record<string, unknown>> }>("GET", `/v1/comment-automations/${encodeURIComponent(id)}/logs?limit=10`);
      if (!x.ok) continue;
      for (const l of x.data?.logs ?? []) {
        entrees.push({ t: Date.parse(String(l.createdAt ?? "")) || 0, reseau: r, declencheur: d.nom, qui: String(l.commenterName ?? l.commenterUsername ?? "Quelqu'un"), texte: String(l.commentText ?? ""), statut: String(l.status ?? ""), erreur: l.error ? String(l.error) : undefined });
      }
    }
  }
  for (const w of etat.journalWa) entrees.push({ t: w.t, reseau: "whatsapp", declencheur: w.declencheur, qui: w.contact, texte: "", statut: w.statut === "envoye" ? "sent" : "failed", erreur: w.erreur });
  entrees.sort((a, b) => b.t - a.t);
  res.json({ ok: true, entrees: entrees.slice(0, 40) });
});
