# Système d'alertes de transport en commun

Ce projet est un système complet de gestion et de diffusion d'alertes de transport en commun, comprenant une API pour accéder aux alertes et un système automatisé de publication sur Twitter/X. Il est conçu pour informer les usagers des transports publics des perturbations, travaux, et autres événements affectant le réseau.

## Documentation

Pour plus de détails sur chaque composant du système, consultez les liens ci-dessous :

- [API d'alertes](README_API.md) - Documentation complète de l'API REST
- [Automatisation Twitter](README_AUTO.md) - Documentation du système de publication automatique

## Architecture du projet

Le système se compose de deux parties principales :

1. **API d'alertes** - Une API REST pour accéder aux informations d'alertes de transport
2. **Système d'automatisation Twitter** - Un service qui publie automatiquement les alertes sur Twitter/X

### Technologie utilisée

- **Backend**: Next.js (API Routes)
- **Base de données**: PostgreSQL avec Prisma ORM
- **Automatisation web**: Puppeteer pour interagir avec Twitter
- **Planification**: Vercel Cron Jobs
- **Déploiement**: Vercel


## Schéma de fonctionnement

```
┌───────────────┐    ┌──────────────────┐    ┌────────────────┐
│               │    │                  │    │                │
│  Base de      │───▶│  API REST        │◀───│  Applications  │
│  données      │    │  d'alertes       │    │  clientes      │
│               │    │                  │    │                │
└───────┬───────┘    └──────────────────┘    └────────────────┘
        │
        │
        ▼
┌───────────────┐    ┌──────────────────┐    ┌────────────────┐
│               │    │                  │    │                │
│  Cron Job     │───▶│  Système de      │───▶│  Twitter/X     │
│  Vercel       │    │  publication     │    │                │
│               │    │                  │    │                │
└───────────────┘    └──────────────────┘    └────────────────┘
```

## Mise en place

### Prérequis

- Node.js 18+
- PostgreSQL
- Compte Twitter/X pour l'API
- Compte Vercel pour le déploiement et les cron jobs

### Variables d'environnement

```
# Base de données
DATABASE_URL=postgresql://user:password@host:port/database

# Twitter/X
USER_EMAIL=votre-email-twitter@exemple.com
USER_PASSWORD=votre-mot-de-passe-twitter
USER_HANDLE=votre-identifiant-twitter

# Configuration
NODE_ENV=production
```

### Installation

```bash
# Cloner le dépôt
git clone https://github.com/votre-utilisateur/projet-alertes-transport.git

# Installer les dépendances
cd projet-alertes-transport
npm install

# Configurer la base de données
npx prisma migrate deploy

# Démarrer en développement
npm run dev
```

## Déploiement

Le projet est configuré pour être déployé sur Vercel. Les cron jobs sont configurés dans le fichier `vercel.json` :

```json
{
  "crons": [
    {
      "path": "/api/test/tweet",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

## Licence

Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.