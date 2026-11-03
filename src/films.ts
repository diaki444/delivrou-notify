/**
 * Films animes du QG : le QG ecrit le script, recoit la voix, et un PC fabrique le film.
 *
 * Le serveur n'a ni Chrome ni FFmpeg : il ne rend rien. Il garde l'etat de chaque film
 * (script, voix, statut) et le PC de l'equipe vient chercher les films « a produire »
 * (outils/film-usine.mjs), les rend avec HyperFrames et renvoie le MP4.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { askGeminiEmail, isGeminiConfigured } from "./gemini.js";
import { verifierRegles, tropProche, legendes } from "./studio.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FILMS_DIR = path.join(AUTH_DIR, "qg", "films");

export type Statut = "attente_voix" | "voix_ok" | "a_produire" | "en_production" | "pret" | "echec";
type Scene = { type: string; lignes: string[]; [k: string]: unknown };
export interface Film {
  id: string;
  date: string;
  sujet: string;
  titre: string;
  format: "9:16" | "1:1" | "16:9";
  fond: "photo" | "degrade" | "uni" | "motif";
  /** Variante de fond (ex. « nuit ») et graine : choisies par le serveur pour que deux films ne se ressemblent jamais. */
  variante?: string;
  graine?: string;
  /** Duree visee (secondes de voix) et ton choisis a la creation. */
  duree?: number;
  ton?: string;
  scenes: Scene[];
  statut: Statut;
  voix: boolean;
  fichier?: string;
  erreur?: string;
  maj?: string;
  /** Avancement de la fabrication, renvoye par le PC. */
  progression?: number;
  etape?: string;
  restantS?: number | null;
  debutProd?: string;
}
/** Derniere fois que le PC de fabrication est venu regarder le QG (memoire du serveur). */
let dernierPassagePc = 0;

const dossier = (id: string) => path.join(FILMS_DIR, id.replace(/[^a-z0-9-]/gi, ""));
const lire = (id: string): Film | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dossier(id), "job.json"), "utf8")) as Film;
  } catch {
    return null;
  }
};
const ecrire = (f: Film) => {
  fs.mkdirSync(dossier(f.id), { recursive: true });
  f.maj = new Date().toISOString();
  fs.writeFileSync(path.join(dossier(f.id), "job.json"), JSON.stringify(f, null, 2));
};
const tous = (): Film[] => {
  if (!fs.existsSync(FILMS_DIR)) return [];
  return fs
    .readdirSync(FILMS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => lire(d.name))
    .filter((f): f is Film => Boolean(f))
    .sort((a, b) => b.date.localeCompare(a.date));
};

// ───────────── Bibliotheque des vraies captures de l'appli (deposee par deploy-qg) ─────────────
interface Zone { id: string; label: string; saisie?: { px: number } }
interface Capture { id: string; titre: string; quoi: string; theme: string; zones: Zone[] }
let cacheBib: { t: number; liste: Capture[] } = { t: 0, liste: [] };
function bibliotheque(): Capture[] {
  const f = path.join(AUTH_DIR, "qg", "ecrans-app", "ecrans.json");
  try {
    const t = fs.statSync(f).mtimeMs;
    if (t !== cacheBib.t) cacheBib = { t, liste: (JSON.parse(fs.readFileSync(f, "utf8")) as { ecrans: Capture[] }).ecrans };
  } catch {
    cacheBib = { t: 0, liste: [] };
  }
  return cacheBib.liste;
}

// ───────────── Fonds : jamais deux films avec le meme fond ─────────────
const COMBOS: Array<[Film["fond"], string]> = [["photo", ""], ["degrade", "orange"], ["degrade", "nuit"], ["degrade", "braise"], ["degrade", "aube"], ["motif", "points"], ["motif", "lignes"], ["motif", "grille"], ["motif", "cercles"], ["uni", "ink"], ["uni", "nuit"], ["uni", "braise"], ["uni", "orange"]];
function choisirFond(recents: Film[]): { fond: Film["fond"]; variante: string } {
  const usages = new Map<string, number>(COMBOS.map(([f, v]) => [f + ":" + v, 0]));
  recents.slice(0, 8).forEach((r, i) => { const k = r.fond + ":" + (r.variante ?? ""); if (usages.has(k)) usages.set(k, (usages.get(k) || 0) + (8 - i)); });
  const min = Math.min(...usages.values());
  const libres = COMBOS.filter(([f, v]) => usages.get(f + ":" + v) === min);
  const [fond, variante] = libres[crypto.randomInt(libres.length)];
  return { fond, variante };
}

