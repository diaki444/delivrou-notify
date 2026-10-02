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
          generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
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
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) return { ok: false, error: "Réponse IA vide." };
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
    `Tu rediges un message WhatsApp de prospection pour Delivrou, un service de livraison a Conakry, Guinee. ` +
    `Cible : des commerces de type "${categoryLabel}". ` +
    `Contraintes : francais simple et chaleureux "a la guineenne", professionnel mais pas formel, ` +
    `maximum 3 phrases courtes, pas de markdown, pas de guillemets autour du message, ` +
    `utilise exactement le texte "{nom}" (avec les accolades) a la place du nom du commerce, ` +
    `propose le service de livraison et termine par une question simple pour engager la conversation. ` +
    `Reponds uniquement avec le message final, rien d'autre.`;
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
    `Tu es l'assistant du service clientele de Delivrou, un service de livraison a Conakry, Guinee. ` +
    `${goal}\n\n` +
    `Voici les derniers messages de la conversation WhatsApp :\n${transcript}\n\n` +
    `Propose un brouillon de reponse au dernier message, a envoyer par un humain qui relira et validera avant envoi. ` +
    `Contraintes : francais simple "a la guineenne", chaleureux et professionnel, maximum 2-3 phrases courtes, ` +
    `pas de markdown, pas de guillemets. Reponds uniquement avec le brouillon, rien d'autre.`;
  return callGemini(prompt);
}
