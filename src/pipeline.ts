/**
 * Etapes du parcours d'un prospect, de la premiere prise de contact au
 * client actif.
 *
 * Avant, un prospect n'avait qu'un oui/non « contacte » : on savait qu'on
 * lui avait ecrit, jamais ou en etait la discussion. Ces etapes rendent le
 * suivi lisible et donnent un objectif clair a chaque semaine.
 */

export type Stage = "a_contacter" | "contacte" | "interesse" | "essai" | "client" | "perdu";

export const STAGES: Stage[] = ["a_contacter", "contacte", "interesse", "essai", "client", "perdu"];

export const STAGE_LABELS: Record<Stage, string> = {
  a_contacter: "À contacter",
  contacte: "Contacté",
  interesse: "Intéressé",
  essai: "Essai en cours",
  client: "Client",
  perdu: "Perdu",
};

/** Ce qu'il reste a faire a cette etape, affiche sous le titre de colonne. */
export const STAGE_HINTS: Record<Stage, string> = {
  a_contacter: "Lui écrire un premier message.",
  contacte: "Attendre sa réponse, relancer une fois sous 3 jours.",
  interesse: "Répondre à ses questions, proposer un premier envoi.",
  essai: "Accompagner son premier colis, vérifier que tout s'est bien passé.",
  client: "Garder le contact, demander un avis sur l'app.",
  perdu: "Noter pourquoi, pour ne pas refaire la même erreur.",
};

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as string[]).includes(v);
}

/**
 * Etape d'un prospect enregistre avant l'arrivee du pipeline : on la deduit
 * du seul indicateur qui existait.
 */
export function defaultStage(contacted: boolean): Stage {
  return contacted ? "contacte" : "a_contacter";
}
