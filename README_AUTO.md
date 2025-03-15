# Système de publication automatique d'alertes sur Twitter/X

Ce système permet de publier automatiquement les alertes de transport sur le réseau social Twitter/X via un cron job Vercel. Les alertes sont récupérées depuis la base de données, regroupées intelligemment, et publiées avec un format optimisé pour la visibilité et la lisibilité.

## Technologies utilisées

### Puppeteer

Ce système utilise **Puppeteer**, une bibliothèque Node.js qui fournit une API de haut niveau pour contrôler Chrome/Chromium via le protocole DevTools. Puppeteer est utilisé pour :

- Automatiser la connexion à Twitter/X
- Naviguer jusqu'à la page de composition de tweet
- Remplir le contenu du tweet
- Soumettre la publication
- Gérer les sessions via les cookies

### Vercel Cron Jobs

Le système utilise **Vercel Cron Jobs** pour l'exécution planifiée des tâches. Les cron jobs sur Vercel :

- Sont configurés dans le fichier `vercel.json`
- S'exécutent directement dans l'infrastructure serverless de Vercel
- Sont hautement fiables avec des métriques et des logs
- Ne nécessitent pas d'infrastructure supplémentaire

## Fonctionnement du cron job

Le système utilise une tâche planifiée qui s'exécute à intervalles réguliers pour vérifier les nouvelles alertes non publiées et les poster sur Twitter/X.

### Configuration du cron job dans vercel.json

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

Cette configuration exécute le endpoint `/api/test/tweet` toutes les 15 minutes.

## Processus d'automatisation

1. **Récupération des alertes** - Le système récupère les alertes non publiées (où `isPosted = false`) depuis la base de données
2. **Regroupement** - Les alertes avec le même titre sont regroupées pour éviter la duplication
3. **Formatage** - Chaque groupe d'alertes est formaté en respectant la limite de 280 caractères
4. **Authentification** - Le système se connecte à Twitter via Puppeteer, en utilisant les sessions enregistrées si disponibles
5. **Publication** - Les tweets sont publiés via l'interface web de Twitter
6. **Mise à jour** - Les alertes publiées sont marquées comme telles dans la base de données

## Format des tweets

Les tweets générés suivent un format spécifique pour une meilleure lisibilité :

```
[Emoji de cause] [Emoji tramway si applicable] [Heure de début]
Ligne(s): [Liste des lignes concernées séparées par des tirets]
[Description de l'alerte]

#Montpellier
```

### Émojis contextuels

En fonction de la cause de l'alerte, différents émojis sont utilisés :

| Cause                | Emoji |
|----------------------|-------|
| TECHNICAL_PROBLEM    | 🔧    |
| STRIKE              | 🪧    |
| DEMONSTRATION       | 📢    |
| ACCIDENT            | 🚨    |
| HOLIDAY             | 🎉    |
| WEATHER             | 🌦️    |
| MAINTENANCE         | 🛠️    |
| CONSTRUCTION        | 🚧    |
| POLICE_ACTIVITY     | 👮    |
| MEDICAL_EMERGENCY   | 🚑    |
| TRAFFIC_JAM         | 🚏    |
| Autres causes       | ⚠️    |

De plus, un emoji 🚊 est ajouté si l'alerte concerne au moins une ligne de tramway (lignes 1-5).

### Exemple de tweet

```
🛠️ 🚊 09:15
Lignes: 1-2-24
En raison de travaux sur les voies, trafic perturbé jusqu'à 18h.

#Montpellier
```

## Regroupement des alertes

Le système regroupe intelligemment les alertes ayant le même titre ("headerText") pour éviter de publier des tweets redondants. Par exemple, si plusieurs lignes sont affectées par le même incident, un seul tweet sera publié mentionnant toutes les lignes concernées.

Les lignes sont toujours triées de manière logique :
1. Tramways d'abord (lignes 1-5)
2. Bus ensuite
3. Par ordre numérique au sein de chaque catégorie

## Gestion des sessions

Le système utilise une stratégie efficace de gestion des sessions Twitter :

1. Les sessions sont stockées dans la base de données (table `xSession`)
2. Les cookies d'authentification sont réutilisés pour éviter des connexions multiples
3. Les sessions expirées sont automatiquement nettoyées
4. En cas d'échec avec une session existante, une nouvelle connexion est établie

## Variables d'environnement requises

Pour que le système fonctionne correctement, les variables d'environnement suivantes doivent être configurées :

```
USER_EMAIL=votre-email-twitter@exemple.com
USER_PASSWORD=votre-mot-de-passe-twitter
USER_HANDLE=votre-identifiant-twitter
```

## Test manuel du système

Vous pouvez tester manuellement le système en utilisant les endpoints suivants :

### Créer des alertes de test et vérifier leur formatage

```
GET /api/test/tweet?createTests=true&dryRun=true
```

Cette requête va :
1. Créer trois alertes de test (deux pour les tramways avec le même titre, une pour un bus)
2. Simuler la création des tweets sans les publier
3. Retourner un aperçu des tweets qui seraient publiés

### Publier immédiatement toutes les alertes non publiées

```
GET /api/test/tweet
```

Cette requête va traiter toutes les alertes non publiées, les regrouper, et les publier sur Twitter/X.

### Options supplémentaires

| Paramètre    | Description                                                   |
|--------------|---------------------------------------------------------------|
| createTests  | Crée des alertes de test (true/false)                         |
| dryRun       | Simule la publication sans poster réellement (true/false)     |
| debug        | Affiche des informations de débogage supplémentaires (true/false) |

## Gestion des erreurs

Le système gère plusieurs scénarios d'erreur :

- Échec d'authentification Twitter
- Problèmes de connexion réseau
- Erreurs lors de la composition ou de la publication des tweets

En cas d'erreur, le système conserve l'état "non publié" des alertes pour réessayer lors de la prochaine exécution du cron job.

## Optimisations et performances

- **Réutilisation de sessions** - Minimise le nombre de connexions à Twitter
- **Regroupement d'alertes** - Réduit le nombre de tweets à publier
- **Délais entre les tweets** - Évite les limitations de l'API Twitter
- **Captures d'écran en cas d'erreur** - Facilite le débogage
- **Timeout adaptés** - Améliore la fiabilité sur les connexions lentes

## Maintenance et surveillance

Pour surveiller le bon fonctionnement du système :

1. Vérifiez les logs Vercel pour les exécutions de cron job
2. Consultez le compte Twitter pour confirmer la publication
3. Vérifiez la table `Alert` dans la base de données pour voir les statuts de publication
4. Si nécessaire, utilisez l'endpoint de test avec `debug=true` pour un diagnostic approfondi