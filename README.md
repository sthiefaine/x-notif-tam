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
- **Publication X** : navigateur avec session réutilisable ; API officielle v2 en option
- **Planification** : tâches Coolify ou Vercel Cron Jobs
- **Déploiement** : Docker/Coolify ; configuration Vercel également disponible

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

- Node.js 20.19+ en local ; image Docker Node.js 22 avec Chromium
- PostgreSQL
- Compte X et session navigateur ; application développeur X uniquement pour le mode API
- Hébergement Docker/Coolify ou Vercel avec des tâches planifiées

### Variables d'environnement

```
# Base de données
DATABASE_URL=postgresql://user:password@host:port/database

# Protection des tâches de collecte et de publication
CRON_SECRET=un-secret-long-et-aleatoire

# Navigateur : session créée manuellement via npm run x:login
X_POSTING_MODE=browser
X_BROWSER_SESSION_PATH=.x-browser/session.json
X_ACCOUNT_HANDLE=@votre-compte

# API officielle X facultative (uniquement avec X_POSTING_MODE=api)
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=

# Configuration
NODE_ENV=production
```

### Installation

```bash
# Cloner le dépôt
git clone https://github.com/sthiefaine/x-notif-tam.git

# Installer les dépendances
cd x-notif-tam
npm ci

# Générer le client de la base existante
npm run prisma:generate

# Démarrer en développement
npm run dev
```

Le dépôt ne contient pas d'historique de migrations. Pour une reprise, conserver la base PostgreSQL existante et vérifier sa compatibilité avec `prisma/schema.prisma` ; ne pas la réinitialiser. Le mode navigateur n'utilise aucune clé d'API payante. Sans choix de mode explicite, la publication reste désactivée. Voir [l'automatisation et la reprise](README_AUTO.md) pour la création de session et les limites de l'automatisation sur X.

## Déploiement

Le `Dockerfile` construit l'application sans connexion à PostgreSQL et inclut Chromium. Renseigner `DATABASE_URL`, `CRON_SECRET` et le mode de publication au démarrage dans Coolify. En mode navigateur, monter le fichier de session dans un stockage persistant privé accessible à l'utilisateur `node` (UID 1000). Les commandes de tâches figurent dans `coolify.yaml` ; vérifier leur enregistrement dans l'interface Coolify.

Pour Vercel, les cron jobs sont configurés dans `vercel.json`. Par exemple :

```json
{
  "crons": [
    {
      "path": "/api/post_tweets",
      "schedule": "*/2 3-18 * * *"
    }
  ]
}
```

## Source des données

Les données proviennent de Montpellier Méditerranée Métropole, via le [flux commun d'alertes TaM référencé sur transport.data.gouv.fr](https://transport.data.gouv.fr/resources/84201?locale=fr) : `https://gtfsproxy.e-tam.fr/COMMON/Alert.pb`.

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
