/**
 * Assistant IA (Google Gemini, offre gratuite) pour :
 *  - proposer un message de prospection court et personnalisable par categorie,
 *  - suggerer un brouillon de reponse quand un prospect/client ecrit, jamais
 *    envoye automatiquement (l'utilisateur confirme toujours lui-meme).
 * Necessite GEMINI_API_KEY. Si absent, les fonctions renvoient ok:false
 * sans jamais faire planter le reste du tableau de bord.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

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

/** Suggere un brouillon de reponse a partir des derniers echanges d'une conversation. */
export async function suggestReply(
  history: Array<{ fromMe: boolean; text: string }>,
  contactName?: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const transcript = history
    .slice(-8)
    .map((m) => `${m.fromMe ? "Delivrou" : contactName || "Client"}: ${m.text}`)
    .join("\n");
  const prompt =
    `Tu es l'assistant du service clientele de Delivrou, un service de livraison a Conakry, Guinee. ` +
    `Voici les derniers messages d'une conversation WhatsApp :\n${transcript}\n\n` +
    `Propose un brouillon de reponse au dernier message du client, a envoyer par un humain qui relira et validera avant envoi. ` +
    `Contraintes : francais simple "a la guineenne", chaleureux et professionnel, maximum 2-3 phrases courtes, ` +
    `pas de markdown, pas de guillemets. Reponds uniquement avec le brouillon, rien d'autre.`;
  return callGemini(prompt);
}
