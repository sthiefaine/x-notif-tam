# Documentation de l'API d'alertes de transport Montpellier

Cette API REST permet d'accéder aux informations sur les perturbations, travaux et autres événements affectant le réseau de transport en commun de Montpellier. Elle est conçue pour être facilement intégrable dans vos applications.

## Endpoint principal

```
GET /api/alerts
```

L'API est accessible à l'adresse : `https://x-notif-tam.vercel.app/api/alerts`

**Limitation de débit :** L'API est limitée à **X requêtes par minute** par adresse IP.

## Paramètres de requête

| Paramètre | Type | Description |
|-----------|------|-------------|
| active | boolean | Si `true`, retourne les alertes actuellement actives |
| completed | boolean | Si `true`, retourne les alertes terminées |
| upcoming | boolean | Si `true`, retourne les alertes à venir |
| route | string | Filtre par identifiant de ligne (ex: 1, 2, 3, 4, 5, etc.) |
| stop | string | Filtre par identifiant d'arrêt |
| timeFrame | string | Période: 'today', 'week', 'month' |
| page | number | Numéro de page (défaut: 1) |
| pageSize | number | Nombre d'éléments par page (défaut: 20) |
| sortBy | string | Champ de tri (défaut: 'timeStart') |
| sortOrder | string | Ordre de tri: 'asc' ou 'desc' (défaut: 'desc') |

## Exemples d'utilisation

### Récupérer les alertes actives

```
GET /api/alerts?active=true
```

### Récupérer les alertes à venir pour une ligne spécifique

```
GET /api/alerts?upcoming=true&route=1
```

### Récupérer les alertes d'aujourd'hui

```
GET /api/alerts?timeFrame=today
```

### Paginer les résultats

```
GET /api/alerts?page=2&pageSize=10
```

## Structure de la réponse

L'API retourne les données au format JSON avec la structure suivante:

```json
{
  "data": [
    {
      "id": "1234",
      "timeStart": "2025-03-15T08:00:00Z",
      "timeEnd": "2025-03-15T17:00:00Z",
      "cause": "MAINTENANCE",
      "effect": "DETOUR",
      "headerText": "Travaux sur la ligne 1",
      "descriptionText": "En raison de travaux de maintenance...",
      "url": "https://example.com/alerts/1234",
      "routeIds": "7-1",
      "stopIds": "1234,5678",
      "isComplement": false,
      "parentAlertId": null,
      "routeDetails": [
        {
          "routeId": "7-1",
          "routeNumber": "1",
          "lineType": "main",
          "shortName": "1",
          "longName": "Tram Line 1",
          "type": 0,
          "color": "#FF0000",
          "textColor": "#FFFFFF"
        }
      ],
      "complements": [...]
    }
  ],
  "pagination": {
    "totalItems": 100,
    "totalPages": 5,
    "currentPage": 1,
    "pageSize": 20,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}
```

## Codes de statut

- **200** - Succès
- **429** - Limite de taux dépassée
- **500** - Erreur serveur

## Types énumérés

### Causes d'alertes

```
enum AlertCause {
  UNKNOWN_CAUSE = "UNKNOWN_CAUSE",
  OTHER_CAUSE = "OTHER_CAUSE",
  TECHNICAL_PROBLEM = "TECHNICAL_PROBLEM",
  STRIKE = "STRIKE",
  DEMONSTRATION = "DEMONSTRATION",
  ACCIDENT = "ACCIDENT",
  HOLIDAY = "HOLIDAY",
  WEATHER = "WEATHER",
  MAINTENANCE = "MAINTENANCE",
  CONSTRUCTION = "CONSTRUCTION",
  POLICE_ACTIVITY = "POLICE_ACTIVITY",
  MEDICAL_EMERGENCY = "MEDICAL_EMERGENCY",
  TRAFFIC_JAM = "TRAFFIC_JAM"
}
```

### Effets d'alertes

```
enum AlertEffect {
  NO_SERVICE = "NO_SERVICE",
  REDUCED_SERVICE = "REDUCED_SERVICE",
  SIGNIFICANT_DELAYS = "SIGNIFICANT_DELAYS",
  DETOUR = "DETOUR",
  ADDITIONAL_SERVICE = "ADDITIONAL_SERVICE",
  MODIFIED_SERVICE = "MODIFIED_SERVICE",
  OTHER_EFFECT = "OTHER_EFFECT",
  UNKNOWN_EFFECT = "UNKNOWN_EFFECT",
  STOP_MOVED = "STOP_MOVED",
  NO_EFFECT = "NO_EFFECT",
  ACCESSIBILITY_ISSUE = "ACCESSIBILITY_ISSUE"
}
```

## Source des données et licence

Les données fournies par cette API proviennent de [Montpellier Méditerranée Métropole](https://data.montpellier3m.fr/dataset/offre-de-transport-tam-en-temps-reel) via le jeu de données "Offre de transport TAM en temps réel".

Cette API est distribuée sous licence [ODbL (Open Database License)](https://opendatacommons.org/licenses/odbl/summary/). Conformément à cette licence, si vous utilisez ces données, vous devez :

1. Mentionner la source des données
2. Partager à l'identique toute adaptation de même nature, granularité, conditions temporelles et emprise géographique
3. Maintenir ouvert l'accès aux données

En-têtes HTTP d'attribution :
```
X-Data-Source: "Données issues de Montpellier Méditerranée Métropole - Offre de transport TAM en temps réel"
X-Data-License: "ODbL"
```

## Transformation et enrichissement des données

Cette API effectue plusieurs transformations sur les données d'origine tout en respectant la licence ODbL :

1. **Conversion de format** : Les données originales au format Protocol Buffers (.pb) sont converties en JSON pour une meilleure accessibilité et compatibilité web.

2. **Enrichissement des données** : Notre API enrichit les données brutes en ajoutant :
   - Des informations complémentaires sur les lignes (couleurs, types)
   - Des détails supplémentaires sur les arrêts concernés
   - Des regroupements intelligents d'alertes connexes
   - Des métadonnées pour faciliter le filtrage et la recherche

3. **Structuration optimisée** : La structure de l'API est conçue pour faciliter l'intégration dans des applications clientes avec :
   - Une pagination standardisée
   - Des filtres multiples
   - Un système de tri flexible

Ces transformations et enrichissements sont conformes à la licence ODbL car ils préservent :
- La nature des informations (alertes de transport)
- La granularité des données (niveau de détail des incidents)
- Les conditions temporelles (horodatages et validité des alertes)
- L'emprise géographique (réseau de transport de Montpellier)

Conformément à l'article 4.4 de la licence ODbL, ces améliorations techniques ne modifient pas l'obligation de partage à l'identique qui s'applique au contenu informationnel des données, et non à leur format ou à leur structure technique.