// ───────────── Vocabulaire des scenes : combien de phrases de voix chacune consomme ─────────────
const NB_LIGNES: Record<string, (s: Scene) => number> = {
  accroche: () => 4, bulles: () => 2, champ: (s) => 2 + (Array.isArray(s.puces) ? Math.min(3, s.puces.length) : 0), carte: () => 3,
  paiement: (s) => 3 + (Array.isArray(s.pastilles) ? Math.min(3, s.pastilles.length) : 0), livreur: () => 4, code: () => 4, fin: () => 4,
  ecran: (s) => (Array.isArray(s.etapes) ? Math.min(4, s.etapes.length) : 0),
};
const OBJETS = ["colis", "repere", "scooter", "telephone", "coche", "bulle", "bouclier", "cloche", "enveloppe"];
const PERSOS = ["per-livreur2", "per-maman", "per-jeune-femme"];
const VIGNETTES = ["th-marche", "th-ville", "th-rue"];
const FINALE: Scene = { type: "fin", lignes: ["Delivrou,", "vite fait.", "Télécharge l'app", "sur delivrou.com."], url: "www.delivrou.com", sousTitres: false };

export const SUJETS: Array<{ id: string; titre: string; note: string }> = [
  { id: "colis", titre: "Envoyer un colis en 4 étapes", note: "Le film modèle, avec le texte déjà validé." },
  { id: "points", titre: "Les Deli-points et le parrainage", note: "Inviter un ami : 50 points pour toi, 50 pour lui. 1 point = 100 GNF." },
  { id: "emballage", titre: "Bien emballer son colis", note: "Astuces : emballer, décrire, photographier le colis." },
  { id: "suivi", titre: "Suivre son colis en direct", note: "Le suivi sur la carte, le livreur vérifié, les codes." },
  { id: "libre", titre: "Autre sujet (je le décris)", note: "Décris l'idée en une phrase." },
];

/** Scènes qui ont un sens pour chaque sujet (le code de livraison et le livreur ne vont pas dans un film sur le parrainage). */
const SCENES_PERMISES: Record<string, string[]> = {
  points: ["bulles", "champ", "carte", "paiement", "ecran"],
  emballage: ["bulles", "champ", "carte", "ecran"],
  suivi: ["bulles", "champ", "livreur", "code", "ecran"],
  libre: ["bulles", "champ", "carte", "paiement", "livreur", "code", "ecran"],
};
const PRESET_COLIS: Scene[] = [
  { type: "accroche", lignes: ["À Conakry,", "personne n'a d'adresse.", "Alors,", "comment on envoie un colis ?"], split: 2, objet: "colis", fond: "rue", sousTitres: false },
  { type: "bulles", lignes: ["Avant, c'étaient des appels, des explications…", "et un livreur qui tourne en rond."], fond: "quartier", etiquette: "AVANT", messages: [{ de: "in", texte: "Tu es où ?" }, { de: "out", texte: "Près du marché…" }, { de: "in", texte: "Quel marché ?" }, { de: "out", texte: "Je suis devant." }, { de: "in", texte: "Devant quoi ?" }], appel: "Appel manqué", objet: "scooter", symbole: "?" },
  { type: "champ", lignes: ["Avec Delivrou,", "un point de repère suffit.", "Un marché,", "un hôtel,", "un carrefour connu."], fond: "marche", titre: "Delivrou", label: "POINT DE REPÈRE DÉPART *", valeur: "Marché de Madina", aide: "Pas d'adresse postale ? Un repère suffit.", puces: [{ texte: "Un marché", vignette: "th-marche" }, { texte: "Un hôtel", vignette: "th-ville" }, { texte: "Un carrefour connu", vignette: "th-rue" }] },
  { type: "carte", lignes: ["Tu ajoutes ton destinataire,", "et une photo du colis.", "C'est ta preuve en cas de dommage."], fond: "bureau", carte1: { label: "NOM DU DESTINATAIRE *", valeur: "Mamadou Diallo", note: "Il n'a pas besoin de compte." }, carte2: { label: "PHOTO DU COLIS * (PREUVE EN CAS DE DOMMAGE)", objet: "colis" }, tampon: "Preuve" },
  { type: "paiement", lignes: ["Tu paies en mobile money :", "Orange Money,", "MoMo", "ou carte.", "Le prix s'affiche", "avant que tu valides."], fond: "nuit", etiquette: "MODE DE PAIEMENT", option: { tag: "RECOMMANDÉ", titre: "Paiement mobile", sous: "Orange Money, MoMo, carte" }, pastilles: [{ texte: "Orange Money", couleur: "or", icone: "tel" }, { texte: "MoMo", couleur: "jaune" }, { texte: "Carte", couleur: "creme", icone: "carte" }], prix: "Prix affiché avant de valider", bouton: "Payer", ok: "Commande reçue" },
  { type: "livreur", lignes: ["Un livreur vérifié part.", "Et toi,", "tu le suis en direct,", "sur la carte."], fond: "ville", persona: "per-livreur2", pill: "Livreur vérifié", notif: { titre: "Ton livreur est en route", sous: "Suivi en direct" } },
  { type: "code", lignes: ["À l'arrivée,", "un code de livraison :", "le colis n'est remis", "qu'à la bonne personne."], fond: "rue", etiquette: "CODE DE LIVRAISON", chiffres: ["4", "8", "2", "7"], personne: { image: "per-maman", texte: "Remis à la bonne personne" } },
  FINALE,
];

