/**
 * Studio du QG : creation d'affiches, de photos et de videos avec l'API Higgsfield,
 * directement depuis l'onglet « Studio » du QG.
 *
 * La cle Higgsfield (HF_CREDENTIALS, saisie par Ibrahima dans EasyPanel) ne quitte
 * jamais le serveur. Monte sous /qg/api/studio : deja derriere le mot de passe du
 * tableau de bord. Les depenses sont bornees (budget par semaine, marge de securite,
 * plafond de demandes par heure, interrupteur STUDIO_DISABLED=true).
 *
 * Donnees dans le volume persistant : <qg>/studio/{journal.json, planning.json, creations/}.
 * Les creations approuvees entrent dans le calendrier du QG (planning.json), sans
 * jamais toucher aux donnees deposees depuis le poste (semaines.json).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { askGeminiEmail, isGeminiConfigured } from "./gemini.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const STUDIO_DIR = path.join(AUTH_DIR, "qg", "studio");
const CREATIONS = path.join(STUDIO_DIR, "creations");
const JOURNAL = path.join(STUDIO_DIR, "journal.json");
const PLANNING = path.join(STUDIO_DIR, "planning.json");
const MODELES_FILE = path.join(STUDIO_DIR, "modeles.json");
const API = "https://api.higgsfield.ai";
const MARGE = 1.25; // securite sur les prix estimes : le budget est verifie avec cette marge

// ---------- types ----------
type Genre = "photo" | "affiche";
type Kind = "image" | "video";
interface Modele {
  id: string;
  nom: string;
  type: Kind;
  genres?: Genre[];
  prix: number | null;
  qualite: number;
  pour: string;
  min?: number;
  max?: number;
  durees?: number[];
  params?: Record<string, string | number | boolean>;
  formats?: Record<string, string>;
  verifie: boolean;
  note?: string;
}
interface Catalogue {
  plafonds: { image: number; video: number; affiche: number };
  modeles: Modele[];
}
interface Legendes {
  pilier: string;
  facebook: string;
  tiktok: string;
  hashtags: string[];
  motsCles: string[];
}
interface Entree {
  id: string;
  date: string;
  semaine: string;
  idee: string;
  structure: string;
  genre: Genre;
  titre: string;
  sous: string;
  type: Kind;
  format: string;
  modele: string;
  prompt: string;
  cout: number;
  mode: "reel";
  statut: "en_cours" | "pret" | "echec";
  fichier: string | null;
  note: "aime" | "pas" | null;
  erreur?: string;
  pilier?: string;
  final?: boolean;
  gabarit?: string;
  original?: string;
  pastille?: string;
  ecran?: string;
  legendes?: Legendes;
}
interface PostPlanifie {
  id: string;
  semaine: string;
  jour: number;
  heure: string;
  pilier: string;
  titre: string;
  facebook: string;
  tiktok: string;
  fichier: string;
  type: Kind;
  format: string;
}

// ---------- configuration ----------
function hfKey(): string | null {
  const raw = (process.env.HF_CREDENTIALS || process.env.HF_KEY || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 2) return null;
  return parts.slice(-2).join(":"); // une cle copiee avec un prefixe : seuls les deux derniers morceaux comptent
}
const disabled = () => process.env.STUDIO_DISABLED === "true";
const budget = () => {
  const n = Number(process.env.STUDIO_BUDGET_SEMAINE || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
};

const MODELES_PAR_DEFAUT: Catalogue = {
  plafonds: { image: 0.02, video: 0.12, affiche: 0.08 },
  modeles: [
    { id: "ideogram/v4.0", nom: "Ideogram 4.0", type: "image", genres: ["affiche"], prix: 0.03, qualite: 5, pour: "Affiches completes : le meilleur pour ecrire un titre lisible, avec les accents, dans une vraie mise en page.", params: { rendering_speed: "QUALITY" }, verifie: true },
    { id: "recraft/v4.1/text-to-image", nom: "Recraft 4.1", type: "image", genres: ["affiche"], prix: 0.035, qualite: 4, pour: "Affiches tres graphiques, formes nettes et couleurs maitrisees.", params: { output_format: "png" }, verifie: true },
    { id: "higgsfield-ai/soul/v2/standard", nom: "Soul v2", type: "image", genres: ["photo"], prix: 0.0032, qualite: 4, pour: "Photos realistes de personnes, sans texte : fonds pour monter nous-memes.", params: { resolution: "1080p" }, formats: { "4:5": "3:4", "9:16": "9:16", "1:1": "1:1" }, verifie: true },
    { id: "bytedance/seedance-2.5/text-to-video", nom: "Seedance 2.5", type: "video", prix: 0.144, qualite: 5, pour: "Videos realistes et fluides : le meilleur rendu, mais plus cher que le plafond, donc jamais choisi tout seul.", min: 4, max: 30, params: { resolution: "720p", generate_audio: false }, formats: { "9:16": "9:16", "4:5": "3:4", "1:1": "1:1" }, verifie: true },
    { id: "kling-video/v2.5-turbo/pro/text-to-video", nom: "Kling 2.5 Turbo Pro", type: "video", prix: 0.042, qualite: 4, pour: "Bon mouvement, bon prix : ideal pour tester une idee.", durees: [5, 10], formats: { "9:16": "9:16", "4:5": "3:4", "1:1": "1:1" }, verifie: true },
  ],
};

/** Le catalogue peut etre remplace sans redeploiement : <qg>/studio/modeles.json. */
function catalogue(): Catalogue {
  try {
    if (fs.existsSync(MODELES_FILE)) {
      const j = JSON.parse(fs.readFileSync(MODELES_FILE, "utf8")) as Partial<Catalogue>;
      if (Array.isArray(j.modeles) && j.modeles.length) return { plafonds: j.plafonds ?? MODELES_PAR_DEFAUT.plafonds, modeles: j.modeles };
    }
  } catch {
    /* on retombe sur le catalogue integre */
  }
  return MODELES_PAR_DEFAUT;
}

// ---------- fichiers ----------
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
const journal = () => readJson<Entree[]>(JOURNAL, []);
const planning = () => readJson<PostPlanifie[]>(PLANNING, []);

/** Une seule ecriture a la fois : le journal est relu puis reecrit entierement. */
let verrou: Promise<unknown> = Promise.resolve();
function modifierJournal<T>(fn: (j: Entree[]) => T): Promise<T> {
  const run = verrou.then(() => {
    const j = journal();
    const out = fn(j);
    writeJson(JOURNAL, j);
    return out;
  });
  verrou = run.catch(() => undefined);
  return run;
}

// ---------- semaine et depenses ----------
function lundiDe(d = new Date()): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const depense = (j: Entree[], semaine: string) => j.filter((e) => e.semaine === semaine && e.statut !== "echec").reduce((s, e) => s + (e.cout || 0), 0);

