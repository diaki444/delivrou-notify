/**
 * Client WhatsApp via l'API officielle de Meta (Cloud API).
 *
 * Meme interface que le client Baileys (whatsapp-client.ts) : le reste du
 * service (QG, tableau de bord, file d'envoi, IA) ne voit pas la difference.
 * Choisi par WHATSAPP_PROVIDER=meta ; par defaut le service garde Baileys.
 *
 * Variables :
 *   WHATSAPP_PHONE_NUMBER_ID  identifiant du numero (Gestionnaire WhatsApp)
 *   WHATSAPP_ACCESS_TOKEN     jeton permanent d'un utilisateur systeme (SECRET)
 *   WHATSAPP_VERIFY_TOKEN     mot de passe choisi pour verifier le webhook
 *   WHATSAPP_APP_SECRET       (recommande) secret de l'application, pour
 *                             verifier la signature des webhooks (SECRET)
 *   WHATSAPP_GRAPH_VERSION    (facultatif) defaut v21.0
 *
 * Regle de Meta : hors des 24 h suivant le dernier message du client, on ne
 * peut envoyer qu'un MODELE approuve (sendTemplate).
 */

import crypto from "node:crypto";
import { recordMessage, upsertChat, getMessages, getChat, setSuggestedReply, findProspectByPhone } from "./store.js";
import { isGeminiConfigured, suggestReply } from "./gemini.js";
import { CATEGORY_LABELS } from "./categories.js";
import { notifyAllSubscriptions } from "./push.js";

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
// Deux noms acceptes : l'ancien (premiere tentative de migration) et le nouveau.
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || "v21.0"}`;

export interface IncomingWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          image?: { caption?: string };
          video?: { caption?: string };
          document?: { caption?: string; filename?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
          reaction?: { emoji?: string };
        }>;
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: Array<{ code?: number; title?: string; message?: string }> }>;
      };
    }>;
  }>;
}

const jidOf = (digits: string) => `${digits}@s.whatsapp.net`;

/** Erreur Meta avec son code : permet de reconnaitre la fenetre de 24 h fermee. */
export class MetaError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "MetaError";
  }
  /** Hors fenetre de 24 h : seul un modele approuve est accepte. */
  get windowClosed(): boolean {
    return this.code === 131047 || this.code === 131051;
  }
}

function explain(code: number | undefined, fallback: string): string {
  switch (code) {
    case 131047:
    case 131051:
      return "Hors de la fenêtre de 24 h : le client n'a pas écrit récemment. Meta n'autorise alors qu'un modèle de message approuvé.";
    case 131026:
      return "Message non remis : ce numéro n'est pas joignable sur WhatsApp.";
    case 131030:
      return "Numéro non autorisé : l'application Meta est encore en mode développement (seuls les numéros de test sont acceptés).";
    case 190:
      return "Jeton d'accès invalide ou expiré : en générer un nouveau (utilisateur système).";
    case 132001:
      return "Modèle introuvable ou non approuvé (nom ou langue incorrects).";
    case 130429:
    case 131056:
      return "Trop d'envois : Meta limite temporairement le débit.";
    default:
      return fallback;
  }
}

class MetaClient {
  readonly provider = "meta" as const;
  private ok = false;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private display: string | null = null;

  isConnected(): boolean {
    return this.ok;
  }
  getLastQr(): string | null {
    return null;
  }
  getInfo() {
    return { provider: "meta", connected: this.ok, number: this.display, error: this.lastError };
  }
  isConfigured(): boolean {
    return Boolean(PHONE_NUMBER_ID && ACCESS_TOKEN);
  }

  /** Verifie le jeton et le numero aupres de Meta ; recontrole toutes les 5 minutes. */
  async connect(): Promise<void> {
    if (!this.isConfigured()) {
      this.ok = false;
      this.lastError = "WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN manquants";
      console.error(`[delivrou-notify] Meta : ${this.lastError}. Rien ne sera envoye tant qu'ils ne sont pas definis.`);
      return;
    }
    await this.check();
    if (!this.timer) this.timer = setInterval(() => void this.check(), 5 * 60_000).unref();
  }

  private async check() {
    try {
      const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      const j = (await r.json()) as { display_phone_number?: string; verified_name?: string; quality_rating?: string; error?: { code?: number; message?: string } };
      if (!r.ok || j.error) {
        this.ok = false;
        this.lastError = explain(j.error?.code, j.error?.message || `HTTP ${r.status}`);
        console.error("[delivrou-notify] Meta : controle impossible :", this.lastError);
        return;
      }
      if (!this.ok) console.error(`[delivrou-notify] Meta : connecte au numero ${j.display_phone_number} (${j.verified_name}), qualite ${j.quality_rating ?? "?"}.`);
      this.ok = true;
      this.lastError = null;
      this.display = j.display_phone_number ?? null;
    } catch (err) {
      this.ok = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error("[delivrou-notify] Meta : erreur reseau :", this.lastError);
    }
  }

  /** Appel direct a l'API Graph (diagnostic et abonnement du webhook). Ne renvoie jamais le jeton. */
  async graph(pathAndQuery: string, method: "GET" | "POST" = "GET"): Promise<{ status: number; body: unknown }> {
    if (!ACCESS_TOKEN) return { status: 0, body: { error: "WHATSAPP_ACCESS_TOKEN manquant" } };
    const r = await fetch(`${GRAPH}/${pathAndQuery}`, { method, headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  /** L'API officielle ne permet pas de tester un numero a l'avance : on laisse l'envoi trancher. */
  async numberHasWhatsApp(_phoneDigits: string): Promise<boolean> {
    return true;
  }

  private async post(body: Record<string, unknown>): Promise<string | undefined> {
    if (!this.isConfigured()) throw new Error("API WhatsApp (Meta) non configurée sur le serveur.");
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
    });
    const j = (await r.json().catch(() => ({}))) as { messages?: Array<{ id?: string }>; error?: { code?: number; message?: string; error_data?: { details?: string } } };
    if (!r.ok || j.error) {
      const msg = explain(j.error?.code, j.error?.error_data?.details || j.error?.message || `HTTP ${r.status}`);
      throw new MetaError(msg, j.error?.code);
    }
    return j.messages?.[0]?.id;
  }

  private digits(target: string): string {
    return target.split("@")[0].replace(/\D/g, "");
  }

  async sendText(target: string, text: string): Promise<void> {
    const to = this.digits(target);
    if (!to) throw new Error("Numéro illisible");
    const id = await this.post({ to, type: "text", text: { body: text, preview_url: true } });
    recordMessage({ id: id ?? `meta-${Date.now()}`, chatJid: jidOf(to), fromMe: true, text, timestamp: Date.now() });
  }

  /** Message modele approuve (seul autorise hors de la fenetre de 24 h). */
  async sendTemplate(target: string, name: string, params: string[] = [], lang = "fr", shownText?: string): Promise<void> {
    const to = this.digits(target);
    if (!to) throw new Error("Numéro illisible");
    const components = params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }] : undefined;
    const id = await this.post({ to, type: "template", template: { name, language: { code: lang }, ...(components ? { components } : {}) } });
    recordMessage({ id: id ?? `meta-${Date.now()}`, chatJid: jidOf(to), fromMe: true, text: shownText ?? `[modèle ${name}] ${params.join(" · ")}`.trim(), timestamp: Date.now() });
  }

  /**
   * Code de verification : modele de categorie « Authentification » (code + bouton « Copier le code »).
   * Ne passe volontairement PAS par recordMessage : le code ne doit apparaitre nulle part.
   */
  async sendOtpTemplate(target: string, code: string, name = "code_verification", lang = "fr"): Promise<void> {
    const to = this.digits(target);
    if (!to) throw new Error("Numero illisible");
    await this.post({
      to,
      type: "template",
      template: {
        name,
        language: { code: lang },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    });
  }

  // ---------- webhook ----------

  verifyHandshake(mode: unknown, token: unknown): boolean {
    return mode === "subscribe" && Boolean(VERIFY_TOKEN) && token === VERIFY_TOKEN;
  }

  /** Signature X-Hub-Signature-256 : obligatoire des que WHATSAPP_APP_SECRET est defini. */
  verifySignature(raw: Buffer | undefined, header: string | undefined): boolean {
    if (!APP_SECRET) return true;
    if (!raw || !header) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  handleWebhook(payload: IncomingWebhook) {
    for (const entry of payload.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        const value = ch.value;
        if (!value) continue;
        const names = new Map<string, string | undefined>((value.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name]));

        for (const st of value.statuses ?? []) {
          if (st.status === "failed") {
            const e = st.errors?.[0];
            console.error(`[delivrou-notify] Meta : message non remis a ${st.recipient_id} : ${explain(e?.code, e?.title || e?.message || "echec")}`);
          }
        }

        for (const m of value.messages ?? []) {
          if (!m.from || !m.id) continue;
          const text =
            m.text?.body ??
            m.button?.text ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            m.image?.caption ??
            m.video?.caption ??
            m.document?.caption ??
            (m.reaction?.emoji ? `[réaction ${m.reaction.emoji}]` : m.type ? `[message ${m.type}]` : "");
          if (!text) continue;
          this.recordIncoming(m.from, m.id, text, (Number(m.timestamp) || 0) * 1000 || Date.now(), names.get(m.from) || undefined);
        }
      }
    }
  }

  private recordIncoming(from: string, id: string, text: string, timestamp: number, senderName?: string) {
    const jid = jidOf(from);
    if (senderName) upsertChat(jid, { name: senderName });
    recordMessage({ id, chatJid: jid, fromMe: false, senderName, text, timestamp });
    if (isGeminiConfigured()) void this.suggest(jid);
    void notifyAllSubscriptions({
      title: senderName || getChat(jid)?.name || "Nouveau message WhatsApp",
      body: text.slice(0, 140),
      url: `/dashboard/chat/${encodeURIComponent(jid)}`,
    }).catch(() => {});
  }

  private async suggest(jid: string) {
    try {
      const history = getMessages(jid, 8).map((m) => ({ fromMe: m.fromMe, text: m.text }));
      const prospect = findProspectByPhone(jid.split("@")[0]);
      const r = await suggestReply(
        history,
        getChat(jid)?.name,
        prospect ? { isProspect: true, bucketLabel: CATEGORY_LABELS[prospect.bucket], contacted: prospect.contacted } : { isProspect: false },
      );
      if (r.ok && r.text) setSuggestedReply(jid, r.text);
    } catch (err) {
      console.error("[delivrou-notify] Suggestion IA impossible:", err);
    }
  }
}

export const metaClient = new MetaClient();
