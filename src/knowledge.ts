/**
 * Base de connaissances de l'IA : les reponses types et les regles ecrites
 * dans le QG marketing.
 *
 * Avant, le modele n'avait que le contexte entreprise fige dans gemini.ts.
 * Les reponses types, elles, vivent dans le QG (`data/reponses.json`) et
 * sont revues regulierement : c'est la vraie source de verite sur la facon
 * de repondre. On la lui donne ici, sans rien dupliquer — si le QG change,
 * l'IA suit au prochain appel.
 *
 * Le fichier peut etre absent (QG pas encore deploye) : dans ce cas on
 * renvoie une chaine vide et le modele garde son contexte de base.
 */

import fs from "node:fs";
import path from "node:path";

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(process.cwd(), "auth_info");
const FILE = path.join(AUTH_DIR, "qg", "data", "reponses.json");
const MAX_CHARS = Number(process.env.KNOWLEDGE_MAX_CHARS || 6000);

interface Item {
  q?: unknown;
  r?: unknown;
}
interface Categorie {
  nom?: unknown;
  items?: unknown;
}
interface Fichier {
  regles?: unknown;
  categories?: unknown;
}

let cached = "";
let cachedAt = 0;

/**
 * Les regles et reponses types du QG, en texte brut pour le prompt.
 * Relu quand le fichier change (le QG le redepose a chaque mise a jour).
 */
export function qgKnowledge(): string {
  let mtime = 0;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    return "";
  }
  if (mtime === cachedAt) return cached;

  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as Fichier;
    const parts: string[] = [];

    const regles = Array.isArray(data.regles) ? data.regles.filter((r): r is string => typeof r === "string") : [];
    if (regles.length) parts.push("REGLES DE REPONSE (QG marketing) :\n" + regles.map((r) => `- ${r}`).join("\n"));

    const cats = Array.isArray(data.categories) ? (data.categories as Categorie[]) : [];
    const lignes: string[] = [];
    for (const c of cats) {
      const items = Array.isArray(c.items) ? (c.items as Item[]) : [];
      for (const it of items) {
        if (typeof it.q === "string" && typeof it.r === "string") lignes.push(`- ${it.q} -> ${it.r}`);
      }
    }
    if (lignes.length) parts.push("REPONSES TYPES VALIDEES (s'en inspirer, ne pas les recopier mot pour mot) :\n" + lignes.join("\n"));

    cached = parts.join("\n\n").slice(0, MAX_CHARS);
    cachedAt = mtime;
    return cached;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[delivrou-notify] reponses.json illisible:", err instanceof Error ? err.message : err);
    return "";
  }
}