// ───────────── Validation d'un script ecrit par l'IA ─────────────
const court = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
function nettoyer(brut: unknown, permises: string[] = Object.keys(NB_LIGNES)): { scenes: Scene[]; erreurs: string[] } {
  const erreurs: string[] = [];
  const arr = Array.isArray(brut) ? brut : [];
  const scenes: Scene[] = [];
  const vus = new Set<string>();
  for (const x of arr as Array<Record<string, unknown>>) {
    const type = String(x?.type ?? "");
    if (type === "ecran") {
      const cap = bibliotheque().find((c) => c.id === String(x.image));
      const etapes = (Array.isArray(x.etapes) ? x.etapes : []).slice(0, 4).map((e0) => {
        const e1 = (e0 ?? {}) as Record<string, unknown>;
        const zone = cap?.zones.find((z) => z.id === String(e1.zone)) ?? cap?.zones[0];
        return { zone: zone?.id ?? "", zoom: Math.max(1, Math.min(2.2, Number(e1.zoom) || 1.6)), ...(zone?.saisie && e1.saisie ? { saisie: court(e1.saisie, 34) } : {}) };
      });
      const lignes = (Array.isArray(x.lignes) ? x.lignes : []).map((l) => court(l, 70)).filter(Boolean);
      if (!cap || etapes.length < 2 || lignes.length !== etapes.length) { erreurs.push("« ecran » invalide (image inconnue ou nombre de lignes différent des étapes)"); continue; }
      if (scenes.filter((q) => q.type === "ecran").length >= 3 || !permises.includes("ecran")) continue;
      scenes.push({ type: "ecran", lignes, image: cap.id, etapes });
      continue;
    }
    if (!NB_LIGNES[type] || type === "fin" || vus.has(type) || (type !== "accroche" && !permises.includes(type))) continue;
    vus.add(type);
    const s: Scene = { ...x, type, lignes: (Array.isArray(x.lignes) ? x.lignes : []).map((l) => court(l, 70)).filter(Boolean) };
    if (s.objet !== undefined && !OBJETS.includes(String(s.objet))) s.objet = "colis";
    if (type === "champ") s.puces = (Array.isArray(x.puces) ? x.puces : []).slice(0, 3).map((p) => ({ texte: court((p as Record<string, unknown>)?.texte, 28), vignette: VIGNETTES.includes(String((p as Record<string, unknown>)?.vignette)) ? (p as Record<string, unknown>).vignette : "th-rue" }));
    if (type === "paiement") s.pastilles = (Array.isArray(x.pastilles) ? x.pastilles : []).slice(0, 3).map((p) => ({ texte: court((p as Record<string, unknown>)?.texte, 18), couleur: ["or", "jaune", "creme"].includes(String((p as Record<string, unknown>)?.couleur)) ? (p as Record<string, unknown>).couleur : "creme", icone: ["tel", "carte", ""].includes(String((p as Record<string, unknown>)?.icone)) ? (p as Record<string, unknown>).icone : "" }));
    if (type === "bulles") s.messages = (Array.isArray(x.messages) ? x.messages : []).slice(0, 5).map((m) => ({ de: (m as Record<string, unknown>)?.de === "out" ? "out" : "in", texte: court((m as Record<string, unknown>)?.texte, 22) }));
    if (type === "livreur" && !PERSOS.includes(String(s.persona))) s.persona = "per-livreur2";
    if (type === "code") {
      s.etiquette = "CODE DE LIVRAISON";
      s.chiffres = ["4", "8", "2", "7"]; // exemple de code : jamais un chiffre qui ressemble à un montant
      const pe = (x.personne ?? {}) as Record<string, unknown>;
      s.personne = { image: PERSOS.includes(String(pe.image)) ? pe.image : "per-maman", texte: court(pe.texte, 34) };
    }
    const n = NB_LIGNES[type](s);
    if (s.lignes.length !== n) { erreurs.push(`« ${type} » doit avoir ${n} phrases de voix (reçu ${s.lignes.length})`); continue; }
    scenes.push(s);
  }
  return { scenes, erreurs };
}