// ---------- regles de marque (marque/regles.md) ----------
const INTERDITS: Array<[RegExp, string]> = [
  [/\b(repas|pharmacie|[ée]picerie|burger|plat)\b/i, "Seul le colis est disponible : on ne montre ni repas, ni pharmacie, ni épicerie."],
  [/\b(cash|esp[èe]ces|liquide)\b/i, "On ne parle pas du paiement en espèces."],
  [/\b(tirage|concours|loterie|jeu d'argent|gagne\s?z?)\b/i, "Aucun tirage au sort ni concours."],
  [/\b(derni[èe]re chance|plus que \d+|urgent)\b/i, "Aucune fausse urgence."],
  [/\b\d+\s?(min|minutes)\b/i, "Aucun délai chiffré promis (« livré en 8 min »…)."],
  [/\b(13 communes|\d+\s?(clients|livraisons))\b/i, "Aucun chiffre inventé (clients, livraisons, couverture)."],
  [/\b(hadith|allah|bismillah|alcool|porc|tabac|cigarette|casino)\b/i, "Rien de religieux, ni alcool, porc, tabac ou jeux d'argent."],
  [/\b(t[ée]moignage|avis client)\b/i, "Pas de faux avis ni de faux témoignage."],
  [/\b(vite|rapide(ment)?|express|instantan[ée]?(ment)?|en un [ée]clair|imm[ée]diat(ement)?)\b/i, "Aucune promesse de rapidité : on ne dit pas « vite », « rapide » ni « express »."],
];
const verifierRegles = (...textes: string[]) => {
  const t = textes.join(" ");
  return INTERDITS.filter(([re]) => re.test(t)).map(([, msg]) => msg);
};

// ---------- legendes, hashtags, mots-cles (memes phrases que outils/legendes.mjs) ----------
const PILIERS = ["Comment ça marche", "Confiance", "Vie de Conakry", "Astuces", "Appel à l'action"];
const CORPS: Record<string, string[]> = {
  "Comment ça marche": [
    "Départ, destinataire, colis, paiement : 4 étapes et un livreur vérifié vient chercher ton colis.",
    "Pas d'adresse postale ? Un point de repère suffit, et « Me localiser » fait le reste.",
    "Tu ajoutes une photo du colis : c'est ta preuve en cas de dommage.",
    "Tu paies avec Orange Money ou MTN MoMo, directement dans l'app.",
  ],
  Confiance: [
    "Nos coursiers sont vérifiés, avec une photo d'identité.",
    "Un code PIN au retrait et un code de livraison à la remise : ton colis arrive dans les bonnes mains.",
    "Tu suis ton colis en direct sur la carte.",
    "Le prix s'affiche avant que tu valides : fixe et connu d'avance.",
  ],
  "Vie de Conakry": [
    "Pas d'adresse précise ? À Conakry, un point de repère suffit.",
    "Un colis pour la famille, un cadeau, une commande en ligne : on s'en occupe, 7j/7.",
    "Les embouteillages, on connaît. Toi, tu restes tranquille, le livreur s'occupe du reste.",
  ],
  Astuces: [
    "Emballe bien ton colis et décris-le clairement : c'est déjà bien le livrer.",
    "Ajoute un point de repère facile à trouver pour ton destinataire.",
    "Prends une bonne photo du colis avant l'envoi : elle te protège.",
  ],
  "Appel à l'action": [
    "L'app Delivrou est disponible sur l'App Store. Sur Android, passe par www.delivrou.com.",
    "Parraine un ami : 50 Deli-points = 5 000 GNF.",
    "Commande en 4 étapes, paie en mobile money, suis ton colis en direct.",
  ],
};
const MOTS_CLES: Record<string, string[]> = {
  base: ["livraison de colis Conakry", "envoyer un colis Conakry", "Delivrou", "app de livraison Guinée"],
  "Comment ça marche": ["tuto livraison", "commander un colis", "me localiser"],
  Confiance: ["coursier vérifié", "suivi en direct", "colis sécurisé", "code de livraison"],
  "Vie de Conakry": ["Conakry", "vie à Conakry", "envoyer à la famille"],
  Astuces: ["bien emballer un colis", "astuce colis", "photo du colis"],
  "Appel à l'action": ["télécharger l'app", "parrainage", "Deli-points"],
};
const HASHTAGS: Record<string, string[]> = {
  base: ["#Delivrou", "#Conakry", "#Guinée", "#LivraisonConakry", "#Colis"],
  "Comment ça marche": ["#TutoColis", "#AppGuinée"],
  Confiance: ["#SuiviEnDirect", "#CoursierVérifié"],
  "Vie de Conakry": ["#VieAConakry", "#Kaloum", "#Ratoma"],
  Astuces: ["#AstuceColis", "#BienEmballer"],
  "Appel à l'action": ["#AppGuinée", "#TéléchargeL'app"],
};
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function pick<T>(arr: T[], seed: number, n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length && out.length < n; i++) out.push(arr[(seed + i * 3) % arr.length]);
  return [...new Set(out)];
}
function devinerPilier(e: Pick<Entree, "titre" | "sous" | "idee">): string {
  const t = `${e.titre} ${e.sous} ${e.idee}`.toLowerCase();
  if (/suivi|code|vérifi|verifi|prix|confiance|bonnes mains/.test(t)) return "Confiance";
  if (/étape|etape|comment|localiser|commande/.test(t)) return "Comment ça marche";
  if (/emball|astuce|conseil|photo du colis/.test(t)) return "Astuces";
  if (/famille|repère|repere|conakry|embouteill/.test(t)) return "Vie de Conakry";
  return "Appel à l'action";
}
function legendes(e: Pick<Entree, "id" | "titre" | "sous" | "idee" | "pilier">, pilier?: string): Legendes {
  const p = pilier && PILIERS.includes(pilier) ? pilier : e.pilier && PILIERS.includes(e.pilier) ? e.pilier : devinerPilier(e);
  const seed = hash(e.id || e.idee || "x");
  const accroche = (e.titre || "Delivrou, vite fait.").trim();
  const appui = (e.sous || "").trim();
  const corps = pick(CORPS[p], seed, 2).filter((l) => !(appui && /prix/i.test(appui) && /prix/i.test(l)));
  const tags = [...HASHTAGS.base, ...pick(HASHTAGS[p], seed, 2)];
  const cta = "Télécharge l'app : www.delivrou.com\n💬 WhatsApp : wa.me/224628901285";
  const facebook = [`${accroche} 📦`, appui, "Livraison de colis à Conakry, 7j/7.", ...corps, "", cta, "", tags.join(" ")].filter((x, i) => x !== "" || i > 0).join("\n").replace(/\n{3,}/g, "\n\n");
  const tiktokTags = [...new Set(["#Delivrou", "#Conakry", "#Colis", ...pick(HASHTAGS[p], seed, 1), "#LivraisonConakry"])].slice(0, 5);
  const tiktok = `${accroche} ${corps[0] || ""}`.trim().slice(0, 140) + " " + tiktokTags.join(" ");
  return { pilier: p, facebook, tiktok, hashtags: tags, motsCles: [...MOTS_CLES.base, ...MOTS_CLES[p]] };
}

// ---------- commande (prompt) construite a partir de la marque ----------
const STRUCTURES: Record<string, string> = {
  a: "une personne joyeuse à côté d'un téléphone, grand espace libre en haut pour un titre",
  b: "deux moitiés de scène séparées par un bord net, un avant et un après",
  c: "un téléphone au centre entouré d'objets en orbite sur un grand cercle",
  d: "un livreur à moto sur une route qui s'enroule autour d'un téléphone",
  e: "un personnage qui sort de l'écran du téléphone vers le spectateur",
  libre: "",
};
const FORMATS: Record<string, string> = { "4:5": "format vertical 4:5 (1080x1350)", "9:16": "format vertical 9:16 (1080x1920)", "1:1": "format carré 1:1" };

interface Demande {
  idee: string;
  type: Kind;
  genre: Genre;
  format: string;
  structure: string;
  titre: string;
  sous: string;
  bouton: string;
}
const PERSONNAGES: Record<string, { desc: string; tenue: string }> = {
  homme: { desc: "a real young Guinean man in his late twenties, short hair, light stubble", tenue: "a plain bright orange crew-neck t-shirt" },
  femme: { desc: "a real young Guinean woman in her late twenties, natural hair, elegant", tenue: "a plain bright orange blouse with a small colourful wax-print scarf" },
  livreur: { desc: "a real young Guinean delivery courier in his early twenties, athletic", tenue: "a plain bright orange zip jacket and a plain black helmet worn on the head" },
};
const POSES: Record<string, string> = {
  montre: "his or her right hand held out open to the side, palm up, presenting something off-frame, big warm smile, body slightly turned",
  pointe: "one arm extended with the index finger clearly pointing to the side, the other hand relaxed, excited smile",
  pouce: "one hand giving a confident thumbs up, the other relaxed, big smile",
  rit: "laughing joyfully, both hands clasped near the chest, body slightly turned, head tilted",
};
function commandePersonnage(persona: string, pose: string): string {
  const p = PERSONNAGES[persona] || PERSONNAGES.homme;
  return [
    `Professional studio photograph, waist-up, ${p.desc}, wearing ${p.tenue} with absolutely no text, logo, print or lettering on the clothes.`,
    `Pose: ${POSES[pose] || POSES.montre}. Genuine joyful natural expression, looking at the camera.`,
    "Soft studio lighting, crisp detail, realistic skin, realistic hands and fingers, shot on a full-frame camera.",
    "Photographed against a perfectly flat, uniform, pure chroma-key green background (#00B140), no gradient, no shadow on the background, nothing in the hands, no phone, no props, no objects, no text, no logo.",
  ].join(" ");
}

function construireCommande(d: Demande, j: Entree[]): string {
  const memo = (note: "aime" | "pas") => j.filter((e) => e.note === note && e.genre === d.genre).slice(-3).map((e) => e.idee);
  const aimes = memo("aime");
  const pasAimes = memo("pas");
  const scene = STRUCTURES[d.structure] || "";
  const format = FORMATS[d.format] || FORMATS["4:5"];
  if (d.genre === "affiche") {
    const titre = d.titre || "Ton colis, suivi en direct";
    const virgule = titre.indexOf(",");
    const ligne1 = virgule > 0 ? titre.slice(0, virgule + 1) : titre.split(" ").slice(0, Math.ceil(titre.split(" ").length / 2)).join(" ");
    const ligne2 = virgule > 0 ? titre.slice(virgule + 1).trim() : titre.split(" ").slice(Math.ceil(titre.split(" ").length / 2)).join(" ");
    return [
      `Vertical ${d.format === "9:16" ? "9:16" : "4:5"} premium social media poster for a parcel delivery app, in the style of a top-tier fintech app advertisement. Upper two-thirds: rich solid vivid orange background with a soft gradient from #EC6B2C to #F4923F, a subtle glow behind the person, thin white hand-drawn sketch strokes and light streaks. Bottom third: clean white area, with a big smooth curved edge rising into the orange area. Leave the top 12% of the poster EMPTY orange (no logo, no text) and leave the bottom-right of the white footer EMPTY.`,
      `Headline, centered below the empty top band, huge bold rounded geometric sans-serif, two lines: white "${ligne1}" then italic yellow (#FFD84A) "${ligne2}".${d.sous ? ` Under it a two-line white subtitle: "${d.sous}"` : ""}`,
      `Concept: ${d.idee}.`,
      scene && `Composition: ${scene}.`,
      "Center hero: a real, joyful young Guinean person, huge natural open smile, wearing a plain orange t-shirt, upper body cut out and overflowing in front of the shapes behind, photorealistic studio lighting, crisp details. With one hand they hold up a modern smartphone, screen facing the viewer, the screen showing a clean simple app screen with a white map and one big orange location pin, no tiny text. The other arm is bent and the index finger clearly POINTS at the phone, a confident 'look at this' gesture. Realistic hands.",
      "Behind and around the person a large glossy 3D orange ring/arc sweeps from left to right, with a dotted white route line winding along it, carrying floating glossy 3D elements: a plain cardboard parcel with tape, a red map pin, a green delivery-done check badge, a small courier on an orange motorbike carrying a box, plus soft glass bubbles, sparkles and light reflections. Strong depth, soft shadows, glossy premium 3D render look, wow effect.",
      `White footer: bold dark text on the left, "Télécharge l'app" and below it "Delivrou" in orange. Right side empty.${d.bouton ? ` Small button label if any: "${d.bouton}".` : ""}`,
      "ALL TEXT must be French, spelled EXACTLY as given, with correct accents, and no other text anywhere.",
      "Strict: no logos, no brand names other than Delivrou, no food, meals or pharmacy items, no prices, no delivery times, no numbers, no extra text.",
      aimes.length && `Spirit of posters the team liked: ${aimes.join("; ")}.`,
      pasAimes.length && `Avoid the direction of: ${pasAimes.join("; ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const base = d.type === "video" ? `Short vertical advertising video clip, ${FORMATS[d.format] || FORMATS["9:16"]}. ${d.idee}.` : `Professional advertising photograph, ${format}. ${d.idee}.`;
  return [
    base,
    scene && `Composition: ${scene}.`,
    "Setting: everyday Conakry, Guinea. Warm, joyful, authentic West African people with natural smiles; realistic hands and fingers.",
    "Palette: a bold flat-to-soft gradient field of orange #EC6B2C to #F4923F, cream #F6F1EA accents, small touches of dark #12141A. Clean, modern, premium delivery-app look like Uber Eats or Wolt, not generic AI art.",
    "A single clear subject, large calm empty area reserved for a headline. Soft studio-quality light, shallow depth of field.",
    "ABSOLUTELY NO text, no letters, no numbers, no logos, no watermarks, no brand names.",
    "Any phone is held upright with its SCREEN FACING THE CAMERA (never the back), the screen a plain flat orange. Any parcel is a plain brown cardboard shipping box with tape, never a gift box, no ribbon, no bow.",
    "The service is parcel delivery only: no food, no meals, no pharmacy items.",
    aimes.length && `The team liked earlier ideas such as: ${aimes.join("; ")}. Keep that spirit.`,
    pasAimes.length && `The team did not like: ${pasAimes.join("; ")}. Avoid that direction.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Meilleur modele pas cher : meilleure qualite sous le plafond, au prix le plus bas a qualite egale. */
function recommander(type: Kind, genre: Genre): string[] {
  const { plafonds, modeles } = catalogue();
  const plafond = genre === "affiche" ? plafonds.affiche : plafonds[type];
  return modeles
    .filter((m) => m.type === type && (m.genres || ["photo"]).includes(genre) && m.verifie && m.prix != null && m.prix <= plafond)
    .sort((a, b) => b.qualite - a.qualite || (a.prix ?? 9) - (b.prix ?? 9))
    .map((m) => m.id);
}

// ---------- generation Higgsfield ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface HfReponse {
  status?: string;
  status_url?: string;
  images?: Array<{ url?: string }>;
  video?: { url?: string };
  detail?: unknown;
  error?: unknown;
  message?: unknown;
}
async function hf(key: string, method: "GET" | "POST", url: string, body?: unknown): Promise<HfReponse> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: HfReponse = {};
  try {
    json = JSON.parse(text) as HfReponse;
  } catch {
    /* corps non JSON */
  }
  if (!res.ok) {
    const detail = String(json.detail ? JSON.stringify(json.detail) : json.error || json.message || text).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`Higgsfield ${res.status} : ${detail}`);
  }
  return json;
}

async function produire(id: string, modele: Modele, duree: number) {
  const key = hfKey();
  const e = journal().find((x) => x.id === id);
  if (!key || !e) return;
  try {
    const ratio = modele.formats?.[e.format] || e.format;
    const sub = await hf(key, "POST", `${API}/${modele.id}`, { prompt: e.prompt, aspect_ratio: ratio, ...(modele.params || {}), ...(modele.type === "video" ? { duration: duree } : {}) });
    let st = sub;
    for (let i = 0; i < 200 && !["completed", "failed", "nsfw", "canceled"].includes(st.status || ""); i++) {
      await sleep(3000);
      if (!sub.status_url) break;
      st = await hf(key, "GET", sub.status_url);
    }
    if (st.status !== "completed") throw new Error(`Génération ${st.status || "interrompue"}`);
    const url = st.images?.[0]?.url || st.video?.url;
    if (!url) throw new Error("Aucun fichier reçu");
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error("Téléchargement impossible");
    const ext = modele.type === "video" ? "mp4" : (url.split("?")[0].split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").slice(0, 4) || "png";
    const fichier = `${id}.${ext}`;
    fs.mkdirSync(CREATIONS, { recursive: true });
    fs.writeFileSync(path.join(CREATIONS, fichier), Buffer.from(await r.arrayBuffer()));
    await modifierJournal((j) => {
      const x = j.find((y) => y.id === id);
      if (x) {
        x.fichier = fichier;
        x.statut = "pret";
        x.legendes = legendes(x);
      }
    });
  } catch (err) {
    await modifierJournal((j) => {
      const x = j.find((y) => y.id === id);
      if (x) {
        x.statut = "echec";
        x.cout = 0; // un echec ne compte pas
        x.erreur = (err instanceof Error ? err.message : String(err)).slice(0, 160);
      }
    });
  }
}

// ---------- API ----------
export const studioRouter = express.Router();
const t = (v: unknown, n: number) => String(v ?? "").slice(0, n);

/** POST uniquement depuis la page du QG (meme origine) : protege des requetes venues d'ailleurs. */
studioRouter.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.method === "POST") {
    const origin = req.get("origin");
    const host = req.get("host");
    let ok = false;
    try {
      ok = Boolean(origin && host && new URL(origin).host === host);
    } catch {
      ok = false;
    }
    if (!ok) {
      res.status(403).json({ ok: false, erreur: "Origine refusée." });
      return;
    }
  }
  next();
});
studioRouter.use(express.json({ limit: "64kb" }));

