/**
 * Assistant IA (Google Gemini, offre gratuite) pour :
 *  - proposer un message de prospection court et personnalisable par categorie,
 *  - suggerer un brouillon de reponse quand un prospect/client ecrit, jamais
 *    envoye automatiquement (l'utilisateur confirme toujours lui-meme).
 * Necessite GEMINI_API_KEY. Si absent, les fonctions renvoient ok:false
 * sans jamais faire planter le reste du tableau de bord.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

export function isGeminiConfigured(): boolean {
  return Boolean(GEMINI_API_KEY);
}

/**
 * Contexte entreprise injecte dans chaque prompt, pour que l'IA reponde en
 * connaissance de cause plutot que de maniere generique. Sourcee depuis le
 * site et l'application Delivrou (page d'accueil, page "A propos", FAQ
 * support) : a tenir a jour si l'offre evolue (zones, tarifs, horaires...).
 */
const COMPANY_CONTEXT =
  `Delivrou est une plateforme guineenne de livraison nee a Conakry, qui relie clients, commerces partenaires ` +
  `(restaurants, pharmacies, epiceries) et livreurs independants. Slogan : "Delivrou, vite fait." ` +
  `Siege a Sonfonia Gare, Conakry. Zones couvertes : Conakry et sa peripherie (13 communes), principalement ` +
  `Kaloum, Dixinn, Ratoma, Matam et Matoto. Ouvert 7j/7 de 7h a 23h.\n\n` +
  `Quatre services : Delivrou Repas (commande chez des restaurants partenaires et suivi jusqu'a la porte), ` +
  `Delivrou Colis (document, cadeau ou marchandise, un ou plusieurs arrets, ou un livreur fait les achats ` +
  `pour le client), Delivrou Pharmacie (produits de pharmacie livres) et Delivrou Epicerie (courses du ` +
  `quotidien).\n\n` +
  `Deux publics : (1) les commerces partenaires (restaurants, pharmacies, epiceries) qui confient leurs ` +
  `livraisons a des livreurs Delivrou plutot que de gerer leur propre logistique ; (2) les clients finaux qui ` +
  `commandent et suivent leur livraison en temps reel, avec un code a 4 chiffres pour confirmer la remise en ` +
  `main propre.\n\n` +
  `Paiement : Orange Money, MTN Mobile Money, ou especes. Pour un repas, le client paie directement le ` +
  `restaurant via son code marchand OM/MoMo affiche dans l'appli. Pour un colis, paiement OM a la commande ou ` +
  `especes a la livraison. Le prix total (frais de livraison inclus) est toujours affiche avant de valider la ` +
  `commande, sans surprise.\n\n` +
  `Delai de livraison typique : entre 30 min et 1h30 selon la distance et l'heure. Annulation gratuite dans les ` +
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
  `demarche. Si tu ne peux pas produire un brouillon pertinent, reponds avec une chaine vide.`;

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

  return text;
}

async function callGemini(prompt: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: "GEMINI_API_KEY non configurée sur le serveur." };
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 300 },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Gemini ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!raw) return { ok: false, error: "Réponse IA vide." };
    const text = sanitizeAiText(raw);
    if (!text) return { ok: false, error: "Réponse IA mal formée, ignorée par sécurité." };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Propose un message de prospection pour une famille d'etablissements donnee. */
export async function generateProspectMessage(
  categoryLabel: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const prompt =
    `${COMPANY_CONTEXT}\n\n` +
    `Tu rediges un message WhatsApp de prospection pour approcher un nouveau commerce partenaire. ` +
    `Cible : des commerces de type "${categoryLabel}". ` +
    `Contraintes : maximum 3 phrases courtes, utilise exactement le texte "{nom}" (avec les accolades) ` +
    `a la place du nom du commerce, propose le service de livraison et termine par une question simple ` +
    `pour engager la conversation.\n\n${FORMAT_RULES}`;
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
    `Maximum 2-3 phrases courtes.\n\n${FORMAT_RULES}`;
  return callGemini(prompt);
}
