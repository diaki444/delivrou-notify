/**
 * Storyboard des films « faits main » (moteur film2 du PC, delivrou-premium/film2.mjs).
 *
 * Gemini n'ecrit plus une suite de scenes generiques : il ecrit un storyboard phrase par phrase
 * (plan, personnage, gestes, accessoires, evenements, chacun cale sur un mot de la phrase),
 * en se limitant aux briques que le moteur sait dessiner. Ce catalogue est la copie de
 * delivrou-premium/film2/briques.mjs (CATALOGUE) : les deux doivent rester identiques.
 */

export const CATALOGUE2 = {
  plans: {
    perso: "un personnage sur fond sombre, les accessoires apparaissent autour de lui",
    salon: "le personnage dans son fauteuil, chez lui (sieste, radio, attente)",
    telephone: "un téléphone : messages qui arrivent, appel, appels manqués, batterie vide ; le personnage à côté",
    ecran: "une VRAIE capture de l'appli Delivrou dans un téléphone : zones entourées, curseur qui clique, zoom",
    livraison: "devant la porte : le livreur arrive en scooter, le code est donné, le colis est remis",
    trajet: "un plan de la ville : la route se trace entre deux repères, le scooter la suit",
  },
  persos: { tonton: "un tonton âgé, boubou, chapeau", fode: "Fodé, un jeune homme", livreur: "le livreur Delivrou (gilet orange)", aucun: "pas de personnage" },
  gestes: {
    entre: "arrive par la gauche", sort: "sort par la gauche", parle: "parle (bouche) jusqu'à la fin de la phrase",
    fronce: "fronce les sourcils", etonne: "lève les sourcils, surpris", triste: "sourcils tristes", sourit: "grand sourire",
    cligne: "cligne des yeux", saute: "petit saut", joie: "bras en l'air et sautille", tend: "tend le bras, montre",
    revers: "revers de main (balaie un objet)", hausse: "hausse les épaules", supplie: "joint les mains, supplie",
    penche: "penche la tête", oreille: "porte la main à l'oreille (téléphone)", tate: "tâte ses poches",
    dort: "s'endort (yeux fermés, z qui montent)", reveil: "se réveille, ouvre un œil", soulage: "souffle, soulagé",
    transpire: "une goutte de sueur", pouce: "lève le pouce",
  },
  accessoires: {
    colis: "un colis en carton", repere: "un repère de carte (avec texte : le nom du lieu)", smartphone: "un smartphone",
    vieux: "un vieux téléphone à touches", ampoule: "une ampoule (idée)", compte: "un compte utilisateur (à barrer)",
    cles: "un trousseau de clés", maison: "une maison", bouclier: "un bouclier vérifié", pouce: "un pouce levé",
    radio: "une vieille radio", scooter: "un scooter", interro: "un grand point d'interrogation", exclam: "un grand point d'exclamation",
    coche: "une coche verte", croix: "une croix rouge", logo: "le logo Delivrou", bulle: "une bulle de parole (avec texte, 4 mots max)",
    etiquette: "une étiquette (avec texte, 3 mots max)",
  },
  effets: {
    apparait: "apparaît avec un rebond", tombe: "tombe du haut et rebondit", glisse: "glisse depuis la droite",
    tampon: "s'écrase comme un tampon", vole: "s'envole hors du cadre", tremble: "tremble", sonne: "sonne et vibre",
    barre: "se fait barrer en rouge", allume: "s'allume (ampoule)", sort: "disparaît",
  },
  evenements: {
    telephone: { message: "un message arrive (de: in|out, texte ≤ 30 caractères)", appel: "un appel sort (nom)", manque: "un appel manqué s'affiche", batterie: "la batterie se vide, l'écran s'éteint" },
    ecran: { ouvre: "l'appli s'ouvre depuis l'écran d'accueil", zone: "une zone de la capture est entourée et cochée (zone)", clic: "le curseur clique sur une zone (zone)", zoom: "la caméra zoome sur une zone (zone)" },
    livraison: { arrive: "le livreur arrive en scooter", code: "le code de livraison est dit et s'affiche", remet: "le colis passe au destinataire", tampon: "tampon « Livré »" },
    trajet: { route: "la route se trace, le scooter la suit", arrivee: "le repère d'arrivée tombe" },
  },
} as const;

