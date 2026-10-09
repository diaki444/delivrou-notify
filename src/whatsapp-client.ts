import { recordMessage, upsertChat, getMessages, getChat, setSuggestedReply, findProspectByPhone } from "./store.js";
import { isGeminiConfigured, suggestReply } from "./gemini.js";
import { CATEGORY_LABELS } from "./categories.js";

/**
 * Client WhatsApp Business Platform (API officielle de Meta, Cloud API).
 * Remplace l'ancienne connexion Baileys/QR code : aucune session a
 * maintenir, aucun risque de blocage du numero, hebergement par Meta.
 * Necessite WHATSAPP_PHONE_NUMBER_ID et WHATSAPP_ACCESS_TOKEN.
 */

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${API_VERSION}`;

class WhatsAppClient {
  private contactNames = new Map<string, string>();

  isConfigured(): boolean {
    return Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN);
  }

  /** Conserve pour compatibilite avec le reste du code : avec l'API Cloud, "connecte" = "configure" (pas de session persistante). */
  isConnected(): boolean {
    return this.isConfigured();
  }

  async sendText(phoneDigits: string, text: string): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("API WhatsApp non configuree (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN manquants).");
    }

    const res = await fetch(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phoneDigits,
        type: "text",
        text: { body: text },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`WhatsApp Cloud API ${res.status}: ${body.slice(0, 300)}`);
    }

    // Reflete l'envoi dans l'historique local (conversations/journal du tableau de bord).
    const jid = `${phoneDigits}@s.whatsapp.net`;
    const timestamp = Date.now();
    recordMessage({ id: `out-${timestamp}`, chatJid: jid, fromMe: true, text, timestamp });
    upsertChat(jid, { lastText: text, lastTimestamp: timestamp });
  }

  /** Appele par le webhook Meta a chaque message entrant. */
  handleIncomingMessage(params: { from: string; id: string; timestamp: number; text: string; senderName?: string }) {
    const jid = `${params.from}@s.whatsapp.net`;
    if (params.senderName) this.contactNames.set(jid, params.senderName);

    upsertChat(jid, { name: params.senderName || this.contactNames.get(jid) });
    recordMessage({
      id: params.id,
      chatJid: jid,
      fromMe: false,
      senderName: params.senderName,
      text: params.text,
      timestamp: params.timestamp,
    });

    if (isGeminiConfigured()) {
      void this.generateReplySuggestion(jid);
    }
  }

  /** Propose un brouillon de reponse via l'IA ; ne l'envoie jamais, seulement le pre-remplit dans le tableau de bord. */
  private async generateReplySuggestion(jid: string) {
    try {
      const history = getMessages(jid, 8).map((m) => ({ fromMe: m.fromMe, text: m.text }));
      const name = getChat(jid)?.name;
      const phone = jid.split("@")[0];
      const prospect = findProspectByPhone(phone);
      const result = await suggestReply(
        history,
        name,
        prospect
          ? { isProspect: true, bucketLabel: CATEGORY_LABELS[prospect.bucket], contacted: prospect.contacted }
          : { isProspect: false },
      );
      if (result.ok && result.text) setSuggestedReply(jid, result.text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[delivrou-notify] Suggestion IA impossible:", err);
    }
  }
}

export const whatsapp = new WhatsAppClient();
