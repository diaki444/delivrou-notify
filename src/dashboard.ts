import { Router } from "express";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import {
  listChats,
  getChat,
  getMessages,
  listSendLog,
  listTemplates,
  addTemplate,
  deleteTemplate,
  listProspects,
  addProspects,
  markProspectContacted,
  deleteProspect,
} from "./store.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
import { searchPlaces, phoneToDigits, isPlacesConfigured } from "./places.js";
import {
  isDashboardConfigured,
  checkPassword,
  createSession,
  destroySession,
  getSessionTokenFromRequest,
  setSessionCookie,
  clearSessionCookie,
  requireDashboardAuth,
} from "./auth.js";

export const dashboardRouter = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function timeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const ICONS = {
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18l-6-6 6-6"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h16"/></svg>`,
  chats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  log: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  prospects: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7"/></svg>`,
};

/** Coquille HTML commune (tokens, styles) partagee par toutes les pages du tableau de bord. */
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="format-detection" content="telephone=no" />
<title>${escapeHtml(title)} — delivrou-notify</title>
<style>
  html, body { overflow-x: hidden; max-width: 100%; }
  :root {
    --bg: #0c0b0a;
    --header: #3a1a10;
    --header-2: #4a2316;
    --header-fg: #fbece3;
    --surface: #1c1917;
    --surface-2: #242019;
    --border: #322c26;
    --fg: #f6f1ea;
    --fg-muted: #a89c8d;
    --fg-faint: #786b5c;
    --accent: #ff7a3d;
    --accent-fg: #2a0f02;
    --accent-wash: #3a2113;
    --ok: #3fc98c;
    --ok-wash: #113023;
    --err: #ff6b5a;
    --err-wash: #321713;
    --warn: #ffbb4d;
    --warn-wash: #332511;
    --bubble-in: #221e1a;
    --bubble-out: #4a2316;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  a { color: inherit; }
  .app { max-width: 480px; margin: 0 auto; min-height: 100%; display: flex; flex-direction: column; position: relative; }

  .topbar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: linear-gradient(165deg, var(--header-2), var(--header)); padding: 10px 14px 16px; }
  .topbar-row { display: flex; align-items: center; gap: 10px; }
  .topbar-mark { width: 30px; height: 30px; border-radius: 8px; background: rgba(0,0,0,.32); color: var(--header-fg); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12px; flex: none; }
  .topbar h1 { flex: 1; margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; color: var(--header-fg); }
  .topbar-avatar { width: 30px; height: 30px; border-radius: 50%; background: rgba(0,0,0,.32); color: var(--header-fg); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 11px; flex: none; position: relative; text-decoration: none; }
  .topbar-avatar::after { content: ""; position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--header); }
  .topbar .back-btn { color: var(--header-fg); }
  .search-row { display: flex; gap: 8px; margin-top: 12px; }
  .search-pill { flex: 1; display: flex; align-items: center; gap: 8px; padding: 9px 13px; border-radius: 10px; background: rgba(255,255,255,.14); color: var(--header-fg); min-width: 0; border: none; }
  .search-pill svg { width: 15px; height: 15px; opacity: .8; flex: none; }
  .search-pill input { background: none; border: none; outline: none; color: var(--header-fg); font-size: 16px; width: 100%; }
  .search-pill input::placeholder { color: rgba(251,236,227,.7); }
  .filter-btn { width: 36px; height: 36px; border-radius: 10px; border: none; background: rgba(255,255,255,.14); color: var(--header-fg); display: flex; align-items: center; justify-content: center; flex: none; text-decoration: none; }
  .filter-btn svg { width: 16px; height: 16px; }

  .chip-row { display: flex; gap: 8px; padding: 12px 14px; overflow-x: auto; background: var(--bg); }
  .chip-card { flex: none; min-width: 104px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 9px 11px; }
  .chip-card .chip-icon { font-size: 15px; line-height: 1; }
  .chip-card .label { font-size: 13.5px; font-weight: 700; margin-top: 6px; color: var(--fg); }
  .chip-card .value { font-size: 11.5px; color: var(--fg-muted); margin-top: 1px; font-variant-numeric: tabular-nums; }
  .chip-card.is-live { border-color: var(--accent); }

  .section-label { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; font-size: 13.5px; font-weight: 700; color: var(--fg); }

  .list { flex: 1; overflow-y: auto; padding-bottom: 90px; }
  .chat-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 16px; background: none; border: none; text-align: left; cursor: pointer; color: inherit; font: inherit; text-decoration: none; }
  .chat-row:active { background: var(--surface); }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; color: var(--accent-fg); background: var(--accent); flex: none; }
  .avatar.group { background: var(--fg-muted); color: var(--bg); }
  .chat-main { flex: 1; min-width: 0; }
  .chat-top { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .chat-name { font-weight: 700; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-time { font-size: 11px; color: var(--fg-faint); flex: none; font-variant-numeric: tabular-nums; }
  .chat-preview { font-size: 13px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .chat-preview b { color: var(--fg); font-weight: 600; }
  .empty { padding: 48px 24px; text-align: center; color: var(--fg-muted); font-size: 14px; }

  .fab { position: fixed; right: 20px; bottom: calc(76px + env(safe-area-inset-bottom, 0px)); width: 52px; height: 52px; border-radius: 50%; background: var(--accent); color: var(--accent-fg); border: none; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 18px rgba(255,122,61,.35); cursor: pointer; z-index: 6; text-decoration: none; }
  .fab svg { width: 22px; height: 22px; }
  .fab-wrap { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }

  .composer { display: flex; gap: 8px; padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); background: var(--surface); border-top: 1px solid var(--border); }
  .composer input[type=text] { flex: 1; border: 1px solid var(--border); background: var(--surface-2); border-radius: 20px; padding: 10px 14px; font-size: 16px; color: var(--fg); min-width: 0; }
  .composer input::placeholder { color: var(--fg-faint); }
  .composer input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .send-btn { width: 38px; height: 38px; border-radius: 50%; border: none; background: var(--accent); color: var(--accent-fg); cursor: pointer; flex: none; display: flex; align-items: center; justify-content: center; }
  .send-btn svg { width: 15px; height: 15px; }

  .chat-header { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 6px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .back-btn { border: none; background: none; color: var(--fg); cursor: pointer; padding: 6px; flex: none; display: flex; }
  .back-btn svg { width: 20px; height: 20px; }
  .chat-header .avatar { width: 32px; height: 32px; font-size: 12px; flex: none; }
  .chat-header-id { flex: 1; min-width: 0; }
  .chat-header-name { font-weight: 700; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-header-sub { font-size: 11.5px; color: var(--fg-muted); }

  .messages { flex: 1; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 2px; background: var(--bg); }
  .day-sep { align-self: center; font-size: 11px; color: var(--fg-faint); background: var(--surface); padding: 3px 10px; border-radius: 999px; margin: 10px 0; }
  .bubble-row { display: flex; }
  .bubble-row.out { justify-content: flex-end; }
  .bubble { max-width: 78%; padding: 8px 11px 7px; border-radius: 14px; font-size: 14px; line-height: 1.38; margin: 3px 0; white-space: pre-wrap; word-break: break-word; }
  .bubble.in { background: var(--bubble-in); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
  .bubble.out { background: var(--bubble-out); border-bottom-right-radius: 4px; }
  .bubble .time { display: block; font-size: 10px; color: var(--fg-faint); margin-top: 3px; text-align: right; font-variant-numeric: tabular-nums; }

  .filters { display: flex; gap: 6px; padding: 10px 14px; overflow-x: auto; background: var(--bg); }
  .filter-pill { flex: none; font-size: 12.5px; font-weight: 700; padding: 6px 13px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--fg-muted); cursor: pointer; text-decoration: none; }
  .filter-pill.is-active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }

  .log-list { flex: 1; overflow-y: auto; padding: 4px 0 90px; }
  .log-day-label { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-faint); padding: 14px 16px 6px; }
  .log-item { display: flex; gap: 12px; align-items: flex-start; padding: 10px 16px; }
  .log-icon { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; flex: none; margin-top: 1px; }
  .log-icon.sent { background: var(--ok-wash); color: var(--ok); }
  .log-icon.failed { background: var(--err-wash); color: var(--err); }
  .log-icon.blocked { background: var(--warn-wash); color: var(--warn); }
  .log-main { flex: 1; min-width: 0; }
  .log-top { display: flex; justify-content: space-between; gap: 8px; }
  .log-phone { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
  .log-time { font-size: 11.5px; color: var(--fg-faint); flex: none; font-variant-numeric: tabular-nums; }
  .log-text { font-size: 13px; color: var(--fg-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
  .log-badges { display: flex; gap: 6px; margin-top: 6px; }
  .badge { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .badge.sent { background: var(--ok-wash); color: var(--ok); }
  .badge.failed { background: var(--err-wash); color: var(--err); }
  .badge.blocked { background: var(--warn-wash); color: var(--warn); }
  .badge.auto { background: var(--surface-2); color: var(--fg-muted); border: 1px solid var(--border); }
  .badge.manual { background: var(--accent-wash); color: var(--accent); }
  .log-reason { font-size: 12px; color: var(--err); margin-top: 4px; }

  .tabbar { position: sticky; bottom: 0; display: flex; background: var(--surface); border-top: 1px solid var(--border); padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px)); }
  .tab { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; background: none; border: none; color: var(--fg-faint); font-size: 11px; font-weight: 600; padding: 6px 0; cursor: pointer; position: relative; text-decoration: none; }
  .tab.is-active { color: var(--fg); }
  .tab.is-active svg { color: var(--accent); }
  .tab svg { width: 22px; height: 22px; }
  .tab .tab-dot { position: absolute; top: 2px; right: calc(50% - 16px); width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }

  .login-wrap { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 32px 28px calc(32px + env(safe-area-inset-bottom, 0px)); gap: 22px; }
  .login-mark { width: 52px; height: 52px; border-radius: 14px; background: linear-gradient(165deg, var(--header-2), var(--header)); color: var(--header-fg); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; }
  .login-title { font-size: 21px; font-weight: 800; margin: 0; }
  .login-sub { font-size: 13.5px; color: var(--fg-muted); margin-top: 4px; }
  .field-label { font-size: 12.5px; font-weight: 600; color: var(--fg-muted); margin-bottom: 6px; display: block; }
  .text-input { width: 100%; padding: 13px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--fg); font-size: 16px; }
  .text-input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .primary-btn { width: 100%; padding: 13px; border-radius: 10px; border: none; background: var(--accent); color: var(--accent-fg); font-size: 15px; font-weight: 800; cursor: pointer; }
  .login-foot { font-size: 12px; color: var(--fg-faint); text-align: center; }

  .page-pad { padding: 14px 16px calc(90px + env(safe-area-inset-bottom, 0px)); }
  .err-banner { background: var(--err-wash); color: var(--err); padding: 10px 14px; border-radius: 10px; font-size: 13.5px; margin-bottom: 12px; }
  .template-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  .template-name { font-weight: 700; font-size: 14px; }
  .template-body { font-size: 13px; color: var(--fg-muted); margin-top: 4px; white-space: pre-wrap; }
  .template-actions { display: flex; gap: 8px; margin-top: 10px; }
  .ghost-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--fg-muted); border-radius: 8px; padding: 7px 11px; font-size: 12.5px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 5px; }
  .ghost-btn svg { width: 13px; height: 13px; }
  textarea.text-input { resize: vertical; min-height: 80px; font-family: inherit; }

  .search-form-row { display: flex; gap: 8px; margin-bottom: 14px; }
  .search-form-row input { flex: 1; }
  .prospect-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 11px 13px; margin-bottom: 8px; display: flex; gap: 10px; align-items: flex-start; }
  .prospect-card input[type=checkbox] { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent); flex: none; }
  .prospect-main { flex: 1; min-width: 0; }
  .prospect-name { font-weight: 700; font-size: 14px; }
  .prospect-meta { font-size: 12.5px; color: var(--fg-muted); margin-top: 2px; }
  .prospect-phone { font-size: 12.5px; color: var(--fg); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .prospect-contacted { font-size: 10.5px; font-weight: 700; color: var(--ok); background: var(--ok-wash); padding: 1px 7px; border-radius: 999px; display: inline-block; margin-top: 4px; }
  .select-all-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 13px; color: var(--fg-muted); }
  .select-all-row input { width: 16px; height: 16px; accent-color: var(--accent); }
  .compose-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-top: 14px; }