const recents: number[] = []; // horodatages des demandes de generation (plafond horaire)

studioRouter.get("/etat", (_req, res) => {
  const j = journal();
  const semaine = lundiDe();
  const cat = catalogue();
  res.json({
    ok: true,
    actif: Boolean(hfKey()) && !disabled(),
    cleTrouvee: Boolean(hfKey()),
    semaine,
    budget: budget(),
    depense: Number(depense(j, semaine).toFixed(4)),
    piliers: PILIERS,
    modeles: cat.modeles.map((m) => ({ id: m.id, nom: m.nom, type: m.type, genres: m.genres || ["photo"], prix: m.prix, qualite: m.qualite, pour: m.pour, min: m.min, max: m.max, durees: m.durees, verifie: m.verifie })),
    recommandes: { photo: recommander("image", "photo"), affiche: recommander("image", "affiche"), video: recommander("video", "photo") },
    journal: j.slice().reverse().slice(0, 80),
    planning: planning(),
  });
});

studioRouter.post("/commande", (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const genre: Genre = b.genre === "affiche" ? "affiche" : "photo";
  const type: Kind = b.type === "video" ? "video" : "image";
  const d: Demande = { idee: t(b.idee, 600), type, genre, format: t(b.format, 8), structure: t(b.structure, 8), titre: t(b.titre, 120), sous: t(b.sous, 120), bouton: t(b.bouton, 40) };
  if (!d.idee) {
    res.status(400).json({ ok: false, erreur: "Il manque l'idée." });
    return;
  }
  res.json({ ok: true, prompt: construireCommande(d, journal()), alertes: verifierRegles(d.idee, d.titre, d.sous, d.bouton) });
});

