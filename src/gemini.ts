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
 * connaissance de cause plutot que de maniere generique. A completer/ajuster
 * au besoin (zones couvertes, tarifs, delais reels...).
 */
const COMPANY_CONTEXT =
  `Delivrou est un service de livraison a la demande a Conakry, Guinee. ` +
  `Deux activites : (1) livraison pour des commerces partenaires (pharmacies, epiceries, restaurants, boutiques) ` +
  `qui confient leurs livraisons a des livreurs Delivrou plutot que de geren leur propre logistique ; ` +
  `(2) suivi de commande pour les clients finaux qui ont deja commande (colis ou repas), avec un livreur assigne ` +
  `et un statut de livraison en temps reel. Delivrou met en avant : rapidite, fiabilite, livreurs serieux, ` +
  `pas de mauvaises surprises sur le tarif. Pas de SMS/WhatsApp marketing en masse : on contacte seulement les ` +
  `prospects interesses et les clients ayant une commande active. Ton de marque : chaleureux, direct, respectueux, ` +
  `"a la guineenne" (naturel, pas de jargon corporate, pas de ton robotique).`;

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
