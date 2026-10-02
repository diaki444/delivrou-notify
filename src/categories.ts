/**
 * Classement des prospects en 4 familles metier, pour pouvoir prospecter
 * et personnaliser les messages separement par type d'etablissement.
 */

export type ProspectCategory = "pharmacie" | "epicerie" | "restaurant" | "boutique";

export const CATEGORY_ORDER: ProspectCategory[] = ["pharmacie", "epicerie", "restaurant", "boutique"];

export const CATEGORY_LABELS: Record<ProspectCategory, string> = {
  pharmacie: "Pharmacies",
  epicerie: "Épiceries",
  restaurant: "Restaurants",
  boutique: "Boutiques",
};

/** Deduit la famille a partir de la categorie Google Places et/ou de la recherche d'origine. */
export function classifyCategory(category?: string, query?: string): ProspectCategory {
  const text = `${category || ""} ${query || ""}`.toLowerCase();
  if (/pharma/.test(text)) return "pharmacie";
  if (/restaurant|resto\b|fast.?food|caf[ée]|snack|cuisine/.test(text)) return "restaurant";
  if (/[ée]picerie|supermarch|sup[ée]rette|alimentation|grocery|march[ée]/.test(text)) return "epicerie";
  return "boutique";
}

/** Modeles par defaut, courts et directs ("a la guineenne"), avec placeholder {nom}. */
export const DEFAULT_TEMPLATES: Record<ProspectCategory, string> = {
  pharmacie:
    "Bonjour {nom} 👋 Ici Delivrou, service de livraison à Conakry. On peut livrer vos clients rapidement et en toute sécurité. Ça vous intéresse d'en discuter ?",
  epicerie:
    "Bonjour {nom} 👋 Ici Delivrou, livraison rapide à Conakry. On aimerait livrer les commandes de vos clients. On en parle ?",
  restaurant:
    "Bonjour {nom} 👋 Ici Delivrou. On livre les commandes des restaurants à Conakry, rapide et fiable. Intéressé(e) pour collaborer ?",
  boutique:
    "Bonjour {nom} 👋 Ici Delivrou, service de livraison à Conakry. On peut livrer vos clients rapidement. Ça vous dit d'en discuter ?",
};

/** Remplace {nom} (et variantes) par le nom reel du prospect. */
export function personalizeMessage(template: string, name: string): string {
  return template.replace(/\{\s*nom\s*\}/gi, name);
}