type Obj = Record<string, unknown>;
export interface Action { mot: string; [k: string]: unknown }
export interface Phrase {
  texte: string;
  /** Texte pour ElevenLabs, avec les balises de rire, s'il differe. */
  voix?: string;
  plan: string;
  perso: string;
  accent?: string[];
  gestes?: Action[];
  accessoires?: Action[];
  evenements?: Action[];
  ecran?: string;
  contact?: string;
  depart?: string;
  arrivee?: string;
  cta?: string;
  camera?: string;
}
export interface Storyboard { titre: string; phrases: Phrase[] }
export interface CaptureInfo { id: string; titre: string; quoi: string; zones: Array<{ id: string; label: string }> }

const court = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const sansBalises = (l: string) => l.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
const lettres = (s: string) => s.normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Captures utilisables dans un film colis (pas les services « bientot »). */
export const capturesFilm = (liste: CaptureInfo[]) => liste.filter((c) => !c.id.startsWith("bientot"));

/** Fin parlee et dessinee par le moteur (logo, slogan, bouton). */
export function finale2(cta?: string): Phrase[] {
  if (cta) return [{ texte: "Delivrou, vite fait.", plan: "fin", perso: "aucun" }, { texte: `Commente ${cta} pour recevoir le lien.`, plan: "fin", perso: "aucun", cta: `Commente ${cta}` }];
  return [{ texte: "Delivrou, vite fait.", plan: "fin", perso: "aucun" }, { texte: "Télécharge l'app sur delivrou.com.", plan: "fin", perso: "aucun", cta: "Télécharge l’app" }];
}