/** Tons proposes dans le QG : consigne pour l'IA + conseil de reglage ElevenLabs. */
export const TONS: Record<string, { nom: string; ia: string; voix: string }> = {
  chaleureux: { nom: "Chaleureux", ia: "chaleureux et rassurant, comme un grand frère de confiance", voix: "Voix posée et souriante. Stabilité ≈ 50 %." },
  enthousiaste: { nom: "Enthousiaste", ia: "plein d'énergie et d'enthousiasme, ça respire la bonne nouvelle, quelques exclamations", voix: "Voix dynamique. Stabilité ≈ 30 %, style élevé. Tu peux mettre [excited] au début des phrases fortes dans ElevenLabs (modèle v3)." },
  drole: { nom: "Drôle", ia: "drôle : une situation de la vie à Conakry exagérée avec tendresse, une chute ou un petit retournement, humour léger jamais moqueur (ni religion, ni ethnie, ni personne réelle)", voix: "Voix expressive. Stabilité ≈ 25 %, style élevé. Dans ElevenLabs (modèle v3) tu peux ajouter [laughs] ou [chuckles] aux bons endroits : à NE PAS écrire dans la vidéo, seulement dans ElevenLabs." },
  rigolo: { nom: "Rigolo", ia: "rigolo et complice, comme entre amis : taquineries gentilles, expressions parlées de Conakry, rythme vif", voix: "Voix joueuse. Stabilité ≈ 25 %. Dans ElevenLabs (modèle v3) : [laughs] ou [giggles] ponctuels, seulement dans ElevenLabs." },
  rassurant: { nom: "Sérieux et rassurant", ia: "sérieux, calme et rassurant : on parle de confiance, de sécurité, de contrôle", voix: "Voix grave et posée. Stabilité ≈ 65 %." },
  punchy: { nom: "Direct et punchy", ia: "direct et percutant : phrases très courtes, rythme rapide, zéro blabla", voix: "Voix tranchée. Stabilité ≈ 35 %, débit un peu rapide." },
};

