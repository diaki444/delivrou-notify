/**
 * Assistant IA (Google Gemini, offre gratuite) pour :
 *  - proposer un message de prospection court et personnalisable par categorie,
 *  - suggerer un brouillon de reponse quand un prospect/client ecrit, jamais
 *    envoye automatiquement (l'utilisateur confirme toujours lui-meme).
 * Necessite GEMINI_API_KEY. Si absent, les fonctions renvoient ok:false
 * sans jamais faire planter le reste du tableau de bord.
 */

import { qgKnowledge } from "./knowledge.js";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// "flash-lite" est le modele le plus genereux en quota gratuit (bien plus
// que "flash" standard), largement suffisant pour de courts brouillons
// WhatsApp. Changez via la variable d'environnement GEMINI_MODEL si besoin.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

export function isGeminiConfigured(): boolean {
  return Boolean(GEMINI_API_KEY);
}

// Coupe-circuit : des lors qu'on recoit un 429 "quota depasse" (offre
// gratuite Gemini), on arrete d'appeler l'API pendant un moment plutot que
// de marteler les requetes (ce qui ne fait qu'allonger le blocage de quota
// et remplir les logs d'erreurs identiques). Partage par toutes les
// fonctions de ce fichier, puisque le quota est le meme pour toutes.
const QUOTA_COOLDOWN_MS = 2 * 60_000;
let quotaCooldownUntil = 0;

function isOnQuotaCooldown(): boolean {
  return Date.now() < quotaCooldownUntil;
}

/**
 * Contexte entreprise injecte dans chaque prompt, pour que l'IA reponde en
 * connaissance de cause plutot que de maniere generique. Sourcee depuis le
 * site et l'application Delivrou (page d'accueil, page "A propos", FAQ
 * support) : a tenir a jour si l'offre evolue (zones, tarifs, horaires...).
 */
const COMPANY_CONTEXT =
  `Delivrou est une plateforme guineenne de livraison nee a Conakry, qui relie clients, commerces et livreurs ` +
  `independants verifies. Slogan : "Delivrou, vite fait." Siege a Sonfonia Gare, Conakry. Livraison de colis ` +
  `partout a Conakry, 7j/7 de 7h a 23h. Site : www.delivrou.com (toujours avec www).\n\n` +
  `SERVICE OUVERT AUJOURD'HUI : uniquement Delivrou Colis (document, cadeau ou marchandise ; modes Standard, ` +
  `Multi-colis et Recuperation). Repas, Pharmacie et Epicerie sont "bientot" : ne jamais les presenter comme ` +
  `disponibles ; a un commerce de ces secteurs, on parle d'un lancement en preparation et de partenaires recherches.\n\n` +
  `Commander un colis, en 4 etapes dans l'appli : (1) depart : commune + point de repere (il n'y a pas d'adresse ` +
  `postale en Guinee) ou bouton "Me localiser" ; (2) destinataire : nom, numero, commune, repere ; (3) colis : ` +
  `description + photo, qui sert de preuve en cas de dommage ; (4) paiement. Le prix depend du trajet et s'affiche ` +
  `toujours avant de valider, sans surprise.\n\n` +
  `Securite : livreurs verifies (identite controlee par photo), suivi en direct sur la carte, code PIN de retrait ` +
  `donne au livreur quand il recupere le colis, puis code de livraison a 4 chiffres que le destinataire donne au ` +
  `livreur a la remise. Notation du livreur apres la course.\n\n` +
  `Paiement : Orange Money ou MTN MoMo dans l'appli, ou "a l'arrivee" par QR code Mobile Money. Ne jamais annoncer ` +
  `le paiement en especes (decision pas encore prise) : si on le demande, dire que pour l'instant c'est par Mobile ` +
  `Money, plus sur pour le client et le livreur.\n\n` +
  `Appli iPhone : App Store. Android : passer par www.delivrou.com en attendant la validation du Play Store. ` +
  `Parrainage : 50 Deli-points par parrainage = 5 000 GNF.\n\n` +
  `Interdits dans toute reponse : promettre un delai precis ou un prix precis (renvoyer vers l'appli, qui affiche ` +
  `le prix et l'heure d'arrivee estimee), critiquer un concurrent, faux avis, tirage au sort, contenu religieux, ` +
  `demander un code ou des informations personnelles dans un echange non prive. Reclamation grave, demande de ` +
  `partenariat important ou question de prix negocie : proposer qu'Ibrahima rappelle.\n\n` +
  `Annulation gratuite dans les ` +
  `10 minutes suivant la commande ; au-dela, si le livreur est deja en route, des frais de 5 000 GNF sont dus ` +
  `(retenus automatiquement si paiement Orange Money, sinon une dette est creee sur le compte client a regler ` +
  `avant la prochaine commande). En cas de 2 dettes impayees ou plus, le compte est bloque jusqu'au reglement ` +
  `(reglable en un clic via Orange Money ou MoMo, deblocage immediat).\n\n` +
  `Livreurs : independants, identifies, notes par la communaute, choisissent leurs horaires et voient le trajet ` +
  `avant d'accepter une course.\n\n` +
  `Valeurs mises en avant : simplicite (commande en quelques taps), confiance (livreurs identifies, code de ` +
  `confirmation, support disponible 7j/7), impact local (revenus pour les livreurs, visibilite pour les ` +
  `restaurateurs). Positionnement : "pense pour Conakry, pas copie d'ailleurs" — rapide, fiable, abordable, ` +
  `tarif clair avant de confirmer.\n\n` +
  `Delivrou n'envoie pas de SMS/WhatsApp marketing en masse : on contacte seulement les prospects interesses ` +
  `et les clients ayant une commande active. Ton de marque : chaleureux, direct, respectueux, "a la guineenne" ` +
  `(naturel, pas de jargon corporate, pas de ton robotique).`;