async function genererHandler(req: Request, res: Response) {
  const key = hfKey();
  if (!key || disabled()) {
    res.status(503).json({ ok: false, erreur: "Le Studio n'est pas activé sur le serveur (clé Higgsfield absente ou Studio coupé)." });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const gabarit = b.gabarit === "delivrou-a" ? "delivrou-a" : "";
  if (gabarit) {
    b.genre = "photo";
    b.type = "image";
    b.format = "4:5";
    b.modele = "auto";
    b.idee = t(b.idee, 600) || `Affiche ${t(b.titre, 120).replace("|", " ")}`;
    b.prompt = commandePersonnage(t(b.persona, 12), t(b.pose, 12));
  }
  const genre: Genre = b.genre === "affiche" ? "affiche" : "photo";
  const type: Kind = b.type === "video" ? "video" : "image";
  const cat = catalogue();
  const wanted = b.modele === "auto" ? recommander(type, genre)[0] : t(b.modele, 120);
  const modele = cat.modeles.find((m) => m.id === wanted);
  if (!modele || modele.type !== type || !(modele.genres || ["photo"]).includes(genre) || !modele.verifie) {
    res.status(400).json({ ok: false, erreur: "Modèle inconnu ou pas disponible pour ce type de création." });
    return;
  }
  const idee = t(b.idee, 600);
  const prompt = t(b.prompt, 4000);
  if (!idee || !prompt) {
    res.status(400).json({ ok: false, erreur: "Il manque l'idée ou la commande." });
    return;
  }
  const alertes = verifierRegles(idee, t(b.titre, 120), t(b.sous, 120), prompt.replace(/ABSOLUTELY NO[^.]*\./i, "").replace(/Never show[^.]*\./i, "").replace(/no food, no meals, no pharmacy items/i, ""));
  if (alertes.length) {
    res.status(422).json({ ok: false, erreur: "Contre les règles de la marque.", alertes });
    return;
  }
  if (modele.prix == null) {
    res.status(422).json({ ok: false, erreur: `Prix du modèle « ${modele.nom} » à renseigner.` });
    return;
  }
  let duree = type === "video" ? Math.min(Math.max(Math.round(Number(b.duree)) || 5, modele.min || 2), modele.max || 12) : 1;
  if (modele.durees?.length) duree = modele.durees.reduce((a, c) => (Math.abs(c - duree) < Math.abs(a - duree) ? c : a));
  const cout = Number((modele.prix * duree).toFixed(4));

  const maintenant = Date.now();
  while (recents.length && maintenant - recents[0] > 3_600_000) recents.shift();
  if (recents.length >= 30) {
    res.status(429).json({ ok: false, erreur: "Trop de générations cette heure. Réessaie plus tard." });
    return;
  }

  const semaine = lundiDe();
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const refus = await modifierJournal((j) => {
    if (j.filter((e) => e.statut === "en_cours").length >= 3) return "Trois créations sont déjà en cours : attends qu'elles se terminent.";
    const reste = budget() - depense(j, semaine);
    if (cout * MARGE > reste) return `Budget de la semaine dépassé (reste ${reste.toFixed(2)} $, coût ${cout.toFixed(2)} $).`;
    j.push({
      id,
      date: new Date().toISOString(),
      semaine,
      idee,
      structure: t(b.structure, 8) || "libre",
      genre,
      titre: t(b.titre, 120),
      sous: t(b.sous, 120),
      pilier: PILIERS.includes(String(b.pilier)) ? String(b.pilier) : undefined,
      gabarit: gabarit || undefined,
      pastille: gabarit ? t(b.pastille, 30) : undefined,
      ecran: gabarit ? t(b.ecran, 30).replace(/[^a-z0-9-]/gi, "") : undefined,
      type,
      format: t(b.format, 8) || "4:5",
      modele: modele.id,
      prompt,
      cout,
      mode: "reel",
      statut: "en_cours",
      fichier: null,
      note: null,
    });
    return null;
  });
  if (refus) {
    res.status(402).json({ ok: false, erreur: refus });
    return;
  }
  recents.push(maintenant);
  void produire(id, modele, duree);
  res.status(202).json({ ok: true, id });
}
studioRouter.post("/generer", genererHandler);

studioRouter.post("/finaliser", express.raw({ type: "image/png", limit: "12mb" }), async (req, res) => {
  const id = String(req.query.id || "");
  const png = req.body as Buffer;
  const estPng = Buffer.isBuffer(png) && png.length > 1000 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!estPng) {
    res.status(400).json({ ok: false, erreur: "Image invalide." });
    return;
  }
  const trouve = await modifierJournal((j) => {
    const e = j.find((x) => x.id === id);
    if (!e || e.statut !== "pret" || e.type !== "image" || (e.genre !== "affiche" && !e.gabarit)) return false;
    const fichier = `${e.id}-final.png`;
    fs.writeFileSync(path.join(CREATIONS, fichier), png);
    if (!e.final) e.original = e.fichier ?? undefined;
    e.fichier = fichier;
    e.final = true;
    return true;
  });
  res.status(trouve ? 200 : 404).json({ ok: trouve });
});