function consigne(sujet: string, note: string, recents: string[], permises: string[], duree = 40, ton = "chaleureux"): string {
  const t = TONS[ton] ?? TONS.chaleureux;
  const mots = Math.round(duree * 2.6);
  const nbScenes = duree <= 25 ? "3 à 4" : duree <= 45 ? "4 à 6" : "6 à 9";
  return [
    `Tu écris le script d'un film court d'environ ${duree} secondes de voix (environ ${mots} mots en tout, toutes les lignes confondues) pour Facebook et TikTok, pour Delivrou, service de livraison de COLIS à Conakry. Une voix off lit tout le texte ; l'image est du motion design.`,
    `SUJET : ${sujet}. ${note}`,
    `TON DU FILM : ${t.ia}. Ce ton se sent dès la première ligne et jusqu'au bout. Tutoiement, français simple de Conakry, phrases courtes.`,
    "HOOK PARFAIT (le plus important) : les 3 premières secondes (scène accroche) doivent arrêter le pouce. Une vraie situation vécue, une question qui pique, une contradiction ou une petite blague, dans le ton choisi. Jamais « Salut », « Bonjour », « Bienvenue », « Découvrez », ni un slogan. L'accroche doit donner envie de connaître la suite.",
    `Scènes autorisées pour CE sujet (et seulement celles-là, en plus de « accroche ») : ${permises.join(", ")}. Choisis les plus pertinentes ; n'utilise pas une scène si elle ne correspond pas au sujet. Les captures d'écran de l'appli (scène « ecran ») sont préférées aux dessins quand elles illustrent le sujet.`,
    `Le film suit une suite de scènes choisies parmi celles-ci (chacune une seule fois sauf « ecran », ${nbScenes} scènes au total, la première est toujours « accroche »). Chaque scène a un nombre EXACT de phrases de voix dans le champ lignes (une phrase ou un morceau de phrase par ligne, de 2 à 9 mots, la ponctuation reste dans la ligne) :`,
    '• accroche (4 lignes) : l\'accroche. Lignes 1 et 2 = la première partie (ex. « À Conakry, » / « personne n\'a d\'adresse. »), lignes 3 et 4 = la question (ex. « Alors, » / « comment on envoie un colis ? »). Champs : objet (colis|repere|scooter|telephone|coche|bulle|bouclier|cloche|enveloppe).',
    '• bulles (2 lignes) : le « avant », des messages qui s\'empilent. Champs : etiquette (ex. "AVANT"), messages (exactement 5 {de:"in"|"out", texte ≤ 22 caractères}), appel (ex. "Appel manqué"), objet, symbole ("?").',
    '• champ (5 lignes si 3 puces) : un champ de formulaire qui se remplit, puis 3 puces cochées une par ligne (lignes 3, 4, 5). Champs : titre, label (en MAJUSCULES, ex. "POINT DE REPÈRE DÉPART *"), valeur (≤ 24 caractères), aide (≤ 60), puces (3 {texte ≤ 22, vignette: th-marche|th-ville|th-rue}).',
    '• carte (3 lignes) : une carte avec un champ et une photo du colis. Champs : carte1 {label, valeur, note}, carte2 {label, objet}, tampon (1 mot).',
    '• paiement (6 lignes avec 3 pastilles) : mode de paiement. Champs : etiquette, option {tag, titre, sous}, pastilles (3 {texte, couleur: or|jaune|creme, icone: tel|carte|""}), prix (ex. "Prix affiché avant de valider"), bouton, ok.',
    '• livreur (4 lignes) : le livreur vérifié et le suivi sur la carte. Champs : persona (per-livreur2|per-maman|per-jeune-femme), pill, notif {titre, sous}.',
    '• code (4 lignes) : le code de livraison puis la remise à la bonne personne. Champs : etiquette, chiffres (4 chiffres), personne {image: per-maman|per-livreur2|per-jeune-femme, texte}.',
    `• ecran (2 à 4 lignes, une par étape) : une VRAIE capture de l'appli, avec zoom sur une zone, mise en valeur, curseur qui clique et parfois du texte qui s'écrit dans un champ vide. Champs : image (un id de la liste ci-dessous), etapes (une par ligne de voix : {zone: id de zone, saisie?: texte à écrire seulement si la zone est marquée [saisie] (≤ 30 caractères), zoom?: 1 à 2}). Utilise 1 à 3 scènes « ecran » : c'est la preuve visuelle que l'appli fait bien ce que dit la voix. Plusieurs scènes ecran peuvent utiliser des images différentes.`,
    "CAPTURES DISPONIBLES (id : ce que l'écran montre ; zones) :\n" + bibliotheque().map((c) => `- ${c.id} : ${c.quoi} Zones : ${c.zones.map((z) => z.id + (z.saisie ? " [saisie]" : "")).join(", ")}.`).join("\n"),
    "La scène finale « fin » est ajoutée automatiquement : n'écris pas la conclusion et ne mets pas d'appel à télécharger.",
    "RÈGLES STRICTES : le seul service disponible est le COLIS (jamais repas, pharmacie, épicerie) ; aucun délai chiffré ni prix ; aucune promesse de rapidité (jamais « vite », « rapide », « express ») ; aucun chiffre inventé (sauf ceux confirmés : 50 Deli-points par parrainage = 5 000 GNF, 1 point = 100 GNF) ; pas de paiement en espèces ; aucune fausse urgence ; pas de concours ni tirage au sort ; rien de religieux ; pas de faux avis ni témoignage. Les phrases doivent être vraies : coursiers vérifiés, point de repère, photo du colis (preuve), prix affiché avant de valider, paiement mobile, suivi en direct, code de retrait et de livraison.",
    recents.length ? `Accroches déjà utilisées (n'en répète ni les mots ni l'idée, trouve un autre angle) :\n${recents.map((r) => "- " + r).join("\n")}` : "",
    'Réponds UNIQUEMENT par un objet JSON valide : {"titre":"","scenes":[{"type":"accroche","lignes":["","","",""],"objet":"colis"}, {"type":"ecran","lignes":["",""],"image":"envoi-depart","etapes":[{"zone":"commune","saisie":"Kaloum"},{"zone":"suivant"}]}, ...]}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extraire(texte: string): Record<string, unknown> | null {
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

const toutesLesLignes = (scenes: Scene[]) => scenes.flatMap((s) => s.lignes);
export const texteVoix = (scenes: Scene[]) => scenes.map((s) => s.lignes.join(" ")).join("\n\n");

// ───────────── Routes protegees par le mot de passe du QG ─────────────
export const filmsRouter = express.Router();

filmsRouter.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, films: tous().map((f) => ({ ...f, texte: texteVoix(f.scenes), conseilVoix: TONS[f.ton ?? ""]?.voix ?? "" })), tons: Object.entries(TONS).map(([id, t]) => ({ id, nom: t.nom })), sujets: SUJETS, ia: isGeminiConfigured(), pcVuIlYA: dernierPassagePc ? Math.round((Date.now() - dernierPassagePc) / 1000) : null });
});

