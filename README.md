# delivrou-notify

Service de notification WhatsApp pour **delivrou.com**, sans Twilio, NimbaSMS ni Wazzap AI.

Il expose une API HTTP toute simple (`POST /send`) appelee par le backend de Delivrou a chaque evenement important (commande confirmee, livreur assigne, livraison terminee, nouvelle course pour un livreur...), et envoie le message via **votre propre numero WhatsApp**, connecte en local via [Baileys](https://github.com/WhiskeySockets/Baileys) (protocole WhatsApp Web multi-device, QR code).

Le code reutilise le meme principe que [`whatsapp-mcp`](../whatsapp-mcp) (le connecteur WhatsApp pour Claude Desktop), mais expose ici une API HTTP generique au lieu d'outils MCP, pour etre appele automatiquement par une application plutot que par Claude.

## ⚠️ Important — ou heberger ce service

**Ce service ne peut pas tourner sur Cloudflare Workers** (la ou `jamm-express-deliveries` est deploye). Il a besoin :

1. d'une connexion WebSocket **persistante et longue duree** vers les serveurs WhatsApp (incompatible avec le modele "requete courte" des Workers/Functions serverless) ;
2. d'un systeme de fichiers persistant pour `auth_info/` (les cles de session WhatsApp).

Il faut donc le deployer sur un **hote classique toujours allume** : un petit VPS (2 Go RAM suffisent largement), [Fly.io](https://fly.io), [Railway](https://railway.app), un Raspberry Pi, ou meme votre PC si vous le laissez allume (comme dans la video d'origine). Le backend Delivrou (Cloudflare Workers) lui fait simplement des appels HTTP sortants — ca, les Workers savent parfaitement le faire.

**Guide pas-a-pas pour un VPS Hostinger (Node + PM2 + Nginx + HTTPS) : voir [`DEPLOY_HOSTINGER.md`](./DEPLOY_HOSTINGER.md).**

## ⚠️ Usage responsable

- Utilisez ceci uniquement pour des **notifications transactionnelles** (le client ou le livreur a une relation active avec Delivrou : commande en cours, course assignee). Ce n'est pas un outil de SMS marketing de masse.
- Un volume d'envoi trop eleve ou des messages non sollicites peuvent faire bannir le numero WhatsApp connecte. Dediez un numero professionnel specifique a ce service (pas votre numero personnel).
- Respectez le RGPD / les regles locales sur les communications electroniques : vos utilisateurs doivent savoir qu'ils recevront des notifications WhatsApp (mention dans vos CGU / parametres de notification).

## Installation

```bash
npm install
npm run build
```

## Premiere connexion (scan du QR code)

```bash
npm start
```

Un QR code s'affiche dans le terminal :

1. Ouvrez **WhatsApp** sur le telephone dedie au service.
2. **Parametres > Appareils lies > Lier un appareil**.
3. Scannez le QR.

Une fois connecte, les cles de session sont sauvegardees dans `auth_info/` (ne pas committer, deja dans `.gitignore`). Laissez tourner.

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `NOTIFY_SECRET` | Oui | Cle partagee a fournir dans l'en-tete `x-notify-key` pour authentifier les appels entrants. |
| `PORT` | Non (def. 3300) | Port d'ecoute HTTP. |
| `WHATSAPP_AUTH_DIR` | Non | Dossier de stockage des cles de session (def. `./auth_info`). A monter sur un volume persistant en production. |
| `WHATSAPP_MIN_DELAY_MS` | Non (def. 1500) | Delai minimum entre deux envois, pour lisser les pics et reduire le risque de blocage. |
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

Ces limites reduisent le risque mais ne l'eliminent pas : WhatsApp Web via Baileys reste un protocole non officiel. Pour un volume important sans risque, voir la section suivante.

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

## Migrer vers l'API officielle WhatsApp Business (Meta Cloud API)

Le protocole utilise ici (WhatsApp Web via Baileys) n'est pas officiellement sanctionne par Meta pour de l'automatisation — a fort volume, le risque de blocage du numero augmente. L'alternative sans risque est l'**API officielle WhatsApp Business (Cloud API)**, hebergee directement par Meta (pas de QR code, pas de session a maintenir, pas de VPS necessaire pour la connexion elle-meme).

Migration prevue (quand vous etes pret) :
1. Creer et verifier un **compte Meta Business**.
2. Enregistrer un numero WhatsApp Business officiel.
3. Faire approuver des **modeles de message** ("templates") pour les notifications proactives.
4. Remplacer uniquement l'implementation interne de `src/whatsapp-client.ts` (appels HTTPS vers `graph.facebook.com` au lieu de Baileys) — **l'API `POST /send` exposee a `jamm-express-deliveries` reste identique**, aucun changement cote backend Delivrou.

Cout : gratuit jusqu'a un certain volume/mois selon les pays, puis paye au message au-dela (sans marge d'intermediaire type Twilio/NimbaSMS/Wazzap).

### `POST /check`
Verifie si un numero a un compte WhatsApp actif (evite d'essayer d'envoyer a un numero qui n'en a pas).
```json
// Requete
{ "phone": "224612345678" }
// Reponse
{ "ok": true, "phone": "224612345678", "exists": true }
```

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
  -v delivrou_notify_auth:/app/auth_info \
  delivrou-notify
```

Puis regardez les logs une premiere fois pour scanner le QR :

```bash
docker logs -f delivrou-notify
```

## Integration cote delivrou.com

Le backend (`jamm-express-deliveries`) appelle ce service depuis `src/lib/whatsapp.server.ts`, branche dans le point de dispatch unique des notifications (`src/routes/api/public/push/dispatch.ts`), a cote du Web Push et de OneSignal. Il suffit de configurer, cote Cloudflare Workers :

```bash
wrangler secret put WHATSAPP_NOTIFY_URL     # ex: https://notify.delivrou.com
wrangler secret put WHATSAPP_NOTIFY_SECRET  # la meme valeur que NOTIFY_SECRET ici
```

Aucune autre modification n'est necessaire : le canal WhatsApp est deja limite aux evenements transactionnels (suivi de commande, offre de course livreur).

## Limitations connues

- Texte uniquement (pas de pieces jointes/images dans cette v1).
- Un seul numero WhatsApp par instance du service. Pour plusieurs numeros (ex: un par ville), deployez plusieurs instances avec des `WHATSAPP_AUTH_DIR` distincts.
- Repose sur un protocole non officiel (Baileys) : pas de garantie contractuelle de WhatsApp/Meta, contrairement a l'API Business officielle (payante). Convient tres bien a un volume moyen de notifications transactionnelles ; au-dela de quelques milliers de messages/jour, envisagez l'API WhatsApp Business officielle.
