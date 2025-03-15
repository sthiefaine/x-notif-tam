# API d'alertes de transport

Cette API permet de récupérer les alertes de transport en fonction de différents critères, avec des informations détaillées sur les lignes concernées.

## Limites de taux (Rate Limiting)

L'API est soumise à une limite de **6 requêtes par minute** par adresse IP. Si cette limite est dépassée, un code d'état HTTP 429 (Too Many Requests) sera renvoyé.

Les en-têtes de réponse incluent les informations suivantes concernant les limites de taux :
- `X-RateLimit-Limit` : Nombre maximum de requêtes autorisées (6)
- `X-RateLimit-Remaining` : Nombre de requêtes restantes dans la fenêtre actuelle
- `X-RateLimit-Reset` : Timestamp Unix indiquant quand la limite sera réinitialisée
- `Retry-After` : Nombre de secondes à attendre avant de réessayer (en cas de dépassement)

## Types d'énumérations

### Causes d'alertes

```typescript
export enum AlertCause {
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
  TRAFFIC_JAM = "TRAFFIC_JAM",
}
```

### Effets d'alertes

```typescript
export enum AlertEffect {
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
  ACCESSIBILITY_ISSUE = "ACCESSIBILITY_ISSUE",
}
```

## Endpoint

### GET /api/alerts

Récupère une liste d'alertes avec pagination, filtrage et informations détaillées sur les routes.

#### Paramètres de requête

| Paramètre   | Type    | Description                                                  |
|-------------|---------|--------------------------------------------------------------|
| active      | boolean | Si `true`, retourne les alertes actuellement actives         |
| completed   | boolean | Si `true`, retourne les alertes terminées                    |
| upcoming    | boolean | Si `true`, retourne les alertes à venir                      |
| route       | string  | Filtre par identifiant de ligne                              |
| stop        | string  | Filtre par identifiant d'arrêt                               |
| timeFrame   | string  | Période: 'today', 'week', 'month'                            |
| page        | number  | Numéro de page (défaut: 1)                                   |
| pageSize    | number  | Nombre d'éléments par page (défaut: 20)                      |
| sortBy      | string  | Champ de tri (défaut: 'timeStart')                           |
| sortOrder   | string  | Ordre de tri: 'asc' ou 'desc' (défaut: 'desc')               |

#### Réponse

```json
{
  "data": [
    {
      "id": "1234",
      "timeStart": "2025-03-15T08:00:00Z",
      "timeEnd": "2025-03-15T17:00:00Z",
      "cause": "MAINTENANCE",
      "effect": "DETOUR",
      "headerText": "Travaux sur la ligne T1",
      "descriptionText": "En raison de travaux de maintenance, la ligne T1 est déviée...",
      "url": "https://example.com/alerts/1234",
      "routeIds": "T1,T2",
      "stopIds": "1234,5678",
      "isComplement": false,
      "parentAlertId": null,
      "routeDetails": [
        {
          "routeId": "T-1",
          "routeNumber": "1",
          "lineType": "main",
          "shortName": "1",
          "longName": "Tram Line 1",
          "type": 0,
          "color": "#FF0000",
          "textColor": "#FFFFFF"
        },
        {
          "routeId": "T-2",
          "routeNumber": "2",
          "lineType": "main",
          "shortName": "2",
          "longName": "Tram Line 2",
          "type": 0,
          "color": "#00FF00",
          "textColor": "#000000"
        }
      ],
      "complements": [
        {
          "id": "5678",
          "headerText": "Information complémentaire",
          "descriptionText": "Service de bus de remplacement",
          "timeStart": "2025-03-15T08:00:00Z",
          "timeEnd": "2025-03-15T17:00:00Z"
        }
      ]
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

#### routeDetails

Le champ `routeDetails` contient des informations détaillées sur chaque ligne mentionnée dans l'alerte :

| Champ       | Description                                           |
|-------------|-------------------------------------------------------|
| routeId     | Identifiant complet de la ligne                       |
| routeNumber | Numéro de la ligne (extrait de l'ID)                  |
| lineType    | Type de ligne (main, diversion, etc.)                 |
| shortName   | Nom court de la ligne                                 |
| longName    | Nom complet de la ligne                               |
| type        | Type de transport (0=tram, 3=bus, etc.)               |
| color       | Couleur associée à la ligne (format hexadécimal)      |
| textColor   | Couleur du texte pour affichage (format hexadécimal)  |

#### Codes de statut

- 200: Succès
- 429: Limite de taux dépassée
- 500: Erreur serveur

## Exemples d'utilisation

### Récupérer les alertes actives

```
GET /api/alerts?active=true
```

### Récupérer les alertes à venir pour une ligne spécifique

```
GET /api/alerts?upcoming=true&route=T1
```

### Récupérer les alertes d'aujourd'hui

```
GET /api/alerts?timeFrame=today
```

### Paginer les résultats

```
GET /api/alerts?page=2&pageSize=10
```

### Récupérer les alertes par ordre chronologique (plus anciennes d'abord)

```
GET /api/alerts?sortBy=timeStart&sortOrder=asc
```

## Gestion des erreurs

En cas de dépassement de la limite de taux, l'API renvoie :

```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please try again in XX seconds."
}
```

En cas d'erreur serveur :

```json
{
  "error": "Erreur lors de la récupération des alertes",
  "message": "Description détaillée de l'erreur"
}
```