studioRouter.post("/noter", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const trouve = await modifierJournal((j) => {
    const e = j.find((x) => x.id === b.id);
    if (!e) return false;
    e.note = b.note === "aime" || b.note === "pas" ? b.note : null;
    return true;
  });
  res.status(trouve ? 200 : 404).json({ ok: trouve });
});

studioRouter.get("/legendes", (req, res) => {
  const e = journal().find((x) => x.id === req.query.id);
  if (!e) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({ ok: true, ...legendes(e, typeof req.query.pilier === "string" ? req.query.pilier : undefined) });
});

/** Approuver : la creation entre dans le calendrier du QG. */
studioRouter.post("/approuver", (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const e = journal().find((x) => x.id === b.id);
  if (!e || e.statut !== "pret" || !e.fichier) {
    res.status(404).json({ ok: false, erreur: "Création introuvable ou pas prête." });
    return;
  }
  const semaine = t(b.semaine, 10);
  const lundi = new Date(`${semaine}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(semaine) || Number.isNaN(lundi.getTime()) || lundi.getUTCDay() !== 1) {
    res.status(400).json({ ok: false, erreur: "La semaine doit commencer un lundi." });
    return;
  }
  const jour = Math.round(Number(b.jour));
  if (!(jour >= 1 && jour <= 7)) {
    res.status(400).json({ ok: false, erreur: "Jour invalide." });
    return;
  }
  const facebook = t(b.facebook, 2000);
  const tiktok = t(b.tiktok, 300);
  const alertes = verifierRegles(facebook, tiktok);
  if (alertes.length) {
    res.status(422).json({ ok: false, erreur: "Contre les règles de la marque.", alertes });
    return;
  }
  const pilier = PILIERS.includes(String(b.pilier)) ? String(b.pilier) : devinerPilier(e);
  const post: PostPlanifie = {
    id: e.id,
    semaine,
    jour,
    heure: /^\d{2}:\d{2}$/.test(String(b.heure)) ? String(b.heure) : "12:30",
    pilier,
    titre: e.titre || e.idee.slice(0, 60),
    facebook,
    tiktok,
    fichier: e.fichier,
    type: e.type,
    format: e.format,
  };
  const liste = planning().filter((p) => p.id !== e.id);
  liste.push(post);
  writeJson(PLANNING, liste);
  res.json({ ok: true, post });
});

studioRouter.post("/retirer", (req, res) => {
  const id = (req.body as Record<string, unknown> | undefined)?.id;
  writeJson(PLANNING, planning().filter((p) => p.id !== id));
  res.json({ ok: true });
});

// ---------- idees de creation proposees par Gemini ----------
interface Idee {
  idee: string;
  titre: string;
  sous: string;
  bouton: string;
  structure: string;
  pilier: string;
}
const ideesRecentes: number[] = [];

/** Extrait un tableau JSON d'une reponse libre (Gemini ajoute parfois du texte ou des balises). */
function lireJson(texte: string): unknown {
  const brut = texte.replace(/```(?:json)?/gi, "").trim();
  const debut = brut.indexOf("[");
  const fin = brut.lastIndexOf("]");
  if (debut < 0 || fin <= debut) return null;
  try {
    return JSON.parse(brut.slice(debut, fin + 1));
  } catch {
    return null;
  }
}

function consigneIdees(genre: Genre, type: Kind, brouillon: string, pilier: string, n: number): string {
  const j = journal();
  const ligne = (e: Entree) => `- ${e.titre || e.idee.slice(0, 80)}`;
  const recents = j.slice(-8).map(ligne).join("\n") || "(rien pour l'instant)";
  const aimes = j.filter((e) => e.note === "aime").slice(-4).map(ligne).join("\n");
  const pasAimes = j.filter((e) => e.note === "pas").slice(-4).map(ligne).join("\n");
  const planifies = planning().slice(-8).map((p) => `${p.pilier} : ${p.titre}`).join("\n");
  const forme =
    type === "video"
      ? "une VIDÉO courte verticale de 5 à 8 secondes, sans aucun texte à l'écran. Le champ idee décrit la scène en action : qui, où, ce qui se passe du début à la fin, le mouvement de caméra, l'ambiance. titre, sous et bouton restent vides."
      : genre === "affiche"
        ? "une AFFICHE complète 4:5 pour Facebook et TikTok. Le champ idee décrit la scène visuelle en 2 ou 3 phrases (le personnage, son expression, sa tenue, les objets, le décor). titre = 4 à 8 mots, vrai et sans promesse chiffrée ; sous = une phrase d'appui courte ; bouton = un appel à l'action court (ex. « Télécharge l'app »)."
        : "une PHOTO de fond sans texte (le texte sera ajouté ensuite). Le champ idee décrit la scène en 2 ou 3 phrases. titre, sous et bouton restent vides.";
  return [
    "Tu es le directeur artistique de Delivrou. Tu inventes des idées de créations pour Facebook et TikTok, à Conakry.",
    `Il faut ${n} idée(s) différente(s) pour ${forme}`,
    "Style visuel : champ de couleur orange franc (#EC6B2C vers #F4923F), crème, touches sombres ; un vrai humain guinéen, joyeux et naturel, qui sourit franchement ; le téléphone avec l'app (écran visible) et le colis en carton comme objets centraux ; formes courbes, éléments flottants en 3D ; look sobre et précis d'une app de livraison moderne (Uber Eats, Wolt, Careem), jamais d'image IA générique.",
    "Compositions possibles (champ structure) : a = une personne + un téléphone + grand titre ; b = deux moitiés séparées par un bord net (avant / après) ; c = un téléphone entouré d'éléments en orbite sur un cercle ; d = un livreur à moto sur une route qui s'enroule autour du téléphone ; e = un personnage qui sort de l'écran ; libre = autre.",
    "Piliers possibles (champ pilier, valeur exacte) : " + PILIERS.map((p) => `« ${p} »`).join(", ") + ".",
    "RÈGLES STRICTES : le seul service disponible est le COLIS (jamais de repas, pharmacie, épicerie) ; aucun délai chiffré ni prix ; aucune promesse de rapidité (jamais « vite », « rapide », « express ») ; aucun chiffre inventé (clients, livraisons, communes) ; pas de paiement en espèces ; aucune fausse urgence ni pression ; pas de tirage au sort ni concours ; rien de religieux ; pas d'alcool, tabac, porc, jeux d'argent ; pas de faux avis ni témoignage ; aucune donnée personnelle visible. Tutoiement, français simple de Conakry, chaleureux.",
    pilier ? `Pilier demandé : ${pilier}.` : planifies ? `Posts déjà prévus (varie les piliers et les sujets) :\n${planifies}` : "",
    `Créations récentes (ne les répète pas) :\n${recents}`,
    aimes ? `L'équipe a aimé :\n${aimes}` : "",
    pasAimes ? `L'équipe n'a pas aimé :\n${pasAimes}` : "",
    brouillon ? `L'équipe a déjà une idée brute : « ${brouillon} ». Garde son intention et transforme-la en ${n} version(s) abouties et très visuelles.` : "Propose des idées variées (sujets, compositions et piliers différents).",
    'Réponds UNIQUEMENT par un tableau JSON valide, sans texte autour, sans balises, de la forme : [{"idee":"...","titre":"...","sous":"...","bouton":"...","structure":"a","pilier":"Confiance"}]',
  ]
    .filter(Boolean)
    .join("\n\n");
}

studioRouter.post("/idees", async (req: Request, res: Response) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ ok: false, erreur: "L'aide à l'idée (Gemini) n'est pas configurée sur le serveur." });
    return;
  }
  const maintenant = Date.now();
  while (ideesRecentes.length && maintenant - ideesRecentes[0] > 3_600_000) ideesRecentes.shift();
  if (ideesRecentes.length >= 30) {
    res.status(429).json({ ok: false, erreur: "Trop de demandes d'idées cette heure. Réessaie plus tard." });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const genre: Genre = b.genre === "affiche" ? "affiche" : "photo";
  const type: Kind = b.type === "video" ? "video" : "image";
  const brouillon = t(b.brouillon, 500).trim();
  const pilier = PILIERS.includes(String(b.pilier)) ? String(b.pilier) : "";
  const n = brouillon ? 2 : 4;
  ideesRecentes.push(maintenant);
  const r = await askGeminiEmail(consigneIdees(genre, type, brouillon, pilier, n));
  if (!r.ok || !r.text) {
    res.status(502).json({ ok: false, erreur: "Gemini n'a pas répondu pour l'instant. Réessaie dans une minute." });
    return;
  }
  const brut = lireJson(r.text);
  const liste: Idee[] = [];
  const avecTexte = type === "image" && genre === "affiche";
  if (Array.isArray(brut)) {
    for (const x of brut) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      const i: Idee = {
        idee: t(o.idee, 600).trim(),
        titre: avecTexte ? t(o.titre, 80).trim() : "",
        sous: avecTexte ? t(o.sous, 100).trim() : "",
        bouton: avecTexte ? t(o.bouton, 30).trim() || "Télécharge l'app" : "",
        structure: ["a", "b", "c", "d", "e", "libre"].includes(String(o.structure)) ? String(o.structure) : "libre",
        pilier: PILIERS.includes(String(o.pilier)) ? String(o.pilier) : "",
      };
      if (!i.idee) continue;
      if (verifierRegles(i.idee, i.titre, i.sous, i.bouton).length) continue; // une idée qui enfreint les règles n'est jamais proposée
      liste.push(i);
    }
  }
  if (!liste.length) {
    res.status(502).json({ ok: false, erreur: "Gemini n'a pas donné d'idée utilisable. Réessaie." });
    return;
  }
  res.json({ ok: true, idees: liste.slice(0, 4) });
});

