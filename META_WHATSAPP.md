# Passer à l'API officielle WhatsApp (Meta)

Le service sait parler à WhatsApp de deux façons. Un interrupteur choisit :

| `WHATSAPP_PROVIDER` | Mode |
|---|---|
| (absent) ou `baileys` | QR code, comme avant (non officiel) |
| `meta` | API officielle (Cloud API) |

Tant que la variable n'est pas `meta`, **rien ne change**. Pour revenir en arrière : enlever la variable et redéployer.

## Identifiants (relevés le 29 oct. 2026 dans Gestionnaire WhatsApp)
- Numéro : **+224 628 90 12 85** (« Delivrou Group »), statut **Connecté**
- ID du numéro : `1359091917290628`
- ID du compte WhatsApp Business : `1630539038665798`
- Application Meta : **Delivrou Notify** (ID `1824842835338095`)

## Variables à mettre dans EasyPanel (service delivrou-notify, onglet Environnement)
```
WHATSAPP_PROVIDER=meta
WHATSAPP_PHONE_NUMBER_ID=1359091917290628
WHATSAPP_ACCESS_TOKEN=<le jeton permanent : SECRET, jamais dans un chat>
WHATSAPP_VERIFY_TOKEN=<un mot de passe que tu inventes, ex. une phrase longue>
WHATSAPP_APP_SECRET=<secret de l'application : SECRET (Paramètres de l'app > Général)>
```
`WHATSAPP_APP_SECRET` est facultatif mais **recommandé** : le service refuse alors tout webhook non signé par Meta.

## Étapes côté Meta
1. **Jeton permanent.** business.facebook.com > Paramètres de l'entreprise > Utilisateurs > **Utilisateurs système** > Ajouter (rôle Admin) > Attribuer les actifs : l'application *Delivrou Notify* (contrôle total) et le compte WhatsApp *Delivrou Group* (contrôle total) > **Générer un jeton**, application *Delivrou Notify*, durée « Jamais », permissions `whatsapp_business_messaging` et `whatsapp_business_management`. Copier le jeton dans EasyPanel.
2. **Webhook.** developers.facebook.com > Delivrou Notify > WhatsApp > Configuration : URL de rappel `https://notify.delivrou.com/webhook/whatsapp`, jeton de vérification = `WHATSAPP_VERIFY_TOKEN`. Puis s'abonner au champ **messages**.
3. **Moyen de paiement.** Gestionnaire WhatsApp > Paramètres de paiement.
4. **Mode de l'application.** Passer *Delivrou Notify* de « En développement » à **« En ligne »** (Meta demande une adresse de politique de confidentialité). En développement, seuls des numéros de test reçoivent des messages.
5. **Modèles.** Voir plus bas : à créer dans Gestionnaire WhatsApp > Modèles de messages.
6. Dans EasyPanel : **Enregistrer**, puis **Déployer**.

## Contrôles
- QG, onglet Messages : la pastille de connexion passe au vert. `GET /qg/api/status` indique `provider.provider = "meta"` et le numéro.
- Écrire au numéro depuis un autre téléphone : le message apparaît dans le QG et l'IA prépare un brouillon.
- Répondre depuis le QG dans les 24 h : le message part.

## Règle des 24 heures
Un client écrit : on peut lui répondre librement pendant **24 h**. Au-delà, ou pour écrire en premier (commande confirmée, livreur assigné…), Meta n'accepte qu'un **modèle approuvé**. Sans modèle, le QG affiche : « Hors de la fenêtre de 24 h… ».

Envoyer un modèle depuis le backend :
```
POST /send   (en-tête x-notify-key)
{ "phone": "224628901285", "template": "colis_livre", "params": ["Alpha"], "lang": "fr" }
```

## Modèles proposés (catégorie « Utilitaire », langue français)
Aucun prix, aucun délai, aucun paiement en espèces.

| Nom | Texte | Variables |
|---|---|---|
| `commande_confirmee` | Bonjour {{1}}, ta commande Delivrou est bien enregistrée. Nous cherchons un livreur. Tu peux la suivre dans l'application. www.delivrou.com | 1 = prénom |
| `livreur_assigne` | Bonjour {{1}}, {{2}} a pris ton colis en charge. Suis-le en direct sur la carte dans l'application Delivrou. | 1 = prénom, 2 = prénom du livreur |
| `colis_livre` | Bonjour {{1}}, ton colis a été remis. Merci d'avoir choisi Delivrou. Tu peux noter ta livraison dans l'application. | 1 = prénom |
| `nouvelle_course_livreur` | Bonjour {{1}}, une nouvelle course est disponible près de {{2}}. Ouvre l'application Delivrou pour l'accepter. | 1 = prénom du livreur, 2 = commune |

À la création, Meta demande des exemples de valeurs (ex. « Alpha », « Bah », « Kaloum »). Approbation : de quelques minutes à quelques heures.

## Limites et coûts
- Meta facture certaines conversations (surtout celles ouvertes par une entreprise). Vérifier la grille tarifaire dans Gestionnaire WhatsApp avant d'envoyer en volume.
- L'API ne permet pas de tester à l'avance si un numéro a WhatsApp : l'envoi tranche.
- Si le même numéro est aussi utilisé dans l'application WhatsApp Business (« coexistence »), vérifier dans Gestionnaire WhatsApp que les deux modes sont actifs.

## Modèle de secours (messages automatiques)
Les messages envoyés par l'application (« commande créée »…) partent en texte libre. Si Meta les refuse parce que le client n'a pas écrit depuis plus de 24 h, le serveur **renvoie automatiquement le même texte** dans un modèle approuvé. À activer avec :
```
WHATSAPP_FALLBACK_TEMPLATE=notification_commande
WHATSAPP_FALLBACK_LANG=fr        (facultatif)
```
Modèle à créer dans Gestionnaire WhatsApp (catégorie Utilitaire, français) :
> Bonjour, voici une mise à jour de ta commande Delivrou : {{1}} Merci de ta confiance.

Les retours à la ligne du message d'origine sont remplacés par « · » (Meta n'en accepte pas dans une variable). Seuls les envois automatiques (`source: auto`) utilisent ce secours : une réponse écrite à la main dans le QG affiche l'erreur claire.