/** Ecrit le script d'un nouveau film (le sujet « colis » reprend le texte valide). */
filmsRouter.post("/script", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const sujetId = court(b.sujet, 40);
  const format = ["9:16", "1:1", "16:9"].includes(String(b.format)) ? (String(b.format) as Film["format"]) : "9:16";
  let fond = ["photo", "degrade", "uni", "motif"].includes(String(b.fond)) ? (String(b.fond) as Film["fond"]) : "photo";
  let variante = "";
  if (String(b.fond) === "auto" || !b.fond) ({ fond, variante } = choisirFond(tous()));
  const preset = SUJETS.find((s) => s.id === sujetId);
  const libre = court(b.libre, 200);
  const duree = Math.max(15, Math.min(90, Math.round(Number(b.duree) || 40)));
  const ton = TONS[String(b.ton)] ? String(b.ton) : "chaleureux";
  let titre = preset?.titre ?? libre ?? "Film";
  let scenes: Scene[];
  if (sujetId === "colis") {
    scenes = PRESET_COLIS;
  } else {
    if (!isGeminiConfigured()) {
      res.status(503).json({ ok: false, erreur: "L'IA n'est pas configurée sur le serveur (GEMINI_API_KEY)." });
      return;
    }
    if (sujetId === "libre" && libre.length < 8) {
      res.status(400).json({ ok: false, erreur: "Décris le sujet en une phrase." });
      return;
    }
    const recents = tous().slice(0, 8).map((f) => f.scenes[0]?.lignes.join(" ") ?? "").filter(Boolean);
    let ok: Scene[] | null = null;
    let dernier = "";
    for (let essai = 0; essai < 3 && !ok; essai++) {
      const r = await askGeminiEmail(consigne(sujetId === "libre" ? libre : (preset?.titre ?? libre), preset?.note ?? "", recents, SCENES_PERMISES[sujetId] ?? SCENES_PERMISES.libre, duree, ton));
      const o = r.ok && r.text ? extraire(r.text) : null;
      if (!o) { dernier = r.error || "Réponse illisible."; continue; }
      const { scenes: sc, erreurs } = nettoyer(o.scenes, SCENES_PERMISES[sujetId] ?? SCENES_PERMISES.libre);
      if (sc.length < 3 || sc[0].type !== "accroche") { dernier = erreurs[0] || "Il faut au moins 3 scènes et une accroche."; continue; }
      const textes = JSON.stringify(sc.map((s) => ({ ...s, type: undefined })));
      const alertes = verifierRegles(textes);
      if (alertes.length) { dernier = alertes[0]; continue; }
      if (recents.some((r2) => tropProche(r2, sc[0].lignes.join(" ")))) { dernier = "Accroche trop proche d'une récente."; continue; }
      titre = court(o.titre, 80) || titre;
      ok = [...sc, FINALE];
    }
    if (!ok) {
      res.status(422).json({ ok: false, erreur: "Le script n'a pas pu être écrit : " + dernier });
      return;
    }
    scenes = ok;
  }
  const film: Film = { id: `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`, date: new Date().toISOString(), sujet: sujetId || "libre", titre, format, fond, variante, graine: crypto.randomBytes(4).toString("hex"), duree, ton, scenes, statut: "attente_voix", voix: false };
  ecrire(film);
  res.json({ ok: true, film: { ...film, texte: texteVoix(film.scenes) } });
});

