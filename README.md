# Système d'alertes de transport en commun de Montpellier

Ce projet est un système complet de gestion et de diffusion d'alertes de transport en commun, comprenant une API pour accéder aux alertes et un système automatisé de publication sur Twitter/X. Il est conçu pour informer les usagers des transports publics des perturbations, travaux, et autres événements affectant le réseau de Montpellier.

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

- Node.js 18+ > 22+
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
git clone https://github.com/sthiefaine/x-notif-tam.git

# Installer les dépendances
cd x-notif-tam
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
      "path": "/api/post_tweets",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

## Source des données

Les données utilisées dans ce projet proviennent de [Montpellier Méditerranée Métropole](https://data.montpellier3m.fr/dataset/offre-de-transport-tam-en-temps-reel) via le jeu de données "Offre de transport TAM en temps réel".

## Licence ODbL

Ce projet est distribué sous licence [ODbL (Open Database License)](https://opendatacommons.org/licenses/odbl/summary/).

**Termes clés de la licence :**

1. **Attribution** — Vous devez attribuer tout usage public des données ou de la base de données, ou des œuvres produites à partir des données, en citant la source originale.

2. **Partage à l'identique** — Si vous créez et partagez des adaptations de cette base de données, vous devez les distribuer sous la même licence ODbL.

3. **Maintien ouvert** — Si vous redistribuez la base de données ou une version adaptée, vous devez maintenir les restrictions de la licence afin que les utilisateurs en aval aient les mêmes droits et obligations.

> **Note importante :** Comme précisé par Montpellier Méditerranée Métropole, *"la clause de partage à l'identique figurant à l'article 4.4 concerne les informations de même nature, de même granularité, de même conditions temporelles et de même emprise géographique."*

### Respect de la licence

Notre API respecte intégralement la licence ODbL en :
- Mentionnant clairement que les données proviennent de Montpellier Méditerranée Métropole 
- Permettant l'accès aux données d'origine
- Distribuant les données dérivées selon les mêmes conditions que la source originale
- Incluant un lien vers la licence dans la documentation de l'API

## Contact

Pour toute question ou suggestion concernant ce projet, veuillez ouvrir une issue sur GitHub.