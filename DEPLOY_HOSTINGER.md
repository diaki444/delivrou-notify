# Deploiement sur un VPS Hostinger

Guide complet pour faire tourner `delivrou-notify` en permanence sur un VPS Hostinger (Ubuntu/Debian), avec redemarrage automatique et HTTPS.

## 0. Prerequis

- Un VPS Hostinger actif (2 Go de RAM suffisent largement).
- Les identifiants SSH (hPanel Hostinger > VPS > votre serveur > "SSH Access", ou la cle SSH que vous avez configuree a la creation).
- Un numero WhatsApp dedie (professionnel, pas forcement votre personnel) et son telephone a portee de main pour scanner un QR.
- (Recommande) Un sous-domaine pointant vers l'IP du VPS, ex: `notify.delivrou.com` — a creer dans la zone DNS de delivrou.com (enregistrement `A` vers l'IP du VPS).

## 1. Connexion et mise a jour du systeme

```bash
ssh root@VOTRE_IP_VPS
apt update && apt upgrade -y
```

## 2. Installer Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
node -v   # doit afficher v20.x
```

## 3. Creer un utilisateur dedie (recommande, evite de tourner en root)

```bash
adduser delivrou --disabled-password --gecos ""
usermod -aG sudo delivrou
su - delivrou
```

## 4. Recuperer le code

Le depot est prive. Deux options :

**Option A — cle de deploiement SSH (recommande) :**
```bash
ssh-keygen -t ed25519 -C "delivrou-notify-vps" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copiez la cle affichee, puis sur GitHub : `diaki444/delivrou-notify` > **Settings > Deploy keys > Add deploy key** (lecture seule suffit). Ensuite :
```bash
git clone git@github.com:diaki444/delivrou-notify.git
cd delivrou-notify
```

**Option B — clone HTTPS avec un token d'acces personnel (PAT) GitHub :**
```bash
git clone https://<votre_token>@github.com/diaki444/delivrou-notify.git
cd delivrou-notify
```

## 5. Installer les dependances et compiler

```bash
npm install
npm run build
```

## 6. Configurer les variables d'environnement

```bash
cp .env.example .env
nano .env
```

Renseignez au minimum `NOTIFY_SECRET` (generez-en un solide) :
```bash
openssl rand -hex 32
```
Collez le resultat dans `NOTIFY_SECRET=` du fichier `.env`, enregistrez (`Ctrl+O`, `Entree`, `Ctrl+X`).

## 7. Premier lancement (scan du QR code)

Lancez en direct, pas encore via PM2, pour voir le QR dans le terminal :

```bash
npm start
```

Sur le telephone dedie : **WhatsApp > Parametres > Appareils lies > Lier un appareil**, puis scannez le QR affiche. Vous devriez voir :
```
[delivrou-notify] Connecte a WhatsApp. Pret a envoyer des notifications.
```

Arretez avec `Ctrl+C`. Les cles de session sont maintenant dans `auth_info/` (ne les supprimez pas, sinon il faudra rescanner).

## 8. Installer PM2 et demarrer le service en permanence

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs delivrou-notify   # verifier que ca tourne, Ctrl+C pour quitter les logs (le service continue)
```

Faire demarrer PM2 automatiquement au redemarrage du VPS :
```bash
pm2 startup systemd
# PM2 affiche une commande a copier-coller (avec sudo) : executez-la telle quelle
pm2 save
```

## 9. Exposer le service en HTTPS avec Nginx + Let's Encrypt

Le service ecoute en local sur `127.0.0.1:3300` (modifiable via `PORT` dans `.env`). On le met derriere Nginx pour avoir du HTTPS propre.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Creez la configuration Nginx :
```bash
sudo nano /etc/nginx/sites-available/delivrou-notify
```
Contenu (remplacez `notify.delivrou.com` par votre sous-domaine) :
```nginx
server {
    listen 80;
    server_name notify.delivrou.com;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Activez-la :
```bash
sudo ln -s /etc/nginx/sites-available/delivrou-notify /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Verifiez d'abord que le DNS de `notify.delivrou.com` pointe bien vers l'IP du VPS (propagation DNS), puis activez le HTTPS :
```bash
sudo certbot --nginx -d notify.delivrou.com
```
Certbot configure automatiquement le certificat et le renouvellement. Votre service est maintenant joignable sur `https://notify.delivrou.com`.

## 10. Pare-feu

N'exposez que ce dont vous avez besoin :
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```
Le port interne `3300` n'a pas besoin d'etre ouvert publiquement (Nginx y acces en local uniquement) — ne pas faire `ufw allow 3300`.

## 11. Verification finale

```bash
curl https://notify.delivrou.com/health
# {"ok":true}

curl -X POST https://notify.delivrou.com/send \
  -H "Content-Type: application/json" \
  -H "x-notify-key: VOTRE_NOTIFY_SECRET" \
  -d '{"phone":"224612345678","text":"Test delivrou-notify depuis le VPS"}'
```
Vous devriez recevoir le message sur le numero teste, et `{"ok":true}` en reponse.

## 12. Cote delivrou.com (Cloudflare Workers)

Dans le repertoire `jamm-express-deliveries` :
```bash
wrangler secret put WHATSAPP_NOTIFY_URL
# valeur : https://notify.delivrou.com
wrangler secret put WHATSAPP_NOTIFY_SECRET
# valeur : la meme que NOTIFY_SECRET du .env du VPS
```

## Maintenance

- **Voir les logs** : `pm2 logs delivrou-notify`
- **Redemarrer** : `pm2 restart delivrou-notify`
- **Mettre a jour le code** :
  ```bash
  cd ~/delivrou-notify
  git pull
  npm install
  npm run build
  pm2 restart delivrou-notify
  ```
- **Deconnexion WhatsApp inattendue** (logs indiquant "Logged out") : supprimez `auth_info/`, relancez `npm start` en direct pour rescanner un QR, puis repassez sous PM2 (`pm2 restart delivrou-notify`).
- **Sauvegarde** : pensez a sauvegarder le dossier `auth_info/` (ou au moins a savoir que vous pouvez toujours rescanner un QR en cas de perte du VPS).