export function consigne2(o: { sujet: string; note: string; recents: string[]; duree: number; mots: number; ton: string; captures: CaptureInfo[]; rire: boolean }): string {
  const C = CATALOGUE2;
  const liste = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => `${k} (${v})`).join(" ; ");
  const nbPhrases = o.duree <= 25 ? "5 à 7" : o.duree <= 45 ? "7 à 10" : "10 à 16";
  return [
    `Tu es réalisateur de films animés courts pour Delivrou, service de livraison de COLIS à Conakry. Tu écris le STORYBOARD d'un film d'environ ${o.duree} secondes de voix (environ ${o.mots} mots au total) pour Facebook et TikTok.`,
    `SUJET : ${o.sujet}${o.note ? "\nPRÉCISION : " + o.note : ""}`,
    "STYLE : comme un dessin animé fait main. Une petite histoire avec un personnage dessiné qui JOUE la scène : chaque mot important est illustré à l'instant où il est dit (un geste, un objet qui tombe, un message qui arrive). Le texte parlé s'affiche mot par mot. On change de plan seulement entre deux phrases.",
    "HOOK : la 1re phrase (6 à 9 mots) arrête le pouce : une situation vécue à Conakry, une contradiction, une petite blague. Jamais « Salut », « Bonjour », « Découvrez ». Delivrou n'apparaît pas dans la 1re phrase.",
    "HISTOIRE : problème → ironie → solution avec Delivrou (au moins une phrase en plan « ecran » avec une vraie capture, c'est la preuve) → chute. Le personnage est fictif, jamais présenté comme un vrai client : aucun avis, aucune citation de client.",
    `PHRASES : ${nbPhrases} phrases (la fin est ajoutée automatiquement, ne l'écris pas). Chaque phrase fait 4 à 12 mots, se lit d'une traite, et porte UN plan. Deux phrases qui se suivent avec le même plan et le même personnage forment un plan continu (c'est bien : 2 à 3 phrases par plan).`,
    `BRIQUES DISPONIBLES (n'utilise RIEN d'autre, les noms exacts) :\n• plans : ${liste(C.plans)}\n• persos : ${liste(C.persos)}\n• gestes du personnage : ${liste(C.gestes)}\n• accessoires : ${liste(C.accessoires)}\n• effets des accessoires : ${liste(C.effets)}\n• événements par plan : ${Object.entries(C.evenements).map(([p, e]) => `${p} → ${liste(e)}`).join(" | ")}`,
    `CAPTURES DE L'APPLI pour le plan « ecran » (champ ecran = id, et les zones utilisables pour les événements zone, clic, zoom) :\n${o.captures.map((c) => `- ${c.id} : ${c.quoi || c.titre} (zones : ${c.zones.map((z) => z.id).join(", ")})`).join("\n")}`,
    "CALAGE : dans gestes, accessoires et evenements, « mot » est UN mot exact de la phrase (recopié tel quel), celui sur lequel l'action doit tomber. 1 à 3 actions par phrase, sur des mots différents, réparties dans la phrase. Un accessoire déjà apparu dans le même plan peut recevoir un autre effet (vole, tremble, sonne, barre, allume, sort). « accent » : 1 ou 2 mots de la phrase à mettre en orange.",
    "CHAMPS PAR PLAN : telephone → contact (nom affiché, ex. « Mon frère ») ; ecran → ecran (id de capture) ; trajet → depart et arrivee (vrais quartiers ou repères de Conakry) ; camera: \"rapproche\" (facultatif) pousse la caméra vers le personnage.",
    o.rire ? "HUMOUR : un vrai petit sketch, exagéré, qui fait rire (jamais de moquerie méchante, rien sur la religion, l'ethnie, la politique, le physique). Mets 3 à 5 balises de rire en anglais entre crochets ([laughs], [chuckles], [giggles]) dans le champ « voix » de certaines phrases : « voix » = le même texte que « texte » plus les balises. Les balises ne vont jamais dans « texte »." : "",
    "RÈGLES STRICTES : le seul service est le COLIS (jamais repas, pharmacie, épicerie) ; aucun délai chiffré ni prix ; aucune promesse de rapidité (jamais « vite », « rapide », « express ») ; aucun chiffre inventé (sauf 50 Deli-points par parrainage = 5 000 GNF, 1 point = 100 GNF) ; pas de paiement en espèces ; aucune fausse urgence ; pas de concours ; rien de religieux ; pas de faux avis. Les phrases sont vraies : coursiers vérifiés, point de repère, photo du colis (preuve), prix affiché avant de valider, paiement mobile, suivi en direct, code de retrait et de livraison, le destinataire n'a pas besoin de compte.",
    o.recents.length ? `Accroches déjà utilisées (ne reprends ni les mots ni l'idée) :\n${o.recents.map((r) => "- " + r).join("\n")}` : "",
    'Réponds UNIQUEMENT par un objet JSON valide : {"titre":"","phrases":[{"texte":"Mon tonton de Matoto déteste les smartphones.","plan":"perso","perso":"tonton","accent":["déteste"],"gestes":[{"mot":"tonton","geste":"entre"},{"mot":"déteste","geste":"fronce"}],"accessoires":[{"mot":"Matoto","objet":"repere","effet":"tombe","texte":"Matoto"},{"mot":"smartphones.","objet":"smartphone","effet":"glisse"}]}, {"texte":"Il indique juste la commune et le repère.","plan":"ecran","perso":"fode","ecran":"envoi-depart-rempli","evenements":[{"mot":"commune","quoi":"zone","zone":"commune"},{"mot":"repère.","quoi":"clic","zone":"repere"}]}, ...]}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Garde seulement ce que le moteur sait dessiner ; chaque action doit tomber sur un mot de la phrase. */
export function nettoyer2(brut: unknown, captures: CaptureInfo[]): { phrases: Phrase[]; erreurs: string[] } {
  const erreurs: string[] = [];
  const out: Phrase[] = [];
  for (const x0 of Array.isArray(brut) ? brut : []) {
    const x = obj(x0);
    const texte = court(sansBalises(String(x.texte ?? "")), 140);
    if (!texte || texte.split(/\s+/).length < 2) continue;
    let plan = has(CATALOGUE2.plans, String(x.plan)) ? String(x.plan) : "perso";
    if (x.plan === "fin") continue;
    const perso = has(CATALOGUE2.persos, String(x.perso)) ? String(x.perso) : plan === "trajet" ? "aucun" : "tonton";
    const motsL = texte.split(/\s+/).map(lettres).filter(Boolean);
    const dansPhrase = (m: unknown) => { const l = lettres(String(m ?? "").split(/\s+/)[0] ?? ""); return Boolean(l) && motsL.some((w) => w === l || (l.length > 3 && w.startsWith(l))); };
    const p: Phrase = { texte, plan, perso };
    const voix = court(x.voix, 200);
    if (voix && voix !== texte && sansBalises(voix).toLowerCase() === texte.toLowerCase()) p.voix = voix;
    let cap: CaptureInfo | undefined;
    if (plan === "ecran") {
      cap = captures.find((c) => c.id === String(x.ecran));
      if (!cap) { erreurs.push(`capture inconnue « ${String(x.ecran)} »`); plan = p.plan = "perso"; }
      else p.ecran = cap.id;
    }
    const accent = (Array.isArray(x.accent) ? x.accent : []).filter(dansPhrase).slice(0, 2).map((m) => court(m, 30));
    if (accent.length) p.accent = accent;
    const gestes = (Array.isArray(x.gestes) ? x.gestes : []).map(obj).filter((g) => has(CATALOGUE2.gestes, String(g.geste)) && dansPhrase(g.mot)).slice(0, 3).map((g) => ({ mot: court(g.mot, 30), geste: String(g.geste), ...(g.qui === "livreur" ? { qui: "livreur" } : {}) }));
    if (gestes.length && perso !== "aucun" || gestes.length && plan === "livraison") p.gestes = gestes;
    const accs = (Array.isArray(x.accessoires) ? x.accessoires : []).map(obj).filter((a) => has(CATALOGUE2.accessoires, String(a.objet)) && dansPhrase(a.mot)).slice(0, 4).map((a) => {
      const r: Action = { mot: court(a.mot, 30), objet: String(a.objet), effet: has(CATALOGUE2.effets, String(a.effet)) ? String(a.effet) : "apparait" };
      if (["bulle", "etiquette", "repere"].includes(String(a.objet)) && a.texte) r.texte = court(a.texte, a.objet === "bulle" ? 28 : 20);
      return r;
    });
    if (accs.length) p.accessoires = accs;
    const evDispo = (CATALOGUE2.evenements as Record<string, Record<string, string>>)[plan] ?? {};
    const evs = (Array.isArray(x.evenements) ? x.evenements : []).map(obj).filter((e) => has(evDispo, String(e.quoi)) && dansPhrase(e.mot)).slice(0, 4).flatMap((e) => {
      const r: Action = { mot: court(e.mot, 30), quoi: String(e.quoi) };
      if (plan === "ecran" && ["zone", "clic", "zoom"].includes(String(e.quoi))) {
        if (!cap?.zones.some((z) => z.id === String(e.zone))) return [];
        r.zone = String(e.zone);
      }
      if (e.quoi === "message") { r.de = e.de === "in" ? "in" : "out"; r.texte = court(e.texte, 30); if (!r.texte) return []; }
      if (e.quoi === "appel") r.nom = court(e.nom, 16) || "Maman";
      return [r];
    });
    if (evs.length) p.evenements = evs;
    if (plan === "telephone") p.contact = court(x.contact, 18) || "Messages";
    if (plan === "trajet") { p.depart = court(x.depart, 18) || "Kaloum"; p.arrivee = court(x.arrivee, 18) || "Ratoma"; }
    if (x.camera === "rapproche") p.camera = "rapproche";
    out.push(p);
  }
  return { phrases: out, erreurs };
}

/** Le storyboard vu comme les « scenes » du QG (texte de la voix, une scene par plan continu). */
export function versScenes(phrases: Phrase[]): Array<{ type: string; lignes: string[]; voixBalisee?: string }> {
  const groupes: Array<{ cle: string; phrases: Phrase[] }> = [];
  for (const p of phrases) {
    const cle = [p.plan, p.perso, p.ecran ?? ""].join("|");
    const der = groupes[groupes.length - 1];
    if (der && der.cle === cle) der.phrases.push(p); else groupes.push({ cle, phrases: [p] });
  }
  return groupes.map((g) => ({
    type: g.phrases[0].plan,
    lignes: g.phrases.map((p) => p.texte),
    ...(g.phrases.some((p) => p.voix) ? { voixBalisee: g.phrases.map((p) => p.voix ?? p.texte).join(" ") } : {}),
  }));
}

export const nbMots2 = (phrases: Phrase[]) => phrases.map((p) => p.texte).join(" ").split(/\s+/).filter(Boolean).length;
export const nbRires2 = (phrases: Phrase[]) => phrases.reduce((n, p) => n + (p.voix?.match(/\[[^\]]+\]/g)?.length ?? 0), 0);
/** Un storyboard qui tient debout : assez de phrases, une preuve dans l'appli, pas un seul plan. */
export function defaut2(phrases: Phrase[]): string | null {
  if (phrases.length < 4) return "Il faut au moins 4 phrases.";
  if (!phrases.some((p) => p.plan === "ecran")) return "Il faut au moins une phrase en plan « ecran » (vraie capture de l'appli).";
  if (new Set(phrases.map((p) => p.plan)).size < 3) return "Il faut au moins 3 plans différents.";
  const actions = phrases.filter((p) => (p.gestes?.length ?? 0) + (p.accessoires?.length ?? 0) + (p.evenements?.length ?? 0) > 0).length;
  if (actions < phrases.length * 0.7) return "Trop de phrases sans geste, accessoire ni événement.";
  return null;
}
