import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Authentification minimaliste a mot de passe unique pour le tableau de
 * bord web (pas de gestion multi-utilisateurs). Les sessions vivent en
 * memoire : un redemarrage du service deconnecte tout le monde, ce qui est
 * un compromis acceptable pour cet usage.
 */

const ADMIN_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_COOKIE = "delivrou_notify_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

const sessions = new Map<string, number>(); // token -> expiry (ms epoch)

export function isDashboardConfigured(): boolean {
  return Boolean(ADMIN_PASSWORD);
}

export function checkPassword(password: string): boolean {
  if (!ADMIN_PASSWORD) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getSessionTokenFromRequest(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function setSessionCookie(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
}

export function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction) {
  if (!isDashboardConfigured()) {
    res
      .status(503)
      .send("Tableau de bord non configure : definissez DASHBOARD_PASSWORD dans les variables d'environnement.");
    return;
  }
  const token = getSessionTokenFromRequest(req);
  if (!isValidSession(token)) {
    res.redirect("/dashboard/login");
    return;
  }
  next();
}
