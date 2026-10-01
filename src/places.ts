/**
 * Recherche d'etablissements reels (pharmacies, epiceries, restaurants...)
 * via l'API Google Places (New) - Text Search. Necessite GOOGLE_PLACES_API_KEY.
 */

export interface PlaceResult {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  category?: string;
}

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

export function isPlacesConfigured(): boolean {
  return Boolean(GOOGLE_PLACES_API_KEY);
}

export async function searchPlaces(
  query: string,
): Promise<{ ok: boolean; results: PlaceResult[]; error?: string }> {
  if (!GOOGLE_PLACES_API_KEY) {
    return { ok: false, results: [], error: "GOOGLE_PLACES_API_KEY non configuree sur le serveur." };
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, results: [], error: "Recherche vide." };
  }

  // Ancre la recherche sur Conakry/Guinee si l'utilisateur ne l'a pas deja precise.
  const textQuery = /conakry|guin[ée]e/i.test(trimmed) ? trimmed : `${trimmed} a Conakry, Guinee`;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.primaryTypeDisplayName",
      },
      body: JSON.stringify({ textQuery, languageCode: "fr" }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, results: [], error: `Google Places ${res.status}: ${text.slice(0, 300)}` };
    }

    const data = (await res.json()) as {
      places?: Array<{
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        internationalPhoneNumber?: string;
        primaryTypeDisplayName?: { text?: string };
      }>;
    };

    const results: PlaceResult[] = (data.places ?? []).map((p) => ({
      id: p.id,
      name: p.displayName?.text ?? "Sans nom",
      phone: p.internationalPhoneNumber,
      address: p.formattedAddress,
      category: p.primaryTypeDisplayName?.text,
    }));

    return { ok: true, results };
  } catch (err) {
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Convertit un numero affiche ("+224 612 34 56 78") en chiffres uniquement. */
export function phoneToDigits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}
