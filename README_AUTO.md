# Documentation du système d'automatisation Twitter

Ce document décrit le fonctionnement du système automatisé de publication des alertes de transport sur Twitter/X.

## Architecture

Le système d'automatisation Twitter utilise Puppeteer pour interagir avec l'interface web de Twitter et publier automatiquement les alertes de transport. Ce processus est déclenché par des cron jobs Vercel à intervalles réguliers.

```
┌───────────────┐    ┌──────────────────┐    ┌────────────────┐
│               │    │                  │    │                │
│  Base de      │───▶│  Script          │───▶│  Twitter/X     │
│  données      │    │  Puppeteer       │    │                │
│               │    │                  │    │                │
└───────────────┘    └──────────────────┘    └────────────────┘
```

## Fonctionnalités principales

1. **Récupération des alertes** : Le système interroge la base de données pour obtenir toutes les alertes non publiées
2. **Regroupement intelligent** : Les alertes similaires sont regroupées pour éviter la duplication d'informations
3. **Formatage des tweets** : Les alertes sont converties en messages Twitter structurés avec emojis et mise en forme
4. **Authentification Twitter** : Le système gère les sessions Twitter avec stockage de cookies
5. **Publication automatique** : Les tweets sont publiés en respectant les limites de caractères et les contraintes de l'API
6. **Suivi de publication** : Les alertes publiées sont marquées pour éviter la duplication

## Technologies utilisées

- **Puppeteer** : Automatisation du navigateur pour interagir avec Twitter
- **Chromium** : Navigateur headless utilisé par Puppeteer
- **Vercel Cron Jobs** : Planification des tâches de publication
- **Prisma ORM** : Interaction avec la base de données PostgreSQL

## Configuration

### Variables d'environnement requises

```
# Identifiants Twitter
USER_EMAIL=votre-email-twitter@exemple.com
USER_PASSWORD=votre-mot-de-passe-twitter
USER_HANDLE=votre-identifiant-twitter

# Configuration Puppeteer
NODE_ENV=production
```

### Format des tweets

Les tweets sont formatés selon les règles suivantes :

- **En-tête** : Heure de début et lignes concernées
- **Émojis** : Adaptés en fonction du type d'incident (travaux, accident, etc.)
- **Corps** : Description de l'incident
- **Hashtag** : #Montpellier pour améliorer la visibilité

Exemple de tweet :
```
🚧 🚊 08:30
Ligne: 1
Travaux sur Avenue de la Liberté. Arrêt "Centre" non desservi jusqu'à 17:00.

#Montpellier
```

## Fonctionnement technique

### Processus de publication

1. **Récupération des alertes** : Le système récupère les alertes non publiées de la journée
2. **Regroupement par en-tête** : Les alertes similaires sont regroupées
3. **Connexion à Twitter** : Le système se connecte à Twitter avec les identifiants fournis
4. **Publication des tweets** : Chaque groupe d'alertes est publié sous forme de tweet
5. **Mise à jour des statuts** : Les alertes publiées sont marquées comme telles

### Gestion des sessions Twitter

Le système utilise une approche avancée pour la gestion des sessions :

1. **Stockage des cookies** : Les cookies de session sont stockés en base de données
2. **Réutilisation des sessions** : Les sessions valides sont réutilisées pour éviter des connexions répétées
3. **Expiration** : Les sessions expirent après 24 heures pour respecter les contraintes de sécurité

### Limitations et considérations

- Le système est soumis aux limitations des environnements serverless (timeout de 300s max)
- L'automatisation est sensible aux changements d'interface de Twitter
- La fréquence de publication est limitée pour éviter tout bannissement du compte

## Exécution manuelle

Pour déclencher manuellement la publication des alertes :

```bash
# Environnement de développement
curl http://localhost:3000/api/post_tweets/

```

## Source des données et licence

Les données publiées proviennent de [Montpellier Méditerranée Métropole](https://data.montpellier3m.fr/dataset/offre-de-transport-tam-en-temps-reel) via le jeu de données "Offre de transport TAM en temps réel", distribuées sous licence ODbL.

Conformément à la licence ODbL, tous les tweets incluent une attribution claire de la source des données par la mention "#Montpellier" et le système respecte les conditions de partage à l'identique en rendant disponibles les alertes sous le même format via l'API.