// ---------- creation en un clic : l'idee, les textes et la pose sont choisis automatiquement ----------
interface Brief {
  t1: string;
  t2: string;
  sous: string;
  pastille: string;
  pose: string;
  ecran: string;
  pilier: string;
}
const BRIEFS: Brief[] = [
  { t1: "Ton colis,", t2: "suivi en direct", sous: "Envoie ton colis à Conakry et suis-le sur ton téléphone.", pastille: "Suivi en direct", pose: "montre", ecran: "09-en-route-code", pilier: "Comment ça marche" },
  { t1: "Envoie un colis,", t2: "sans stress", sous: "Le prix s'affiche avant que tu valides.", pastille: "Prix affiché", pose: "pouce", ecran: "01-accueil", pilier: "Confiance" },
  { t1: "Le code qui", t2: "protège ton colis", sous: "Le livreur ne remet le colis qu'avec ton code.", pastille: "Code de livraison", pose: "pointe", ecran: "09-en-route-code", pilier: "Confiance" },
  { t1: "Ton livreur,", t2: "tu le vois venir", sous: "Suis-le en direct sur la carte jusqu'à destination.", pastille: "Carte en direct", pose: "rit", ecran: "08-livreur-assigne-pin", pilier: "Comment ça marche" },
];
const ECRANS = ["01-accueil", "09-en-route-code", "08-livreur-assigne-pin", "10-remis"];