const FORMAT_RULES =
  `Regles de format strictes : reponds UNIQUEMENT avec le message final a envoyer sur WhatsApp, rien d'autre. ` +
  `Jamais de titre, de prefixe du type "Ton:", "Tone:", "Objectif:", "Note:", jamais de markdown (pas de **, pas de ` +
  `tirets de liste, pas de guillemets autour du message), jamais un mot d'anglais, jamais d'explication de ta ` +
  `demarche. Si tu ne peux pas produire un brouillon pertinent, reponds avec une chaine vide.\n\n` +
  `Style : ecris comme un vrai commercial Delivrou qui repond depuis son telephone, pas comme un robot ni une ` +
  `brochure. Par defaut, reste TRES court : une phrase, parfois deux, l'essentiel seulement — comme repondrait ` +
  `une personne occupee mais attentive. N'allonge le message que si la question posee l'exige vraiment ` +
  `(plusieurs infos precises demandees d'un coup, ou explication qui ne peut pas etre coupee) ; dans ce cas, ` +
  `reste quand meme direct, sans remplissage ni phrases de politesse inutiles.`;

/** Rejette les reponses IA mal formees (restes de meta-commentaire, markdown, anglais) avant de les proposer. */
function sanitizeAiText(raw: string): string | null {
  let text = raw.trim();
  // Retire des guillemets ou retours a la ligne superflus en bordure.
  text = text.replace(/^["'«]+|["'»]+$/g, "").trim();

  if (!text) return null;
  if (text.length > 600) return null; // trop long : probablement pas un simple brouillon WhatsApp

  const suspiciousPatterns = [
    /^\s*\*\*/, // commence par du markdown gras
    /^\s*(tone|ton|objectif|note|context|contexte|draft|brouillon)\s*:/i, // prefixe meta
    /```/, // bloc de code
    /\bthe\s+client\b/i, // reste d'anglais observe en pratique
  ];
  if (suspiciousPatterns.some((re) => re.test(text))) return null;

  // Garde-fou supplementaire si l'API ne signale pas la troncature : un
  // brouillon qui ne se termine pas sur une ponctuation/emoji normale est
  // probablement coupe en pleine phrase.
  const endsCleanly = /[.!?…"»’)\u{1F300}-\u{1FAFF}☀-➿]\s*$/u.test(text);
  if (!endsCleanly) return null;

  return text;
}

function withKnowledge(prompt: string): string {
  const k = qgKnowledge();
  return k ? `${prompt}\n\n${k}` : prompt;
}

async function callGemini(prompt: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY non configurée sur le serveur." };
  }
  if (isOnQuotaCooldown()) {
    return { ok: false, error: "Quota IA depasse, en pause temporaire." };
  }
  // Les modeles "flash" recents (dont gemini-3.8-flash) reflechissent en
  // interne avant de repondre, et ce raisonnement peut consommer le budget
  // de tokens de sortie avant meme d'ecrire le message final (cause des
  // brouillons coupes/casses observes). On essaie d'abord de reduire ce
  // raisonnement au minimum ; si l'API rejette ce parametre (non supporte
  // selon la version du modele/endpoint), on reessaie sans, pour ne jamais
  // perdre la suggestion a cause d'un reglage non reconnu.
  const attempts = [{ thinkingConfig: { thinkingLevel: "low" } }, {}];

  let lastError = "Reponse IA indisponible.";
  for (const extraConfig of attempts) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: withKnowledge(prompt) }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 2048, ...extraConfig },
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastError = `Gemini ${res.status}: ${body.slice(0, 300)}`;
        // eslint-disable-next-line no-console
        console.error(`[delivrou-notify] Appel Gemini echoue (config ${JSON.stringify(extraConfig)}):`, lastError);
        if (res.status === 429) {
          // Quota de l'offre gratuite depasse : inutile de reessayer tout de
          // suite (ni avec l'autre config), ca ne ferait qu'ajouter des
          // appels a un quota deja epuise. On coupe les appels IA pour un
          // moment, le temps que le quota se regenere.
          quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
          return { ok: false, error: lastError };
        }
        continue; // essaie la config suivante (ex: sans thinkingConfig)
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      };
      const candidate = data.candidates?.[0];
      const raw = candidate?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!raw) {
        lastError = "Réponse IA vide.";
        continue;
      }
      // MAX_TOKENS veut dire que Gemini a ete coupe en pleine phrase : mieux
      // vaut ne rien proposer qu'un brouillon tronque envoye par erreur.
      if (candidate?.finishReason === "MAX_TOKENS") {
        lastError = "Réponse IA tronquée (limite de longueur atteinte), ignorée par sécurité.";
        continue;
      }
      const text = sanitizeAiText(raw);
      if (!text) {
        lastError = "Réponse IA mal formée, ignorée par sécurité.";
        continue;
      }
      return { ok: true, text };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("[delivrou-notify] Erreur appel Gemini:", lastError);
    }
  }
  return { ok: false, error: lastError };
}

/** Propose un message de prospection pour une famille d'etablissements donnee. */
export async function generateProspectMessage(
  categoryLabel: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const prompt =
    `${COMPANY_CONTEXT}\n\n` +
    `Tu rediges un message WhatsApp de prospection pour approcher un nouveau commerce partenaire. ` +
    `Cible : des commerces de type "${categoryLabel}". ` +
    `Contraintes : 1 a 2 phrases courtes maximum, utilise exactement le texte "{nom}" (avec les accolades) ` +
    `a la place du nom du commerce, propose le service de livraison et termine par une question simple ` +
    `pour engager la conversation.\n\n${FORMAT_RULES}`;
  return callGemini(prompt);
}

/** Premier message personnalise pour un prospect precis (pas un modele generique par categorie). */
export async function generateProspectPitch(prospect: {
  name: string;
  categoryLabel: string;
  address?: string;
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  const prompt =
    `${COMPANY_CONTEXT}\n\n` +
    `Tu rediges le tout premier message WhatsApp envoye a un commerce precis pour lui proposer de devenir ` +
    `partenaire Delivrou. Commerce : "${prospect.name}", type "${prospect.categoryLabel}"` +
    `${prospect.address ? `, situe a ${prospect.address}` : ""}. ` +
    `Objectif : un message accrocheur et credible qui donne vraiment envie de repondre et de collaborer — pas ` +
    `un message generique copie-colle. Nomme le commerce par son nom. Mets en avant un benefice concret et ` +
    `pertinent pour CE type de commerce (gagner du temps, toucher plus de clients, livraison geree de A a Z...), ` +
    `pas une liste de caracteristiques. Termine par une question simple et engageante pour demarrer l'echange. ` +
    `1 a 2 phrases courtes maximum.\n\n${FORMAT_RULES}`;
  return callGemini(prompt);
}

export interface ProspectContext {
  isProspect: boolean;
  bucketLabel?: string;
  contacted?: boolean;
}

/** Suggere un brouillon de reponse a partir des derniers echanges d'une conversation. */
export async function suggestReply(
  history: Array<{ fromMe: boolean; text: string }>,
  contactName?: string,
  prospect?: ProspectContext,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const transcript = history
    .slice(-8)
    .map((m) => `${m.fromMe ? "Delivrou" : contactName || "Client"}: ${m.text}`)
    .join("\n");

  const goal = prospect?.isProspect
    ? `Ce contact est un PROSPECT (commerce de type "${prospect.bucketLabel || "commerce local"}") qu'on cherche a convaincre de collaborer avec Delivrou pour ses livraisons. ` +
      `Objectif prioritaire : ne jamais laisser la conversation s'eteindre et ne jamais perdre ce prospect. Comprends bien sa situation et ses objections (prix, confiance, habitude d'un autre livreur, pas convaincu de l'utilite...), ` +
      `reponds-y directement et concretement, puis relance toujours vers une prochaine etape claire (un essai, un rendez-vous, une question precise) pour faire avancer la discussion vers un "oui". ` +
      `Reste chaleureux et naturel, jamais insistant au point d'etre lourd, mais ne laisse jamais la conversation sans suite.`
    : `C'est un client existant de Delivrou. Objectif : repondre precisement a sa demande, le rassurer, et garder une relation de confiance pour qu'il continue a utiliser le service.`;

  const prompt =
    `${COMPANY_CONTEXT}\n\n` +
    `Tu es l'assistant du service clientele de Delivrou. ${goal}\n\n` +
    `Voici les derniers messages de la conversation WhatsApp :\n${transcript}\n\n` +
    `Propose un brouillon de reponse au dernier message, a envoyer par un humain qui relira et validera avant envoi. ` +
    `1 phrase par defaut, 2 maximum sauf si la question l'exige vraiment.\n\n${FORMAT_RULES}`;
  return callGemini(prompt);
}

/**
 * Appel libre au modele, pour les usages hors conversation WhatsApp (par
 * exemple repondre a un commentaire Facebook ou TikTok depuis le QG). Le
 * contexte entreprise est deja inclus : l'appelant n'ajoute que sa consigne.
 */
export async function askGemini(instruction: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  return callGemini(`${COMPANY_CONTEXT}\n\n${instruction}\n\n${FORMAT_RULES}`);
}

/**
 * Comme askGemini, mais sans les regles de format WhatsApp : pour les emails,
 * dont la forme (salutation, signature, paragraphes) n'est pas celle d'un
 * message court. Le contexte entreprise reste inclus.
 */
export async function askGeminiEmail(instruction: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  return callGemini(`${COMPANY_CONTEXT}\n\n${instruction}`);
}
