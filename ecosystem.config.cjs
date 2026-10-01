// Configuration PM2 pour delivrou-notify sur un VPS classique (Hostinger, etc.)
// Usage : pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "delivrou-notify",
      script: "dist/index.js",
      cwd: __dirname,
      // Les variables d'environnement sont lues depuis .env via dotenv
      // (voir .env.example) ; pas besoin de les dupliquer ici.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      // Repart proprement si le processus consomme anormalement de la memoire.
      max_memory_restart: "300M",
    },
  ],
};
