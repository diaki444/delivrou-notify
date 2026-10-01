# delivrou-notify

Service de notification WhatsApp pour **delivrou.com**, sans Twilio, NimbaSMS ni Wazzap AI.

Il expose une API HTTP toute simple (`POST /send`) appelee par le backend de Delivrou a chaque evenement important (commande confirmee, livreur assigne, livraison terminee, nouvelle course pour un livreur...), et envoie le message via **votre propre numero WhatsApp**, connecte en local via [Baileys](https://github.com/WhiskeySockets/Baileys) (protocole WhatsApp Web multi-device, QR code).

Le code reutilise le meme principe que [`whatsapp-mcp`](../whatsapp-mcp) (le connecteur WhatsApp pour Claude Desktop), mais expose ici une API HTTP generique au lieu d'outils MCP, pour etre appele automatiquement par une application plutot que par Claude.

## ⚠️ Important — ou heberger ce service

**Ce service ne peut pas tourner sur Cloudflare Workers** (la ou `jamm-express-deliveries` est deploye). Il a besoin :

1. d'une connexion WebSocket **persistante et longue duree** vers les serveurs WhatsApp (incompatible avec le modele "requete courte" des Workers/Functions serverless) ;
2. d'un systeme de fichiers persistant pour `auth_info/` (les cles de session WhatsApp).

Il faut donc le deployer sur un **hote classique toujours allume** : un petit VPS (2 Go RAM suffisent largement), [Fly.io](https://fly.io), [Railway](https://railway.app), un Raspberry Pi, ou meme votre PC si vous le laissez allume (comme dans la video d'origine). Le backend Delivrou (Cloudflare Workers) lui fait simplement des appels HTTP sortants — ca, les Workers savent parfaitement le faire.

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

## API

Toutes les routes (sauf `/health`) demandent l'en-tete `x-notify-key: <NOTIFY_SECRET>`.

### `GET /health`
Pas d'authentification. Retourne `{ "ok": true }` si le process tourne (utile pour un check d'uptime).

### `GET /status`
```json
{ "ok": true, "connected": true, "queueLength": 0 }
```

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
