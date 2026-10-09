# delivrou-notify

Service de notification WhatsApp pour **delivrou.com**, sans Twilio, NimbaSMS ni Wazzap AI.

Il expose une API HTTP toute simple (`POST /send`) appelee par le backend de Delivrou a chaque evenement important (suivi de commande, etc.), et envoie le message via **l'API officielle WhatsApp Business Platform (Cloud API) de Meta** — pas de QR code, pas de session a maintenir, pas de risque de bannissement du numero.

> Ce service utilisait auparavant [Baileys](https://github.com/WhiskeySockets/Baileys) (protocole WhatsApp Web non officiel, QR code). Il a ete migre vers l'API officielle de Meta le 9 octobre 2026, suite a un incident ou le mauvais numero avait ete connecte — l'API officielle elimine ce genre de risque (pas de session a scanner, pas de blocage possible du numero pour "automatisation non sanctionnee").

## ⚠️ Important — la fenetre de 24 heures et les modeles de message

L'API officielle impose une regle que Baileys n'avait pas : vous ne pouvez envoyer un **message texte libre** que dans les 24h suivant le dernier message **recu** de ce contact. Au-dela (ou pour le tout premier message a un nouveau client), il faut utiliser un **modele de message ("template") pre-approuve par Meta**.

En pratique pour Delivrou :
- Une **reponse manuelle** a un client qui vient d'ecrire : fonctionne toujours en texte libre (fenetre ouverte).
- Le **suivi de commande automatique** : c'est souvent le tout premier message au client pour cette commande (fenetre fermee) → il faut un **modele de message approuve** pour que l'envoi reussisse de maniere fiable. Voir [developers.facebook.com](https://developers.facebook.com) > votre app > WhatsApp > Gestionnaire WhatsApp > Modeles de message, pour creer et soumettre un modele "Suivi de commande" a Meta (approbation generalement en quelques heures).

Tant qu'aucun modele n'est approuve, les envois en dehors de la fenetre de 24h echoueront (visible dans `/dashboard/logs`) — **ce n'est pas un bug**, c'est la regle de l'API officielle.

## ⚠️ Usage responsable

- Utilisez ceci uniquement pour des **notifications transactionnelles** (le client a une relation active avec Delivrou : commande en cours). Ce n'est pas un outil de SMS marketing de masse — pour la prospection a froid, des regles encore plus strictes de Meta s'appliquent (categorie "marketing" des modeles).
- Respectez le RGPD / les regles locales sur les communications electroniques : vos utilisateurs doivent savoir qu'ils recevront des notifications WhatsApp (mention dans vos CGU / parametres de notification).

## Installation

```bash
npm install
npm run build
```

## Configurer l'API WhatsApp Business (Meta Cloud API)

1. Creez un compte [Meta Business Manager](https://business.facebook.com) et une app sur [developers.facebook.com](https://developers.facebook.com) (type "Entreprise", cas d'utilisation "WhatsApp").
2. Reliez votre numero WhatsApp Business existant (ou enregistrez-en un nouveau) dans **Gestionnaire WhatsApp**.
3. Recuperez le **Phone Number ID** (Gestionnaire WhatsApp > Numeros de telephone > cliquez sur votre numero).
4. Generez un **token d'acces permanent** : Parametres de l'entreprise > Utilisateurs systeme > creez-en un, affectez-lui l'app et le compte WhatsApp (acces "Tout"/controle total sur les deux), puis "Generer un token" en cochant `whatsapp_business_management` et `whatsapp_business_messaging`.
5. Configurez le **webhook** (pour recevoir les reponses des clients) : dans l'app > WhatsApp > Configuration > Webhooks, mettez l'URL `https://votre-domaine/webhook/whatsapp` et un token de verification de votre choix (meme valeur que `WHATSAPP_WEBHOOK_VERIFY_TOKEN` ci-dessous), puis abonnez-vous au champ `messages`.

Mettez ces valeurs dans `.env` (voir `.env.example`).

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `NOTIFY_SECRET` | Oui | Cle partagee a fournir dans l'en-tete `x-notify-key` pour authentifier les appels entrants. |
| `WHATSAPP_PHONE_NUMBER_ID` | Oui | Identifiant du numero WhatsApp (Gestionnaire WhatsApp > Numeros de telephone). |
| `WHATSAPP_ACCESS_TOKEN` | Oui | Token d'acces permanent (genere via un utilisateur systeme). |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Oui (pour recevoir les messages) | Doit correspondre exactement au token saisi cote Meta lors de la configuration du webhook. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Non | ID du compte WhatsApp Business (WABA), utile pour la gestion des modeles de message. |
| `WHATSAPP_API_VERSION` | Non (def. v21.0) | Version de l'API Graph utilisee. |
| `PORT` | Non (def. 3300) | Port d'ecoute HTTP. |
| `WHATSAPP_AUTH_DIR` | Non | Dossier de stockage de l'historique du tableau de bord (def. `./auth_info`). A monter sur un volume persistant en production — ne contient plus de cles de session WhatsApp (API officielle, sans session). |
| `WHATSAPP_MIN_DELAY_MS` | Non (def. 1500) | Delai minimum entre deux envois, pour lisser les pics. |
| `WHATSAPP_SEND_TIMEOUT_MS` | Non (def. 20000) | Delai max d'attente pour un envoi avant de considerer l'appel en echec. |

## Tableau de bord web

Une interface web simple, accessible depuis n'importe quel navigateur (pas besoin de retourner dans EasyPanel/VPS/Lovable au quotidien), sur `https://notify.delivrou.com/dashboard` :

- **Conversations** : liste des discussions WhatsApp (clients/livreurs) avec historique des messages.
- **Envoi manuel** : repondre a un client, ou envoyer un message libre a un numero, directement depuis la page.
- **Prospection** : recherche automatique d'etablissements reels (pharmacies, epiceries, restaurants...) via Google Places, ajoutes comme prospects, avec envoi WhatsApp en lot (garde-fous anti-blocage toujours actifs). Voir la section dediee ci-dessous.
- **Journal** : historique des 500 derniers envois (automatiques et manuels), avec statut (envoye/echec/bloque par un garde-fou) et raison en cas de probleme.

Protege par un mot de passe unique (`DASHBOARD_PASSWORD` dans `.env` — voir `.env.example`). Laissez cette variable vide pour desactiver completement le tableau de bord.

L'historique (conversations + journal) est sauvegarde dans `auth_info/dashboard_data.json`, donc persiste via le meme volume que la session WhatsApp — pas de base de donnees supplementaire a gerer.

> Note : seuls les messages recus ou envoyes **depuis que le service tourne** apparaissent (WhatsApp Web ne transmet pas tout l'historique d'un compte a un client tiers comme Baileys).

## API

Toutes les routes (sauf `/health`) demandent l'en-tete `x-notify-key: <NOTIFY_SECRET>`.

### `GET /health`
Pas d'authentification. Retourne `{ "ok": true }` si le process tourne (utile pour un check d'uptime).

### `GET /status`
```json
{
  "ok": true,
  "connected": true,
  "queueLength": 0,
  "safety": {
    "sentLastMinute": 2,
    "maxPerMinute": 20,
    "sentToday": 37,
    "maxPerDay": 500,
    "consecutiveFailures": 0,
    "circuitOpen": false,
    "circuitOpenUntil": null
  }
}
```

## Garde-fous anti-blocage WhatsApp

En plus du delai minimum entre deux envois, le service applique automatiquement :

- **Cooldown par destinataire** (`WHATSAPP_PER_RECIPIENT_COOLDOWN_MS`, defaut 10s) : pas deux messages au meme numero trop rapproches.
- **Limite par minute** (`WHATSAPP_MAX_PER_MINUTE`, defaut 20) et **par jour** (`WHATSAPP_MAX_PER_DAY`, defaut 500), toutes destinations confondues — protege contre un bug cote app qui enverrait en masse par erreur.
- **Coupe-circuit automatique** (`WHATSAPP_CIRCUIT_FAILURE_THRESHOLD`, defaut 5 echecs consecutifs) : si WhatsApp se met a refuser les envois (signe possible de restriction en cours), le service **suspend automatiquement** les envois pendant `WHATSAPP_CIRCUIT_COOLDOWN_MS` (defaut 5 min) au lieu d'insister.

Un appel a `POST /send` refuse par ces garde-fous renvoie `HTTP 429` avec un message explicatif dans `error`, et `retryAfterMs` quand c'est pertinent. Ajustez les valeurs dans `.env` selon votre volume reel (voir `.env.example`).

Avec l'API officielle, ces garde-fous servent surtout a lisser le volume et a reagir vite en cas de probleme — le risque de bannissement du numero qui existait avec Baileys n'existe plus de la meme maniere (c'est Meta qui applique ses propres regles de qualite, visibles dans le Gestionnaire WhatsApp).

## Prospection automatique (Google Places)

Permet de chercher de vrais etablissements (pharmacies, epiceries, restaurants...) a Conakry, avec leur numero de telephone, directement depuis `/dashboard/prospection`.

### Creer la cle API

1. Allez sur [console.cloud.google.com](https://console.cloud.google.com) et creez un projet (ou utilisez-en un existant).
2. Menu **APIs & Services > Library**, cherchez **"Places API (New)"**, cliquez **Enable**.
3. Menu **APIs & Services > Credentials > Create credentials > API key**.
4. (Recommande) Restreignez la cle : **API restrictions > Restrict key**, cochez uniquement **Places API (New)**.
5. Activez la facturation sur le projet (obligatoire pour utiliser l'API) — Google offre un credit gratuit mensuel qui couvre largement un usage de prospection normal ; au-dela, chaque recherche est facturee quelques centimes.
6. Copiez la cle (commence par `AIza...`).

### Configurer

Ajoutez dans `.env` (ou les variables d'environnement EasyPanel) :
```
GOOGLE_PLACES_API_KEY=AIza...
```

### Usage

1. Dans l'onglet **Prospects**, tapez une recherche (ex: "pharmacies", "epiceries", "restaurants Kaloum") et validez.
2. Les etablissements trouves avec un numero de telephone sont ajoutes automatiquement a la liste (les doublons par numero sont ignores) et classes dans l'une des 4 familles : **Pharmacies**, **Épiceries**, **Restaurants**, **Boutiques**.
3. Utilisez les onglets en haut de la liste pour filtrer par famille — le message par defaut s'adapte a la famille selectionnee.
4. Cochez les prospects a contacter (ou "Tout cocher"), choisissez eventuellement un modele, ecrivez/ajustez le texte (utilisez `{nom}` pour que chaque message mentionne le nom reel du commerce) et envoyez.
5. Les envois passent par les memes garde-fous anti-blocage que le reste (delai, limites par minute/jour) — un envoi en lot reste donc etale dans le temps, pas instantane.

Les prospects contactes restent dans la liste avec un badge "Contacte", pour eviter de redemarcher la meme entreprise par erreur.

> Rappel : il s'agit de prospection a froid vers des inconnus — le risque de blocage du numero WhatsApp est plus eleve que pour les notifications transactionnelles. Dediez un numero specifique a cet usage si le volume devient important, et restez raisonnable sur la frequence.

## Assistant IA (Google Gemini, optionnel)

Avec une cle `GEMINI_API_KEY` (offre gratuite), le tableau de bord devient plus intelligent sans jamais envoyer de message tout seul — vous validez toujours manuellement :

1. **Message de prospection par famille** : dans `/dashboard/prospection`, filtrez par famille (ex: Pharmacies) puis cliquez **"✨ Générer avec l'IA"** pour obtenir un brouillon court et personnalisable (`{nom}`), adapte a ce type de commerce. Sans cle configuree, des modeles par defaut raisonnables sont deja utilises automatiquement.
2. **Suggestion de reponse** : quand un prospect ou client repond sur WhatsApp, un brouillon de reponse est genere automatiquement et affiche au-dessus de la zone de reponse dans `/dashboard/chat/...` (encadre "💡 Brouillon suggéré par l'IA"). Il pre-remplit le champ de message mais **n'envoie jamais rien automatiquement** — vous relisez, modifiez si besoin, et cliquez Envoyer vous-meme.

### Creer la cle (gratuite)

1. Allez sur [aistudio.google.com/apikey](https://aistudio.google.com/apikey), connectez-vous avec un compte Google.
2. Cliquez **Create API key**, copiez la cle (commence par `AIza...`).
3. Ajoutez dans `.env` (ou les variables d'environnement EasyPanel) :
```
GEMINI_API_KEY=AIza...
```

Laissez la variable vide pour desactiver completement l'IA : le reste du tableau de bord (envoi manuel, prospection avec modeles par defaut, journal) continue de fonctionner normalement.

## Cout de l'API officielle

Gratuit jusqu'a un certain volume/mois selon les pays (les conversations repondant a un client dans les 24h sont desormais gratuites), puis paye au message au-dela pour les conversations initiees par l'entreprise (sans marge d'intermediaire type Twilio/NimbaSMS/Wazzap). Ajoutez un moyen de paiement dans le Gestionnaire WhatsApp pour passer en production.

### `POST /webhook/whatsapp` et `GET /webhook/whatsapp`
Appelees uniquement par Meta (pas par `jamm-express-deliveries`) : handshake de verification puis reception des messages entrants des clients, pour alimenter les conversations visibles dans `/dashboard`.

### `POST /send`
```json
// Requete
{ "phone": "224612345678", "text": "Votre commande JAMM-00123 a ete livree. Merci !" }
// Reponse (succes)
{ "ok": true }
// Reponse (echec)
{ "ok": false, "error": "..." }
```

`phone` doit etre le numero complet avec indicatif pays, chiffres uniquement (pas de `+` ni d'espaces). Les envois sont mis en file et espaces de `WHATSAPP_MIN_DELAY_MS` entre eux automatiquement ; l'appel HTTP attend la confirmation d'envoi (ou l'erreur).

## Deploiement (Docker)

```bash
docker build -t delivrou-notify .
docker run -d \
  --name delivrou-notify \
  -p 3300:3300 \
  -e NOTIFY_SECRET="une-longue-cle-secrete-aleatoire" \
  -e WHATSAPP_PHONE_NUMBER_ID="..." \
  -e WHATSAPP_ACCESS_TOKEN="..." \
  -e WHATSAPP_WEBHOOK_VERIFY_TOKEN="..." \
  -v delivrou_notify_auth:/app/auth_info \
  delivrou-notify
```

Aucun QR code a scanner : des que les variables sont definies, le service est pret.

## Integration cote delivrou.com

Le backend (`jamm-express-deliveries`) appelle ce service depuis `src/lib/whatsapp.server.ts`, branche dans le point de dispatch unique des notifications (`src/routes/api/public/push/dispatch.ts`), a cote du Web Push et de OneSignal. Il suffit de configurer, cote Cloudflare Workers :

```bash
wrangler secret put WHATSAPP_NOTIFY_URL     # ex: https://notify.delivrou.com
wrangler secret put WHATSAPP_NOTIFY_SECRET  # la meme valeur que NOTIFY_SECRET ici
```

Aucune autre modification n'est necessaire : le canal WhatsApp est deja limite aux evenements transactionnels (suivi de commande, offre de course livreur).

## Limitations connues

- Texte uniquement (pas de pieces jointes/images dans cette v1).
- Un seul numero WhatsApp par instance du service. Pour plusieurs numeros (ex: un par ville), deployez plusieurs instances avec des identifiants Meta distincts.
- Hors de la fenetre de 24h apres le dernier message d'un client, seul un **modele de message approuve** par Meta peut etre envoye (voir la section dediee plus haut) — un texte libre echouera.