</style>
</head>
<body>
<div class="app">
${bodyHtml}
</div>
</body>
</html>`;
}

function tabbar(active: "chats" | "logs" | "prospects"): string {
  const tab = (key: "chats" | "logs" | "prospects", href: string, icon: string, label: string) =>
    `<a class="tab ${active === key ? "is-active" : ""}" href="${href}">${active === key ? '<span class="tab-dot"></span>' : ""}${icon}${label}</a>`;
  return `<div class="tabbar">
    ${tab("chats", "/dashboard", ICONS.chats, "Conversations")}
    ${tab("prospects", "/dashboard/prospection", ICONS.prospects, "Prospects")}
    ${tab("logs", "/dashboard/logs", ICONS.log, "Journal")}
  </div>`;
}

dashboardRouter.get("/login", (req, res) => {
  if (!isDashboardConfigured()) {
    res
      .status(503)
      .send("Tableau de bord non configure : definissez DASHBOARD_PASSWORD dans les variables d'environnement.");
    return;
  }
  const error = req.query.error ? `<div class="err-banner">Mot de passe incorrect.</div>` : "";
  res.send(
    shell(
      "Connexion",
      `<div class="login-wrap">
        <div class="login-mark">DN</div>
        <div>
          <h1 class="login-title">delivrou-notify</h1>
          <p class="login-sub">Entrez le mot de passe pour acceder aux conversations et au journal d'envoi.</p>
        </div>
        ${error}
        <form method="post" action="/dashboard/login">
          <label class="field-label" for="password">Mot de passe</label>
          <input class="text-input" type="password" id="password" name="password" placeholder="••••••••" autofocus style="margin-bottom:14px" />
          <button class="primary-btn" type="submit">Entrer</button>
        </form>
        <p class="login-foot">notify.delivrou.com</p>
      </div>`,
    ),
  );
});

dashboardRouter.post("/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!checkPassword(password)) {
    res.redirect("/dashboard/login?error=1");
    return;
  }
  const token = createSession();
  setSessionCookie(res, token);
  res.redirect("/dashboard");
});

dashboardRouter.get("/logout", (req, res) => {
  destroySession(getSessionTokenFromRequest(req));
  clearSessionCookie(res);
  res.redirect("/dashboard/login");
});

dashboardRouter.use(requireDashboardAuth);

dashboardRouter.get("/", (req, res) => {
  const safety = getSafetyStatus();
  const connected = whatsapp.isConnected();
  const q = String(req.query.q || "").trim().toLowerCase();
  let chats = listChats(100);
  if (q) chats = chats.filter((c) => c.name.toLowerCase().includes(q));

  const chatRows = chats.length
    ? chats
        .map(
          (c) => `<a class="chat-row" href="/dashboard/chat/${encodeURIComponent(c.jid)}">
        <div class="avatar ${c.isGroup ? "group" : ""}">${escapeHtml(initials(c.name))}</div>
        <div class="chat-main">
          <div class="chat-top">
            <span class="chat-name">${escapeHtml(c.name)}</span>
            <span class="chat-time">${c.lastTimestamp ? timeShort(c.lastTimestamp) : ""}</span>
          </div>
          <div class="chat-preview">${escapeHtml((c.lastText || "").slice(0, 90))}</div>
        </div>
      </a>`,
        )
        .join("")
    : `<div class="empty">${q ? "Aucune conversation ne correspond a votre recherche." : "Aucune conversation enregistree pour le moment. Elles apparaissent au fur et a mesure des messages recus ou envoyes depuis le demarrage du service."}</div>`;

  res.send(
    shell(
      "Conversations",
      `<div class="fab-wrap">
        <div class="topbar">
          <div class="topbar-row">
            <div class="topbar-mark">DN</div>
            <h1>Delivrou Notify</h1>
            <a class="topbar-avatar" href="/dashboard/templates">A</a>
          </div>
          <form class="search-row" method="get" action="/dashboard">
            <label class="search-pill">
              ${ICONS.search}
              <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Rechercher une conversation..." />
            </label>
            <a class="filter-btn" href="/dashboard/templates" aria-label="Modeles de message">${ICONS.template}</a>
          </form>
        </div>

        <div class="chip-row">
          <div class="chip-card is-live"><div class="chip-icon">${connected ? "🟢" : "🔴"}</div><div class="label">WhatsApp</div><div class="value">${connected ? "Connecté" : "Déconnecté"}</div></div>
          <div class="chip-card"><div class="chip-icon">📨</div><div class="label">${safety.sentToday} / ${safety.maxPerDay}</div><div class="value">Envoyés aujourd'hui</div></div>
          <div class="chip-card"><div class="chip-icon">⏱️</div><div class="label">${safety.sentLastMinute} / ${safety.maxPerMinute}</div><div class="value">Cette minute</div></div>
          <div class="chip-card"><div class="chip-icon">📥</div><div class="label">${queueLength()}</div><div class="value">File d'attente</div></div>
          ${safety.circuitOpen ? `<div class="chip-card" style="border-color:var(--err)"><div class="chip-icon">⚠️</div><div class="label">Suspendu</div><div class="value">Protection active</div></div>` : ""}
        </div>

        <div class="list">
          <div class="section-label">Conversations</div>
          ${chatRows}
        </div>

        <a class="fab" href="/dashboard/compose" aria-label="Nouveau message">${ICONS.plus}</a>
      </div>
      ${tabbar("chats")}`,
    ),
  );
});

dashboardRouter.get("/compose", (_req, res) => {
  const templates = listTemplates();
  res.send(
    shell(
      "Nouveau message",
      `<div class="chat-header">
        <a class="back-btn" href="/dashboard" aria-label="Retour">${ICONS.back}</a>
        <div class="chat-header-id"><div class="chat-header-name">Nouveau message</div></div>
      </div>
      <div class="page-pad">
        <form method="post" action="/dashboard/send">
          <label class="field-label" for="phone">Numero (avec indicatif pays, chiffres uniquement)</label>
          <input class="text-input" type="text" id="phone" name="phone" placeholder="224612345678" required style="margin-bottom:14px" />

          ${
            templates.length
              ? `<label class="field-label" for="tpl">Partir d'un modele (optionnel)</label>
                 <select class="text-input" id="tpl" style="margin-bottom:14px" onchange="document.getElementById('text').value=this.value">
                   <option value="">— Aucun —</option>
                   ${templates.map((t) => `<option value="${escapeHtml(t.body)}">${escapeHtml(t.name)}</option>`).join("")}
                 </select>`
              : ""
          }

          <label class="field-label" for="text">Message</label>
          <textarea class="text-input" id="text" name="text" rows="4" required style="margin-bottom:14px"></textarea>

          <button class="primary-btn" type="submit">Envoyer</button>
        </form>
      </div>`,
    ),
  );
});

dashboardRouter.get("/chat/:jid", (req, res) => {
  const jid = req.params.jid;
  const chat = getChat(jid);
  const msgs = getMessages(jid, 150);
  const name = chat?.name || jid;

  let lastDay = "";
  const bubbles = msgs
    .map((m) => {
      const day = new Date(m.timestamp).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const sep = day !== lastDay ? `<div class="day-sep">${escapeHtml(day)}</div>` : "";
      lastDay = day;
      return `${sep}<div class="bubble-row ${m.fromMe ? "out" : "in"}"><div class="bubble ${m.fromMe ? "out" : "in"}">${escapeHtml(m.text)}<span class="time">${timeShort(m.timestamp)}</span></div></div>`;
    })
    .join("");

  res.send(
    shell(
      name,
      `<div class="chat-header">
        <a class="back-btn" href="/dashboard" aria-label="Retour">${ICONS.back}</a>
        <div class="avatar ${chat?.isGroup ? "group" : ""}">${escapeHtml(initials(name))}</div>
        <div class="chat-header-id">
          <div class="chat-header-name">${escapeHtml(name)}</div>
          <div class="chat-header-sub">${escapeHtml(jid.split("@")[0])}</div>
        </div>
      </div>
      <div class="messages">
        ${bubbles || `<div class="empty">Aucun message enregistre pour cette conversation.</div>`}
      </div>
      <form class="composer" method="post" action="/dashboard/send">
        <input type="hidden" name="jid" value="${escapeHtml(jid)}" />
        <input type="text" name="text" placeholder="Répondre..." required />
        <button class="send-btn" type="submit" aria-label="Envoyer">${ICONS.send}</button>
      </form>`,
    ),
  );
});

dashboardRouter.post("/send", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  let phone = String(req.body?.phone || "").replace(/\D/g, "");
  const jid = String(req.body?.jid || "");

  if (!phone && jid) phone = jid.split("@")[0];

  if (!phone || !text) {
    res.redirect(jid ? `/dashboard/chat/${encodeURIComponent(jid)}` : "/dashboard");
    return;
  }

  await sendWithGuards(phone, text, "manual");
  res.redirect(jid ? `/dashboard/chat/${encodeURIComponent(jid)}` : "/dashboard");
});

dashboardRouter.get("/logs", (req, res) => {
  const filter = String(req.query.filter || "all");
  let log = listSendLog(500);
  if (filter === "sent") log = log.filter((e) => e.status === "sent");
  else if (filter === "failed") log = log.filter((e) => e.status === "failed");
  else if (filter === "blocked") log = log.filter((e) => e.status === "blocked");
  else if (filter === "manual") log = log.filter((e) => e.source === "manual");
  log = log.slice(0, 200);

  let lastDay = "";
  const rows = log
    .map((e) => {
      const day = new Date(e.timestamp).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const label = day !== lastDay ? `<div class="log-day-label">${escapeHtml(day)}</div>` : "";
      lastDay = day;
      const icon = e.status === "sent" ? "✓" : e.status === "failed" ? "!" : "⏱";
      const statusLabel = e.status === "sent" ? "Envoyé" : e.status === "failed" ? "Échec" : "Bloqué";
      return `${label}<div class="log-item">
        <div class="log-icon ${e.status}">${icon}</div>
        <div class="log-main">
          <div class="log-top"><span class="log-phone">${escapeHtml(e.phone)}</span><span class="log-time">${timeShort(e.timestamp)}</span></div>
          <div class="log-text">${escapeHtml(e.text.slice(0, 90))}</div>
          <div class="log-badges">
            <span class="badge ${e.status}">${statusLabel}</span>
            <span class="badge ${e.source}">${e.source === "auto" ? "Auto" : "Manuel"}</span>
          </div>
          ${e.error ? `<div class="log-reason">${escapeHtml(e.error)}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");

  const filters: Array<[string, string]> = [
    ["all", "Tout"],
    ["sent", "Envoyés"],
    ["failed", "Échecs"],
    ["blocked", "Bloqués"],
    ["manual", "Manuel"],
  ];

  res.send(
    shell(
      "Journal",
      `<div class="topbar" style="padding-bottom:14px">
        <div class="topbar-row">
          <a class="back-btn" href="/dashboard" aria-label="Retour" style="margin-right:-4px">${ICONS.back}</a>
          <h1>Journal</h1>
          <a class="topbar-avatar" href="/dashboard/templates">A</a>
        </div>
      </div>
      <div class="filters">
        ${filters.map(([key, label]) => `<a class="filter-pill ${filter === key ? "is-active" : ""}" href="/dashboard/logs?filter=${key}">${label}</a>`).join("")}
      </div>
      <div class="log-list">
        ${rows || `<div class="empty">Aucun envoi pour ce filtre.</div>`}
      </div>
      ${tabbar("logs")}`,
    ),
  );
});

dashboardRouter.get("/templates", (_req, res) => {
  const templates = listTemplates();
  res.send(
    shell(
      "Modèles de message",
      `<div class="chat-header">
        <a class="back-btn" href="/dashboard" aria-label="Retour">${ICONS.back}</a>
        <div class="chat-header-id"><div class="chat-header-name">Modèles de message</div></div>
      </div>
      <div class="page-pad">
        ${
          templates.length
            ? templates
                .map(
                  (t) => `<div class="template-card">
                  <div class="template-name">${escapeHtml(t.name)}</div>
                  <div class="template-body">${escapeHtml(t.body)}</div>
                  <div class="template-actions">
                    <form method="post" action="/dashboard/templates/${t.id}/delete" onsubmit="return true">
                      <button class="ghost-btn" type="submit">${ICONS.trash} Supprimer</button>
                    </form>
                  </div>
                </div>`,
                )
                .join("")
            : `<div class="empty">Aucun modèle pour le moment. Créez-en un ci-dessous pour gagner du temps sur vos messages manuels (relances, réponses fréquentes...).</div>`
        }

        <h2 style="font-size:15px;margin:20px 0 10px">Nouveau modèle</h2>
        <form method="post" action="/dashboard/templates">
          <label class="field-label" for="name">Nom</label>
          <input class="text-input" type="text" id="name" name="name" placeholder="Ex: Relance panier abandonné" required style="margin-bottom:14px" />
          <label class="field-label" for="body">Message</label>
          <textarea class="text-input" id="body" name="body" rows="4" required style="margin-bottom:14px"></textarea>
          <button class="primary-btn" type="submit">Enregistrer le modèle</button>
        </form>
      </div>`,
    ),
  );
});

dashboardRouter.post("/templates", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const body = String(req.body?.body || "").trim();
  if (name && body) addTemplate(name, body);
  res.redirect("/dashboard/templates");
});

dashboardRouter.post("/templates/:id/delete", (req, res) => {
  deleteTemplate(req.params.id);
  res.redirect("/dashboard/templates");
});

dashboardRouter.get("/prospection", (req, res) => {
  const prospects = listProspects(300);
  const templates = listTemplates();

  let banner = "";
  if (req.query.searchError) {
    banner = `<div class="err-banner">${escapeHtml(String(req.query.searchError))}</div>`;
  } else if (req.query.added !== undefined) {
    const added = Number(req.query.added) || 0;
    const dup = Number(req.query.dup) || 0;
    banner = `<div class="err-banner" style="background:var(--ok-wash);color:var(--ok)">${added} nouveau(x) prospect(s) ajouté(s)${dup ? `, ${dup} déjà présent(s) ignoré(s)` : ""}.</div>`;
  } else if (req.query.sent !== undefined) {
    const sent = Number(req.query.sent) || 0;
    const failed = Number(req.query.failed) || 0;
    banner = `<div class="err-banner" style="background:var(--ok-wash);color:var(--ok)">${sent} message(s) envoyé(s)${failed ? `, ${failed} échec(s)/bloqué(s)` : ""}.</div>`;
  }

  const prospectRows = prospects.length
    ? prospects
        .map(
          (p) => `<label class="prospect-card">
        <input type="checkbox" name="ids" value="${escapeHtml(p.id)}" checked />
        <div class="prospect-main">
          <div class="prospect-name">${escapeHtml(p.name)}</div>
          ${p.category || p.address ? `<div class="prospect-meta">${escapeHtml([p.category, p.address].filter(Boolean).join(" · "))}</div>` : ""}
          <div class="prospect-phone">${escapeHtml(p.phone)}</div>
          ${p.contacted ? `<span class="prospect-contacted">Contacté</span>` : ""}
        </div>
      </label>`,
        )
        .join("")
    : `<div class="empty">Aucun prospect pour le moment. Cherchez ci-dessus (ex: "pharmacies", "épiceries", "restaurants") pour en ajouter automatiquement.</div>`;

  res.send(
    shell(
      "Prospection",
      `<div class="topbar" style="padding-bottom:14px">
        <div class="topbar-row">
          <div class="topbar-mark">DN</div>
          <h1>Prospection</h1>
          <a class="topbar-avatar" href="/dashboard/templates">A</a>
        </div>
      </div>
      <div class="page-pad">
        ${banner}
        ${
          !isPlacesConfigured()
            ? `<div class="err-banner">Recherche non configurée : définissez GOOGLE_PLACES_API_KEY dans les variables d'environnement pour activer la recherche automatique d'établissements.</div>`
            : ""
        }
        <form class="search-form-row" method="post" action="/dashboard/prospection/search">
          <input class="text-input" type="text" name="query" placeholder="Ex: pharmacies, épiceries, restaurants..." required />
          <button class="primary-btn" type="submit" style="width:auto;white-space:nowrap">${ICONS.search}</button>
        </form>

        <h2 style="font-size:15px;margin:4px 0 10px">Prospects (${prospects.length})</h2>

        <form method="post" action="/dashboard/prospection/send">
          ${
            prospects.length
              ? `<label class="select-all-row"><input type="checkbox" checked onchange="this.form.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)" /> Tout cocher</label>`
              : ""
          }
          ${prospectRows}

          ${
            prospects.length
              ? `<div class="compose-bar">
                  ${
                    templates.length
                      ? `<select class="text-input" style="margin-bottom:8px" onchange="this.form.querySelector('[name=text]').value=this.value">
                           <option value="">— Choisir un modèle —</option>
                           ${templates.map((t) => `<option value="${escapeHtml(t.body)}">${escapeHtml(t.name)}</option>`).join("")}
                         </select>`
                      : ""
                  }
                  <div style="display:flex;gap:8px">
                    <input class="text-input" type="text" name="text" placeholder="Message à envoyer aux prospects cochés" required />
                    <button class="send-btn" type="submit" aria-label="Envoyer" style="width:auto;padding:0 16px">${ICONS.send}</button>
                  </div>
                </div>`
              : ""
          }
        </form>
      </div>
      ${tabbar("prospects")}`,
    ),
  );
});

dashboardRouter.post("/prospection/search", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (!query) {
    res.redirect("/dashboard/prospection");
    return;
  }

  const result = await searchPlaces(query);
  if (!result.ok) {
    res.redirect(`/dashboard/prospection?searchError=${encodeURIComponent(result.error || "Recherche échouée")}`);
    return;
  }

  const withPhone = result.results
    .map((r) => {
      const phone = r.phone ? phoneToDigits(r.phone) : null;
      return phone ? { id: r.id, name: r.name, phone, address: r.address, category: r.category } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const { added, duplicates } = addProspects(query, withPhone);
  res.redirect(`/dashboard/prospection?added=${added}&dup=${duplicates}`);
});

dashboardRouter.post("/prospection/send", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const rawIds = req.body?.ids;
  const ids = Array.isArray(rawIds) ? rawIds.map(String) : rawIds ? [String(rawIds)] : [];

  if (!text || ids.length === 0) {
    res.redirect("/dashboard/prospection");
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const prospects = listProspects(1000);
    const p = prospects.find((x) => x.id === id);
    if (!p) continue;
    const result = await sendWithGuards(p.phone, text, "manual");
    if (result.ok) {
      markProspectContacted(id);
      sent++;
    } else {
      failed++;
    }
  }

  res.redirect(`/dashboard/prospection?sent=${sent}&failed=${failed}`);
});

dashboardRouter.post("/prospection/:id/delete", (req, res) => {
  deleteProspect(req.params.id);
  res.redirect("/dashboard/prospection");
});
