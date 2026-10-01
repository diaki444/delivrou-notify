import { Router } from "express";
import { whatsapp } from "./whatsapp-client.js";
import { getSafetyStatus } from "./safety.js";
import { listChats, getChat, getMessages, listSendLog } from "./store.js";
import { sendWithGuards, queueLength } from "./send-queue.js";
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

function layout(title: string, body: string, nav = true): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — delivrou-notify</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0b141a; color: #e9edef; }
  header { background: #202c33; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 16px; margin: 0; }
  nav a { color: #8696a0; text-decoration: none; margin-left: 16px; font-size: 14px; }
  nav a.active { color: #00a884; font-weight: 600; }
  main { max-width: 900px; margin: 0 auto; padding: 20px; }
  .card { background: #202c33; border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .stat-row { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat { background: #111b21; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 140px; }
  .stat .label { color: #8696a0; font-size: 12px; text-transform: uppercase; }
  .stat .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .ok { color: #00a884; }
  .warn { color: #ffb648; }
  .err { color: #f15c6d; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a3942; }
  th { color: #8696a0; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  a.chat-row { display: block; text-decoration: none; color: inherit; padding: 10px 0; border-bottom: 1px solid #2a3942; }
  a.chat-row:hover { background: #111b21; }
  .chat-name { font-weight: 600; }
  .chat-last { color: #8696a0; font-size: 13px; margin-top: 2px; }
  .bubble { max-width: 70%; padding: 8px 12px; border-radius: 10px; margin: 6px 0; font-size: 14px; line-height: 1.4; }
  .bubble.in { background: #202c33; align-self: flex-start; }
  .bubble.out { background: #005c4b; align-self: flex-end; margin-left: auto; }
  .messages { display: flex; flex-direction: column; max-height: 60vh; overflow-y: auto; padding: 8px 0; }
  form.compose { display: flex; gap: 8px; margin-top: 12px; }
  input[type=text], input[type=password], textarea { background: #2a3942; border: none; border-radius: 8px; padding: 10px 12px; color: #e9edef; font-size: 14px; flex: 1; }
  button { background: #00a884; border: none; border-radius: 8px; padding: 10px 18px; color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
  button:hover { background: #02926f; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.sent { background: #0a3b2e; color: #00a884; }
  .badge.failed { background: #3b1414; color: #f15c6d; }
  .badge.blocked { background: #3b2d0a; color: #ffb648; }
  .badge.auto { background: #1a2a33; color: #8696a0; }
  .badge.manual { background: #1a2a33; color: #53bdeb; }
  .login-box { max-width: 360px; margin: 80px auto; }
  small.muted { color: #667781; }
</style>
</head>
<body>
${
  nav
    ? `<header>
  <h1>delivrou-notify</h1>
  <nav>
    <a href="/dashboard">Conversations</a>
    <a href="/dashboard/logs">Journal</a>
    <a href="/dashboard/logout">Deconnexion</a>
  </nav>
</header>`
    : ""
}
<main>${body}</main>
</body>
</html>`;
}

dashboardRouter.get("/login", (req, res) => {
  if (!isDashboardConfigured()) {
    res
      .status(503)
      .send("Tableau de bord non configure : definissez DASHBOARD_PASSWORD dans les variables d'environnement.");
    return;
  }
  const error = req.query.error ? "<p class='err'>Mot de passe incorrect.</p>" : "";
  res.send(
    layout(
      "Connexion",
      `<div class="card login-box">
        <h2>Connexion</h2>
        ${error}
        <form method="post" action="/dashboard/login">
          <input type="password" name="password" placeholder="Mot de passe" autofocus style="width:100%;box-sizing:border-box;margin-bottom:10px" />
          <button type="submit" style="width:100%">Entrer</button>
        </form>
      </div>`,
      false,
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

dashboardRouter.get("/", (_req, res) => {
  const safety = getSafetyStatus();
  const connected = whatsapp.isConnected();
  const chats = listChats(50);

  const statCards = `
    <div class="stat-row">
      <div class="stat"><div class="label">WhatsApp</div><div class="value ${connected ? "ok" : "err"}">${connected ? "Connecte" : "Deconnecte"}</div></div>
      <div class="stat"><div class="label">Envoyes aujourd'hui</div><div class="value">${safety.sentToday} / ${safety.maxPerDay}</div></div>
      <div class="stat"><div class="label">Cette minute</div><div class="value">${safety.sentLastMinute} / ${safety.maxPerMinute}</div></div>
      <div class="stat"><div class="label">File d'attente</div><div class="value">${queueLength()}</div></div>
      ${safety.circuitOpen ? `<div class="stat"><div class="label">Protection active</div><div class="value warn">Envois suspendus</div></div>` : ""}
    </div>`;

  const chatList =
    chats.length === 0
      ? `<p><small class="muted">Aucune conversation enregistree pour le moment. Elles apparaissent au fur et a mesure que des messages sont recus ou envoyes depuis le demarrage du service.</small></p>`
      : chats
          .map(
            (c) => `<a class="chat-row" href="/dashboard/chat/${encodeURIComponent(c.jid)}">
        <div class="chat-name">${escapeHtml(c.name)}${c.isGroup ? " (groupe)" : ""}</div>
        <div class="chat-last">${escapeHtml((c.lastText || "").slice(0, 80))}</div>
      </a>`,
          )
          .join("");

  res.send(
    layout(
      "Conversations",
      `<div class="card">${statCards}</div>
       <div class="card">
         <h2>Conversations</h2>
         ${chatList}
       </div>
       <div class="card">
         <h2>Envoyer un message manuel</h2>
         <form class="compose" method="post" action="/dashboard/send">
           <input type="text" name="phone" placeholder="Numero (ex: 224612345678)" required />
           <input type="text" name="text" placeholder="Message" required style="flex:2" />
           <button type="submit">Envoyer</button>
         </form>
       </div>`,
    ),
  );
});

dashboardRouter.get("/chat/:jid", (req, res) => {
  const jid = req.params.jid;
  const chat = getChat(jid);
  const msgs = getMessages(jid, 150);

  const bubbles = msgs
    .map(
      (m) =>
        `<div class="bubble ${m.fromMe ? "out" : "in"}">${escapeHtml(m.text)}<br/><small class="muted">${new Date(m.timestamp).toLocaleString("fr-FR")}</small></div>`,
    )
    .join("");

  res.send(
    layout(
      chat?.name || jid,
      `<p><a href="/dashboard" style="color:#8696a0">&larr; Retour</a></p>
       <div class="card">
         <h2>${escapeHtml(chat?.name || jid)}</h2>
         <div class="messages">${bubbles || "<p><small class='muted'>Aucun message enregistre pour cette conversation.</small></p>"}</div>
         <form class="compose" method="post" action="/dashboard/send">
           <input type="hidden" name="jid" value="${escapeHtml(jid)}" />
           <input type="text" name="text" placeholder="Repondre..." required />
           <button type="submit">Envoyer</button>
         </form>
       </div>`,
    ),
  );
});

dashboardRouter.post("/send", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  let phone = String(req.body?.phone || "").replace(/\D/g, "");
  const jid = String(req.body?.jid || "");

  if (!phone && jid) {
    phone = jid.split("@")[0];
  }

  if (!phone || !text) {
    res.redirect(jid ? `/dashboard/chat/${encodeURIComponent(jid)}` : "/dashboard");
    return;
  }

  await sendWithGuards(phone, text, "manual");
  res.redirect(jid ? `/dashboard/chat/${encodeURIComponent(jid)}` : "/dashboard");
});

dashboardRouter.get("/logs", (_req, res) => {
  const log = listSendLog(200);
  const rows = log
    .map(
      (e) => `<tr>
        <td>${new Date(e.timestamp).toLocaleString("fr-FR")}</td>
        <td>${escapeHtml(e.phone)}</td>
        <td>${escapeHtml(e.text.slice(0, 60))}</td>
        <td><span class="badge ${e.source}">${e.source === "auto" ? "Auto" : "Manuel"}</span></td>
        <td><span class="badge ${e.status}">${e.status === "sent" ? "Envoye" : e.status === "failed" ? "Echec" : "Bloque"}</span></td>
        <td><small class="muted">${escapeHtml(e.error || "")}</small></td>
      </tr>`,
    )
    .join("");

  res.send(
    layout(
      "Journal",
      `<div class="card">
        <h2>Journal des envois (200 derniers)</h2>
        <table>
          <thead><tr><th>Date</th><th>Numero</th><th>Message</th><th>Source</th><th>Statut</th><th>Detail</th></tr></thead>
          <tbody>${rows || "<tr><td colspan='6'><small class='muted'>Aucun envoi pour le moment.</small></td></tr>"}</tbody>
        </table>
      </div>`,
    ),
  );
});
