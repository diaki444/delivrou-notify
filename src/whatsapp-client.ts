import fs from "node:fs";
import path from "node:path";
import { Boom } from "@hapi/boom";
import P from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { recordMessage, upsertChat, getMessages, getChat, setSuggestedReply, findProspectByPhone } from "./store.js";
import { isGeminiConfigured, suggestReply } from "./gemini.js";
import { CATEGORY_LABELS } from "./categories.js";
import { notifyAllSubscriptions } from "./push.js";
import { metaClient } from "./whatsapp-meta.js";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");

class WhatsAppClient {
  readonly provider = "baileys" as const;
  private sock: WASocket | null = null;
  private connected = false;
  private connecting = false;
  private lastQr: string | null = null;
  private contactNames = new Map<string, string>();

  isConnected(): boolean {
    return this.connected;
  }

  getInfo() {
    return { provider: "baileys", connected: this.connected, number: null as string | null, error: null as string | null };
  }

  async sendTemplate(_target: string, _name: string, _params?: string[], _lang?: string, _shown?: string): Promise<void> {
    throw new Error("Les modeles de message demandent l'API officielle Meta (WHATSAPP_PROVIDER=meta).");
  }

  /** Dernier QR code recu, au cas ou vous devez le reafficher sans redemarrer le service. */
  getLastQr(): string | null {
    return this.lastQr;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" }) as any,
      printQRInTerminal: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("contacts.upsert", (list) => {
      for (const c of list) {
        if (!c.id) continue;
        this.contactNames.set(c.id, c.name || c.notify || "");
      }
    });

    sock.ev.on("chats.upsert", (list) => {
      for (const c of list) {
        if (!c.id) continue;
        upsertChat(c.id, { name: c.name || this.contactNames.get(c.id) || undefined });
      }
    });

    sock.ev.on("messages.upsert", ({ messages: incoming }) => {
      for (const m of incoming) this.recordIncoming(m);
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQr = qr;
        // eslint-disable-next-line no-console
        console.error("\n[delivrou-notify] Scannez ce QR code (WhatsApp > Appareils lies > Lier un appareil) :\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        this.connected = true;
        this.connecting = false;
        this.lastQr = null;
        // eslint-disable-next-line no-console
        console.error("[delivrou-notify] Connecte a WhatsApp. Pret a envoyer des notifications.");
      }

      if (connection === "close") {
        this.connected = false;
        this.connecting = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        // eslint-disable-next-line no-console
        console.error(
          `[delivrou-notify] Connexion fermee (code ${statusCode ?? "inconnu"}).`,
          loggedOut ? "Deconnecte : supprimez auth_info/ et rescannez un QR." : "Reconnexion...",
        );
        if (!loggedOut) {
          setTimeout(() => void this.connect(), 2000);
        }
      }
    });
  }

  private recordIncoming(m: proto.IWebMessageInfo) {
    const jid = m.key.remoteJid;
    if (!jid || jid === "status@broadcast") return;
    const text =
      m.message?.conversation ??
      m.message?.extendedTextMessage?.text ??
      m.message?.imageMessage?.caption ??
      m.message?.videoMessage?.caption ??
      (m.message ? "[message non-texte]" : "");
    if (!text) return;

    const senderJid = m.key.participant || jid;
    const senderName = this.contactNames.get(senderJid) || m.pushName || undefined;

    const fromMe = Boolean(m.key.fromMe);
    recordMessage({
      id: m.key.id ?? `${Date.now()}`,
      chatJid: jid,
      fromMe,
      senderName,
      text,
      timestamp:
        (typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp ?? 0)) * 1000 ||
        Date.now(),
    });

    if (!fromMe) {
      if (isGeminiConfigured()) void this.generateReplySuggestion(jid);
      const displayName = this.contactNames.get(jid) || senderName || getChat(jid)?.name;
      void notifyAllSubscriptions({
        title: displayName || "Nouveau message WhatsApp",
        body: text.slice(0, 140),
        url: `/dashboard/chat/${encodeURIComponent(jid)}`,
      }).catch(() => {});
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

  async numberHasWhatsApp(phoneDigits: string): Promise<boolean> {
    if (!this.sock) throw new Error("WhatsApp non connecte");
    const results = await this.sock.onWhatsApp(phoneDigits);
    return Boolean(results?.[0]?.exists);
  }

  /**
   * `target` peut etre soit un numero en chiffres (ex: envoi automatique
   * depuis le backend, qui ne connait que le numero), soit un JID complet
   * deja connu (ex: reponse a une conversation existante). Certains
   * contacts WhatsApp (notamment via le compte Business) sont identifies
   * par un JID "@lid" (Linked ID, masque le numero reel) plutot que
   * "@s.whatsapp.net" : reconstruire `${phoneDigits}@s.whatsapp.net` dans
   * ce cas enverrait vers une adresse inexistante et echouerait en
   * silence. On garde donc le JID original tel quel quand on l'a.
   */
  async sendText(target: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp non connecte");
    if (!this.connected) throw new Error("WhatsApp pas encore pret (en attente de connexion)");
    const jid = target.includes("@") ? target : `${target}@s.whatsapp.net`;
    const sent = await this.sock.sendMessage(jid, { text });
    // Enregistre le message tout de suite (plutot que d'attendre l'echo
    // asynchrone de WhatsApp via messages.upsert) : sans ca, une page
    // rechargee juste apres l'envoi ne montre pas encore le message qui
    // vient de partir. recordMessage() ignore les doublons si l'echo
    // arrive ensuite avec le meme id.
    const id = sent?.key?.id;
    if (id) {
      recordMessage({ id, chatJid: jid, fromMe: true, text, timestamp: Date.now() });
    }
  }
}

const baileys = new WhatsAppClient();

/** Ce que le reste du service attend d'un client WhatsApp, quel que soit le fournisseur. */
export interface WhatsAppProvider {
  readonly provider: "baileys" | "meta";
  isConnected(): boolean;
  getLastQr(): string | null;
  getInfo(): { provider: string; connected: boolean; number: string | null; error: string | null };
  connect(): Promise<void>;
  numberHasWhatsApp(phoneDigits: string): Promise<boolean>;
  sendText(target: string, text: string): Promise<void>;
  sendTemplate(target: string, name: string, params?: string[], lang?: string, shownText?: string): Promise<void>;
}

/**
 * WHATSAPP_PROVIDER=meta : API officielle (Cloud API).
 * Sinon (par defaut) : connexion par QR code (Baileys), comme avant.
 */
export const whatsapp: WhatsAppProvider = process.env.WHATSAPP_PROVIDER === "meta" ? metaClient : baileys;