function lireObjet(texte: string): Record<string, unknown> | null {
  const brut = texte.replace(/```(?:json)?/gi, "").trim();
  const a = brut.indexOf("{");
  const z = brut.lastIndexOf("}");
  if (a < 0 || z <= a) return null;
  try {
    const o: unknown = JSON.parse(brut.slice(a, z + 1));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function briefAffiche(): Promise<Brief> {
  const j = journal().filter((e) => e.gabarit);
  const fallback = BRIEFS[j.length % BRIEFS.length];
  if (!isGeminiConfigured()) return fallback;
  const deja = j.slice(-8).map((e) => "- " + (e.titre || "").replace("|", " ")).join("\n") || "(rien)";
  const consigne = [
    "Tu es le directeur artistique de Delivrou, service de livraison de COLIS à Conakry. Invente UNE affiche pour Facebook et TikTok.",
    "Champs : t1 et t2 = les deux lignes du titre (chacune 16 caractères maximum, espaces compris, sans point final) ; sous = une phrase d'appui de 60 caractères maximum ; pastille = 2 ou 3 mots (18 caractères maximum) pour une pastille ronde ; pose parmi montre, pointe, pouce, rit ; ecran parmi " + ECRANS.join(", ") + " (l'écran de l'app le plus adapté) ; pilier parmi " + PILIERS.map((p) => "« " + p + " »").join(", ") + ".",
    "RÈGLES STRICTES : le seul service est le COLIS (jamais de repas, pharmacie, épicerie) ; aucun délai chiffré ni prix ; aucune promesse de rapidité (jamais « vite », « rapide », « express ») ; aucun chiffre inventé ; pas de paiement en espèces ; aucune fausse urgence ; pas de concours ; rien de religieux ; pas de faux avis. Tutoiement, français simple et chaleureux. Les affirmations doivent être vraies pour l'app : suivi en direct du livreur sur la carte, code de livraison à donner au livreur, prix affiché avant de valider, livreurs vérifiés.",
    "Titres déjà faits (ne les répète pas) :\n" + deja,
    'Réponds UNIQUEMENT par un objet JSON valide : {"t1":"","t2":"","sous":"","pastille":"","pose":"","ecran":"","pilier":""}',
  ].join("\n\n");
  const r = await askGeminiEmail(consigne);
  const o = r.ok && r.text ? lireObjet(r.text) : null;
  if (!o) return fallback;
  const b: Brief = {
    t1: t(o.t1, 40).trim(),
    t2: t(o.t2, 40).trim(),
    sous: t(o.sous, 100).trim(),
    pastille: t(o.pastille, 30).trim(),
    pose: Object.keys(POSES).includes(String(o.pose)) ? String(o.pose) : fallback.pose,
    ecran: ECRANS.includes(String(o.ecran)) ? String(o.ecran) : fallback.ecran,
    pilier: PILIERS.includes(String(o.pilier)) ? String(o.pilier) : fallback.pilier,
  };
  const trop = b.t1.length < 2 || b.t1.length > 16 || b.t2.length < 2 || b.t2.length > 18 || b.sous.length > 70 || b.pastille.length < 2 || b.pastille.length > 20;
  if (trop || verifierRegles(b.t1, b.t2, b.sous, b.pastille).length) return fallback;
  return b;
}

async function ideePhoto(): Promise<string> {
  const defaut = "Une jeune femme guinéenne sourit en recevant un colis à sa porte, lumière chaude de fin d'après-midi, rue de Conakry floue en arrière-plan.";
  if (!isGeminiConfigured()) return defaut;
  const r = await askGeminiEmail(consigneIdees("photo", "image", "", "", 1));
  const brut = r.ok && r.text ? lireJson(r.text) : null;
  const premiere = Array.isArray(brut) ? (brut[0] as Record<string, unknown> | undefined) : undefined;
  const idee = premiere ? t(premiere.idee, 600).trim() : "";
  return idee && !verifierRegles(idee).length ? idee : defaut;
}

studioRouter.post("/auto", async (req: Request, res: Response) => {
  const type = (req.body as Record<string, unknown> | undefined)?.type;
  if (type === "affiche") {
    const b = await briefAffiche();
    req.body = { gabarit: "delivrou-a", persona: "homme", pose: b.pose, titre: b.t1 + "|" + b.t2, sous: b.sous, pastille: b.pastille, ecran: b.ecran, pilier: b.pilier, idee: "Affiche : " + b.t1 + " " + b.t2 };
  } else if (type === "photo") {
    const idee = await ideePhoto();
    const prompt = construireCommande({ idee, type: "image", genre: "photo", format: "4:5", structure: "libre", titre: "", sous: "", bouton: "" }, journal());
    req.body = { genre: "photo", type: "image", modele: "auto", format: "4:5", structure: "libre", idee, prompt };
  } else {
    res.status(400).json({ ok: false, erreur: "Type inconnu." });
    return;
  }
  await genererHandler(req, res);
});

// ---------- suppression ----------
function effacer(e: Entree) {
  for (const f of [e.fichier, e.original]) {
    if (!f) continue;
    try {
      fs.unlinkSync(path.join(CREATIONS, path.basename(f)));
    } catch {
      /* fichier deja absent */
    }
  }
}
studioRouter.post("/supprimer", async (req, res) => {
  const id = String((req.body as Record<string, unknown> | undefined)?.id || "");
  if (planning().some((p) => p.id === id)) {
    res.status(409).json({ ok: false, erreur: "Elle est au calendrier : retire-la d'abord du calendrier." });
    return;
  }
  const ok = await modifierJournal((j) => {
    const i = j.findIndex((x) => x.id === id);
    if (i < 0 || j[i].statut === "en_cours") return false;
    effacer(j[i]);
    j.splice(i, 1);
    return true;
  });
  res.status(ok ? 200 : 404).json({ ok });
});
studioRouter.post("/nettoyer", async (_req, res) => {
  const n = await modifierJournal((j) => {
    const avant = j.length;
    for (let i = j.length - 1; i >= 0; i--) {
      if (j[i].statut === "echec") {
        effacer(j[i]);
        j.splice(i, 1);
      }
    }
    return avant - j.length;
  });
  res.json({ ok: true, supprimes: n });
});

// ---------- videos en histoire : scenario ecrit par Gemini, montage dans le QG ----------
interface Carte {
  titre: string;
  texte: string;
}
interface Message {
  de: "moi" | "autre";
  texte: string;
}
interface Scene {
  type: "titre" | "chat" | "tel" | "notif" | "avatar" | "cta";
  dur?: number;
  fond?: string;
  haut?: string;
  lignes?: string[];
  objets?: string[];
  sous?: string;
  voix?: string;
  contact?: string;
  messages?: Message[];
  ecran?: string;
  legende?: string;
  titre?: string;
  heure?: string;
  cartes?: Carte[];
  avatar?: string;
}
interface Scenario {
  titre: string;
  format: "16:9" | "9:16";
  scenes: Scene[];
}

const OBJETS = ["obj-colis", "obj-repere", "obj-scooter", "obj-coche", "obj-bouclier", "obj-cloche", "obj-bulle", "obj-cle"];
const DECORS = ["dec-rue", "dec-marche", "dec-ville", "dec-nuit", "dec-moto", "dec-salon"];
const PERSOS = ["per-maman", "per-jeune-femme", "per-entrepreneur", "per-livreur2"];

const HISTOIRES: Scenario[] = [
  {
    titre: "Le colis de Fatoumata",
    format: "16:9",
    scenes: [
      { type: "avatar", fond: "dec-salon", avatar: "per-maman", haut: "Ta maman t'appelle", lignes: ["Alors, il est où,", "*ton colis ?*"], objets: ["obj-colis"], voix: "Ta maman t'appelle : alors, il est où, ton colis ?" },
      { type: "titre", fond: "sombre", haut: "Toi, devant ton téléphone…", lignes: ["Et tu *inventes.*"], objets: ["obj-bulle"], voix: "Toi, tu regardes ton téléphone… et tu inventes." },
      { type: "chat", fond: "sombre", contact: "Maman", messages: [{ de: "autre", texte: "Il est où, ton colis ?" }, { de: "moi", texte: "Il est presque arrivé, maman." }], voix: "« Il est presque arrivé, maman. »" },
      { type: "titre", fond: "clair", haut: "Sauf que…", lignes: ["« Presque arrivé »,", "ce n'est pas *une adresse.*"], objets: ["obj-repere"], voix: "Sauf que « presque arrivé », ce n'est pas une adresse." },
      { type: "tel", fond: "sombre", ecran: "09-en-route-code", legende: "Ton livreur, *en direct* sur la carte", objets: ["obj-scooter", "obj-repere"], voix: "Avec Delivrou, tu vois ton livreur en direct, sur la carte." },
      { type: "notif", fond: "sombre", titre: "Prévenu à chaque étape", cartes: [{ titre: "Livreur assigné", texte: "Il vient chercher ton colis" }, { titre: "Colis en route", texte: "Suis-le sur la carte" }, { titre: "Colis remis", texte: "Remis avec ton code" }], voix: "Tu es prévenu à chaque étape." },
      { type: "titre", fond: "sombre", haut: "À la remise", lignes: ["Pas de code,", "*pas de colis.*"], objets: ["obj-cle", "obj-bouclier"], voix: "Et à la remise, le livreur te demande ton code. Pas de code, pas de colis." },
      { type: "titre", fond: "dec-salon", lignes: ["Maman est *contente.*"], sous: "Et toi, tu ne mens plus.", objets: ["obj-coche"], voix: "Résultat : maman est contente, et toi, tu n'as plus besoin de mentir." },
      { type: "cta", lignes: ["Delivrou.", "Envoie ton colis."], voix: "Delivrou. Envoie ton colis, sans stress." },
    ],
  },
];

const clip = (v: unknown, n: number) => t(v, n).replace(/\s+/g, " ").trim();
const listeChoisie = (v: unknown, permis: string[], max: number) => (Array.isArray(v) ? v.map(String).filter((x) => permis.includes(x)).slice(0, max) : []);

/** Controle strict d'un scenario (venu de Gemini ou du client) : forme, longueurs, elements de la bibliotheque, regles de marque. */
function validerScenario(brut: unknown): Scenario | null {
  if (!brut || typeof brut !== "object") return null;
  const o = brut as Record<string, unknown>;
  if (!Array.isArray(o.scenes)) return null;
  const scenes: Scene[] = [];
  for (const x of o.scenes.slice(0, 14)) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const type = String(r.type);
    const lignes = Array.isArray(r.lignes) ? r.lignes.slice(0, 3).map((l) => clip(l, 34)).filter(Boolean) : [];
    const fondBrut = String(r.fond);
    const base = {
      fond: ["sombre", "clair", "orange"].includes(fondBrut) || DECORS.includes(fondBrut) ? fondBrut : "sombre",
      haut: clip(r.haut, 40),
      sous: clip(r.sous, 60),
      voix: clip(r.voix, 160),
      objets: listeChoisie(r.objets, OBJETS, 3),
    };
    if (type === "titre" && lignes.length) scenes.push({ type, ...base, lignes });
    else if (type === "avatar" && lignes.length && PERSOS.includes(String(r.avatar))) scenes.push({ type, ...base, lignes, avatar: String(r.avatar) });
    else if (type === "chat" && Array.isArray(r.messages)) {
      const messages = r.messages.slice(0, 4).map((m) => ({ de: (m as Record<string, unknown>)?.de === "moi" ? ("moi" as const) : ("autre" as const), texte: clip((m as Record<string, unknown>)?.texte, 52) })).filter((m) => m.texte);
      if (messages.length) scenes.push({ type, ...base, contact: clip(r.contact, 16) || "Maman", messages });
    } else if (type === "tel" && ECRANS.includes(String(r.ecran))) scenes.push({ type, ...base, ecran: String(r.ecran), legende: clip(r.legende, 60) });
    else if (type === "notif" && Array.isArray(r.cartes)) {
      const cartes = r.cartes.slice(0, 3).map((c) => ({ titre: clip((c as Record<string, unknown>)?.titre, 28), texte: clip((c as Record<string, unknown>)?.texte, 44) })).filter((c) => c.titre);
      if (cartes.length) scenes.push({ type, ...base, titre: clip(r.titre, 44), cartes, heure: /^\d{2}:\d{2}$/.test(String(r.heure)) ? String(r.heure) : undefined });
    } else if (type === "cta") scenes.push({ type, ...base, lignes: lignes.length ? lignes : ["Delivrou.", "Envoie ton colis."] });
  }
  if (scenes.length < 4) return null;
  if (scenes[scenes.length - 1].type !== "cta") scenes.push({ type: "cta", lignes: ["Delivrou.", "Envoie ton colis."] });
  const textes = JSON.stringify(scenes.map((c) => [c.lignes, c.haut, c.sous, c.voix, c.messages, c.legende, c.titre, c.cartes]));
  if (verifierRegles(textes).length) return null;
  return { titre: clip(o.titre, 60) || "Histoire Delivrou", format: o.format === "9:16" ? "9:16" : "16:9", scenes };
}

const scenariosRecents: number[] = [];
studioRouter.post("/scenario", async (req: Request, res: Response) => {
  const j = journal().filter((e) => e.gabarit === "histoire");
  const defaut = HISTOIRES[j.length % HISTOIRES.length];
  const sujet = clip((req.body as Record<string, unknown> | undefined)?.sujet, 200);
  if (!isGeminiConfigured()) {
    res.json({ ok: true, source: "modele", scenario: defaut });
    return;
  }
  const maintenant = Date.now();
  while (scenariosRecents.length && maintenant - scenariosRecents[0] > 3_600_000) scenariosRecents.shift();
  if (scenariosRecents.length >= 20) {
    res.json({ ok: true, source: "modele", scenario: defaut });
    return;
  }
  scenariosRecents.push(maintenant);
  const deja = j.slice(-6).map((e) => "- " + e.titre).join("\n") || "(rien)";
  const consigne = [
    "Tu écris le scénario d'une vidéo de motion design de 28 à 36 secondes pour Facebook et TikTok, pour Delivrou, service de livraison de COLIS à Conakry. Style : histoire courte et drôle avec un prénom guinéen, une situation que chacun connaît, une chute, puis la solution Delivrou, puis l'appel à l'action. Une voix off lit une phrase par scène : champ voix = la phrase lue (10 à 22 mots, ton complice et amusant, tutoiement, français simple). Pas de personnage qui bouge : seulement du texte animé, des maquettes, des objets 3D et des photos de décor.",
    "Types de scènes : « titre » (haut = petite ligne grise ≤ 40 caractères ; lignes = 1 à 3 lignes ≤ 34 caractères ; *mot* entre étoiles = mot surligné ; fond = sombre|clair|orange|" + DECORS.join("|") + " ; objets = jusqu'à 3 objets 3D parmi " + OBJETS.join(", ") + " ; sous = sous-titre ≤ 60) ; « avatar » (comme titre, plus avatar parmi " + PERSOS.join(", ") + " : portrait rond) ; « chat » (contact, messages = 2 à 4 {de:moi|autre, texte ≤ 52}) ; « tel » (le téléphone avec la vraie app : ecran parmi " + ECRANS.join(", ") + ", legende ≤ 60, objets) ; « notif » (titre ≤ 44, cartes = 2 ou 3 {titre ≤ 28, texte ≤ 44}, heure facultative au format HH:MM) ; « cta » (dernière scène : lignes = 2 lignes courtes).",
    "Structure conseillée : accroche en 3 s, le problème, retournement « Sauf que… », la solution avec la vraie app (tel, notif), cta. 8 à 11 scènes. Choisis format 16:9 (par défaut) ou 9:16 si l'histoire s'y prête.",
    "RÈGLES STRICTES : le seul service est le COLIS (jamais de repas, pharmacie, épicerie) ; aucun délai chiffré ni prix ; aucune promesse de rapidité (jamais « vite », « rapide », « express ») ; aucun chiffre inventé ; pas de paiement en espèces ; aucune fausse urgence ; pas de concours ; rien de religieux ; pas de faux avis ni témoignage (petite histoire imaginée). Affirmations vraies pour l'app uniquement : suivi du livreur en direct sur la carte, notifications à chaque étape, code de livraison remis au livreur, prix affiché avant de valider, livreurs vérifiés.",
    sujet ? "Sujet demandé : " + sujet : "Choisis un sujet différent des précédents.",
    "Histoires déjà faites (ne les répète pas) :\n" + deja,
    'Réponds UNIQUEMENT par un objet JSON valide : {"titre":"","format":"16:9","scenes":[{"type":"titre","fond":"sombre","haut":"","lignes":["",""],"objets":[],"voix":""}]}',
  ].join("\n\n");
  const r = await askGeminiEmail(consigne);
  const brut = r.ok && r.text ? lireObjet(r.text) : null;
  const valide = brut ? validerScenario(brut) : null;
  res.json(valide ? { ok: true, source: "gemini", scenario: valide } : { ok: true, source: "modele", scenario: defaut });
});

studioRouter.post("/video-nouveau", async (req: Request, res: Response) => {
  const sc = validerScenario((req.body as Record<string, unknown> | undefined)?.scenario);
  if (!sc) {
    res.status(422).json({ ok: false, erreur: "Scénario refusé (forme ou règles de marque)." });
    return;
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const refus = await modifierJournal((j) => {
    if (j.filter((e) => e.statut === "en_cours").length >= 3) return "Trois créations sont déjà en cours.";
    j.push({
      id,
      date: new Date().toISOString(),
      semaine: lundiDe(),
      idee: "Vidéo : " + sc.titre,
      structure: "libre",
      genre: "photo",
      titre: sc.titre,
      sous: "",
      type: "video",
      format: "9:16",
      modele: "montage-qg",
      prompt: "",
      cout: 0,
      mode: "reel",
      statut: "en_cours",
      fichier: null,
      note: null,
      gabarit: "histoire",
    });
    return null;
  });
  if (refus) {
    res.status(429).json({ ok: false, erreur: refus });
    return;
  }
  res.json({ ok: true, id });
});

studioRouter.post("/video-fichier", express.raw({ type: ["video/mp4", "video/webm"], limit: "80mb" }), async (req: Request, res: Response) => {
  const id = String(req.query.id || "");
  const corps = req.body as Buffer;
  const mp4 = Boolean(req.headers["content-type"]?.startsWith("video/mp4"));
  const ok = Buffer.isBuffer(corps) && corps.length > 20_000;
  const trouve = ok
    ? await modifierJournal((j) => {
        const e = j.find((x) => x.id === id);
        if (!e || e.gabarit !== "histoire" || e.statut !== "en_cours") return false;
        const fichier = `${e.id}.${mp4 ? "mp4" : "webm"}`;
        fs.mkdirSync(CREATIONS, { recursive: true });
        fs.writeFileSync(path.join(CREATIONS, fichier), corps);
        e.fichier = fichier;
        e.statut = "pret";
        e.legendes = legendes(e);
        return true;
      })
    : false;
  res.status(trouve ? 200 : 400).json({ ok: trouve });
});

studioRouter.post("/video-echec", async (req: Request, res: Response) => {
  const id = String((req.body as Record<string, unknown> | undefined)?.id || "");
  await modifierJournal((j) => {
    const e = j.find((x) => x.id === id && x.gabarit === "histoire" && x.statut === "en_cours");
    if (e) {
      e.statut = "echec";
      e.erreur = "Montage interrompu";
    }
  });
  res.json({ ok: true });
});