/** Depose la voix du film (mp3 ou wav). */
filmsRouter.put("/:id/voix", express.raw({ type: "*/*", limit: "30mb" }), (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false, erreur: "Film inconnu" }); return; }
  if (!Buffer.isBuffer(req.body) || req.body.length < 2000) { res.status(400).json({ ok: false, erreur: "Fichier audio vide ou trop petit" }); return; }
  fs.writeFileSync(path.join(dossier(f.id), "voix.mp3"), req.body);
  f.voix = true;
  if (f.statut === "attente_voix" || f.statut === "echec") f.statut = "voix_ok";
  delete f.erreur;
  ecrire(f);
  res.json({ ok: true });
});

/** Legendes Facebook / TikTok du film (accroche, question, hashtags), pour la programmation. */
filmsRouter.get("/:id/legendes", (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false, erreur: "Film inconnu" }); return; }
  const l = legendes({ id: f.id, titre: f.titre, sous: f.scenes[0]?.lignes.join(" ") ?? "", idee: texteVoix(f.scenes), pilier: undefined });
  res.json({ ok: true, facebook: l.facebook, tiktok: l.tiktok });
});

/**
 * Retouche un film termine.
 * - sans consigne : meme script et meme voix, nouveau fond (ou fond / format demande) : refabrique direct ;
 * - avec consigne : l'IA reecrit le script, il faut une nouvelle voix.
 */
filmsRouter.post("/:id/refaire", express.json({ limit: "8kb" }), async (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false, erreur: "Film inconnu" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const demande = court(b.consigne, 400);
  const format = ["9:16", "1:1", "16:9"].includes(String(b.format)) ? (String(b.format) as Film["format"]) : f.format;
  let { fond, variante } = choisirFond(tous());
  if (["photo", "degrade", "uni", "motif"].includes(String(b.fond))) { fond = String(b.fond) as Film["fond"]; variante = ""; }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const base: Film = { id, date: new Date().toISOString(), sujet: f.sujet, titre: f.titre, duree: f.duree, ton: f.ton, format, fond, variante, graine: crypto.randomBytes(4).toString("hex"), scenes: f.scenes, statut: "attente_voix", voix: false };
  if (!demande) {
    fs.mkdirSync(dossier(id), { recursive: true });
    const v = path.join(dossier(f.id), "voix.mp3");
    if (!fs.existsSync(v)) { res.status(400).json({ ok: false, erreur: "Ce film n'a pas de voix." }); return; }
    fs.copyFileSync(v, path.join(dossier(id), "voix.mp3"));
    base.voix = true;
    base.statut = "a_produire";
    ecrire(base);
    res.json({ ok: true, film: base, ia: false });
    return;
  }
  if (!isGeminiConfigured()) { res.status(503).json({ ok: false, erreur: "L'IA n'est pas configurée sur le serveur." }); return; }
  const permises = SCENES_PERMISES[f.sujet] ?? SCENES_PERMISES.libre;
  const note = `MODIFIE un script existant selon cette demande de l'équipe : « ${demande} ». Script actuel (JSON) : ${JSON.stringify(f.scenes.map((s) => ({ ...s, type: s.type })))}. Garde ce qui n'est pas concerné par la demande.`;
  let ok: Scene[] | null = null;
  let dernier = "";
  for (let essai = 0; essai < 3 && !ok; essai++) {
    const r = await askGeminiEmail(consigne(f.titre, note, [], permises, f.duree ?? 40, f.ton ?? "chaleureux"));
    const o = r.ok && r.text ? extraire(r.text) : null;
    if (!o) { dernier = r.error || "Réponse illisible."; continue; }
    const { scenes: sc, erreurs } = nettoyer(o.scenes, permises);
    if (sc.length < 3 || sc[0].type !== "accroche") { dernier = erreurs[0] || "Il faut au moins 3 scènes et une accroche."; continue; }
    const alertes = verifierRegles(JSON.stringify(sc.map((s) => ({ ...s, type: undefined }))));
    if (alertes.length) { dernier = alertes[0]; continue; }
    ok = [...sc, FINALE];
    base.titre = court(o.titre, 80) || f.titre;
  }
  if (!ok) { res.status(422).json({ ok: false, erreur: "La modification n'a pas pu être écrite : " + dernier }); return; }
  base.scenes = ok;
  ecrire(base);
  res.json({ ok: true, film: { ...base, texte: texteVoix(base.scenes) }, ia: true });
});

/** Demande la fabrication : le PC viendra le chercher. */
filmsRouter.post("/:id/produire", (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false, erreur: "Film inconnu" }); return; }
  if (!f.voix) { res.status(400).json({ ok: false, erreur: "Dépose d'abord la voix." }); return; }
  f.statut = "a_produire";
  delete f.erreur;
  ecrire(f);
  res.json({ ok: true });
});

filmsRouter.post("/:id/supprimer", (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false, erreur: "Film inconnu" }); return; }
  fs.rmSync(dossier(f.id), { recursive: true, force: true });
  res.json({ ok: true });
});

// ───────────── Routes machine (cle partagee), pour le PC qui fabrique ─────────────
export const filmsMachineRouter = express.Router();

filmsMachineRouter.get("/a-produire", (_req, res) => {
  res.set("Cache-Control", "no-store");
  dernierPassagePc = Date.now();
  res.json({ ok: true, films: tous().filter((f) => f.statut === "a_produire").map((f) => ({ id: f.id, titre: f.titre, format: f.format, fond: f.fond, variante: f.variante ?? "", graine: f.graine ?? f.id, scenes: f.scenes })) });
});
filmsMachineRouter.get("/:id/voix", (req, res) => {
  const f = lire(String(req.params.id));
  const p = f ? path.join(dossier(f.id), "voix.mp3") : "";
  if (!f || !fs.existsSync(p)) { res.status(404).json({ ok: false }); return; }
  res.type("audio/mpeg").sendFile(p);
});
filmsMachineRouter.post("/:id/statut", express.json({ limit: "16kb" }), (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const st = String(b.statut);
  if (!["en_production", "pret", "echec"].includes(st)) { res.status(400).json({ ok: false }); return; }
  f.statut = st as Statut;
  dernierPassagePc = Date.now();
  if (st === "en_production") { f.debutProd = new Date().toISOString(); f.progression = 0; f.etape = "Démarrage"; f.restantS = null; }
  if (st === "pret") { f.progression = 100; f.etape = "Terminé"; f.restantS = 0; }
  if (st === "pret") { f.fichier = `films/${f.id}/film.mp4`; delete f.erreur; }
  if (st === "echec") f.erreur = court(b.erreur, 300);
  ecrire(f);
  res.json({ ok: true });
});

/** Avancement en direct : pourcentage, etape et temps restant estime. */
filmsMachineRouter.post("/:id/progression", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
  const f = lire(String(req.params.id));
  if (!f) { res.status(404).json({ ok: false }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  dernierPassagePc = Date.now();
  f.progression = Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0)));
  f.etape = court(b.etape, 80);
  f.restantS = b.restantS === null || b.restantS === undefined ? null : Math.max(0, Math.round(Number(b.restantS) || 0));
  ecrire(f);
  res.json({ ok: true });
});

export const _test = { nettoyer, toutesLesLignes };
