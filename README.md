# TaM en direct — carte des transports de Montpellier

L'accueil de [x-notif-tam.clairdev.com](https://x-notif-tam.clairdev.com/) affiche les lignes, arrêts, véhicules et perturbations du réseau TaM sur une carte MapLibre. La documentation publique est accessible à [/doc/api](https://x-notif-tam.clairdev.com/doc/api), et les bilans à [/statistiques](https://x-notif-tam.clairdev.com/statistiques). Ce service indépendant utilise les données officielles avec leur provenance et signale les informations absentes ou anciennes.

## Carte et données temps réel

- Référentiel GTFS COMMON et tracés GeoJSON opérationnels : compilation hors des requêtes web, deux versions conservées, aucune insertion d'un million de `stop_times` dans PostgreSQL.
- Positions, prévisions et alertes : un collecteur partagé par processus, toutes les trente secondes, état en mémoire borné. Une date de mesure de plus de 90 secondes est périmée ; une position disparaît du direct après 180 secondes.
- Couleur officielle des lignes conservée ; hachures jaunes seulement sur une portion concernée suffisamment localisée, coupure rouge pour une interruption officielle, halo lavande pour un arrêt prolongé estimé. L'itinéraire réel d'une déviation n'est pas inventé.
- Le signal lavande utilise des mesures fraîches, un arrêt et une course connus, les horaires et plusieurs observations ; terminus, pauses prévues et pertes GPS ne sont pas qualifiés d'anormaux. La cause reste inconnue.
- Fond clair OpenFreeMap configurable, crédits repliés accessibles par le bouton (i), liste équivalente lorsque WebGL est indisponible, favoris locaux et géolocalisation volontaire.

## Fréquences de passage et affichage voyageurs

La page `/statistiques` distingue les horaires **prévus** GTFS et les passages **observés** par GPS. Moyenne et médiane se calculent entre deux passages au même point d’arrêt et dans le même sens. Les bilans tram et bus regroupent ces intervalles ; une longue ligne et des arrêts très desservis contribuent davantage. La fenêtre prévue est 7 h – 21 h, heure de Paris ; les observations s’arrêtent à l’heure courante. Ces distributions ne sont pas un taux de ponctualité.

Les cartes Lun–Dim sélectionnent les jours à comparer. Les raccourcis proposent tous les jours, les jours ouvrés (lundi–vendredi hors jours fériés), le week-end et le lundi. La modale « Période & options » règle les dates et inclut, exclut ou isole les jours fériés métropolitains et les vacances scolaires de Montpellier, zone C. Par défaut, les horaires prévus portent sur les sept prochains jours et les observations sur les 28 derniers ; chaque source conserve sa période. Les jours sans données sont signalés, jamais assimilés à une absence de service. La couverture GTFS est vérifiée séparément pour chaque ligne et mode ; les calendriers publics non connus restent explicitement inconnus.

Les observations sont partielles, fondées sur des positions fraîches, des courses reconnues et une présence proche de l’arrêt. Aucun horaire prédit n’est compté comme passage réel. Les coupures de collecte sont exclues. Les faits compacts de passage (sans coordonnées) et la couverture minute restent sept jours, avec un plafond de 100 000 passages ; `TRANSIT_HEADWAYS_ENABLED=false` désactive cette collecte. Avant toute purge, des histogrammes quotidiens compacts et leur couverture sont conservés pendant 364 jours. Les moyennes et médianes filtrées regroupent ces distributions, sans moyenner des moyennes ni relier deux journées. Une journée tronquée reste marquée partielle. Les tables sont créées par la même migration additive au démarrage.

`GET /api/stats/headways` accepte `from`, `to` (dates ISO inclusives, plage de 366 jours maximum), `weekdays` (1=lundi à 7=dimanche), `holidays` et `schoolHolidays` (`include`, `exclude`, `only`), ainsi que `target=planned|observed|both`. Une source non demandée porte le statut `skipped` ; les dates à venir ne comptent pas comme des observations manquantes.

Une [carte illustrée continue](/lab/illustration), hors navigation et non indexée, assemble 30 illustrations : une vue générale de Montpellier, 24 secteurs et cinq vues rapprochées (Comédie, Saint-Roch, Peyrou, Corum et Joffre). On glisse et zoome directement, sans sélection de quartier. Les six niveaux de tuiles partagent le même cadrage, orienté au nord ; seules les tuiles proches de l’écran sont chargées. Les images et leurs métadonnées restent des fichiers statiques, sans stockage en base ni génération IA à chaque visite.

Le centre dispose de niveaux plus détaillés ; ailleurs, la carte conserve le niveau disponible. La netteté et les raccords varient selon les sources, sans calage GPS certifié. Le [journal de production, les sources et la validation](docs/realistic-illustration-atlas.md) décrit l’assemblage. Les références Google Maps restent créditées et les [prompts exacts](output/imagegen/atlas) sont conservés. `/lab/3d` redirige toujours vers cette carte ; le mode de caméra libre reste retiré.

La carte donne la priorité visuelle aux trams à faible zoom. Les lignes sélectionnées, favorites ou perturbées, ainsi que les véhicules présentant un état d’attention, restent visibles. Les autres bus apparaissent en zoomant. Le panneau mobile s’ouvre par pression ou glissement de sa poignée ; les commandes Carte/Liste et Trafic sont dans l’en-tête. Une ligne s’explore sur un schéma des arrêts GTFS, dont les positions de véhicules restent indicatives. Les états « position ancienne », « arrêt prolongé » et « retard annoncé » gardent leur provenance ; aucune présence de contrôleurs n’est déduite.

Les alertes utilisent l’identifiant commercial lorsque le texte officiel et le référentiel permettent de résoudre un selector interne inconnu (par exemple 61 → A). Le selector brut est conservé. Les marqueurs distinguent un arrêt concerné d’un simple repère de ligne, qui ne localise pas l’incident.

Une tentative X dont l’envoi n’a pas été confirmé reste en quarantaine. L’API protégée `/api/post_tweets?dryRun=true` expose les alertes en attente et leur état, sans les republier ; les alertes déjà en quarantaine ne sont jamais libérées par une mise à jour du code ou un changement de libellé.

## Arrêts, perturbations et aéronefs

Un clic sur un arrêt présente les trois prochains départs, les suivants au dépliage, puis le parcours centré sur ce quai. Les pastilles de ligne filtrent les départs sans quitter l’arrêt. Carte et schéma partagent les petits marqueurs de véhicule et leur flèche ; une direction absente ne devient pas artificiellement un cap nord. Le panneau Trafic distingue les alertes officielles des observations « Arrêts prolongés » en lavande.

Quand le flux véhicule ne fournit pas d’arrêt, le serveur cherche une occurrence unique parmi les arrêts de sa course GTFS connue : distance maximale de 60 m et avance d’au moins 20 m sur le deuxième candidat. Les boucles ambiguës et les identifiants fournis mais contradictoires restent exclus. L’association estimée est publiée dans `stopMatch`, séparément des identifiants du producteur ; les positions anciennes ne la conservent pas. Les cartes d’arrêt prolongé indiquent « Arrêt estimé par GPS » lorsque nécessaire.

Un arrêt prolongé exige toujours une première position à moins de 30 m, au moins quatre mesures distinctes sur deux minutes pour un tramway (type GTFS 0), ou trois minutes pour un bus ou un type de ligne inconnu, sans coupure de plus de 90 s, après le départ prévu augmenté d’une minute. Les terminus, attentes prévues, courses annulées et mouvements mesurés sont exclus. Ce suivi reste en mémoire et recommence après un redémarrage. Le même rattachement peut alimenter les passages observés, mais seulement avec une approche GPS prouvée (au moins 80 m puis moins de 40 m en 90 s maximum), une date de service valide et une déduplication par course/date/occurrence. Aucun ancien passage n’est reconstruit et aucune nouvelle table n’est ajoutée.

Les non-dessertes sont issues des sélecteurs officiels ou d’une phrase explicite identifiant des arrêts. Une plage entre deux noms n’est étendue que si un seul parcours GTFS la rend non ambiguë. Les arrêts de report et les quais opposés ne sont pas inclus ; la restriction conserve sa ligne et son sens. La carte montre uniquement les restrictions en cours par défaut. Une alerte future se consulte depuis « À venir », puis en ouvrant son aperçu sur la carte : un bandeau daté et « Revenir au direct » distinguent ce mode. Les périodes officielles déterminent le contour rouge « prévu » puis le rouge plein « en cours », avec expiration automatique côté client ; le bandeau daté distingue l’aperçu futur. Un retard, une annulation de course ou une simple déviation ne ferme jamais tous les arrêts. Aucune géométrie de déviation n’est inventée.

Le moteur d’interruption lit les affirmations explicites du texte TaM : « ligne interrompue entre X et Y » et « interruption sur l’ensemble de la ligne ». Il rapproche les noms du GTFS de la seule ligne concernée, conserve les restrictions de sens et les variantes, puis découpe les tracés officiels existants après vérification des arrêts intermédiaires. Les deux bornes restent à moins de 60 m du tracé. Sur une portion d’au moins cinq arrêts, un seul quai intermédiaire décalé de 60 à 100 m peut être accepté si ses deux voisins sont à moins de 30 m du tracé ; ce décalage ne déforme jamais la géométrie officielle. Les hypothèses, négations, reprises, boucles ambiguës et tracés divergents restent exclus. `interruption` conserve la preuve textuelle et les portions reconnues ; une géométrie absente n’est jamais remplacée par une ligne droite ou par la ligne entière. Les abréviations St/Ste et Dr sont reconnues, mais un qualificatif distinctif comme République est conservé. Carte et thermomètre indiquent la portion interrompue en rouge/noir pendant les seules périodes actives ; les fiches arrêt préviennent des passages à confirmer sur cette portion. Les limites d’interruption ne deviennent pas des quais fermés sans déclaration distincte de non-desserte. Aucun appel IA, nouvelle table ou trajectoire GPS supplémentaire n’est nécessaire.

La couche hélicoptères utilise `GET /api/live/aircraft`, alimenté par [adsb.lol](https://www.adsb.lol/docs/open-data/api), sous [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Zone fixe de 20 km autour de Montpellier ; seules les catégories ADS-B A7 explicitement reçues en vol, avec altitude barométrique positive et position récente, sont affichées. L’altitude n’est pas une hauteur au-dessus du terrain. Le cache partagé limite les requêtes à une par minute et par processus, à la demande ; délai de 8 s, repli et temporisation en cas d’échec. La carte masque les positions de plus de 60 s, sans stockage de vols en base. La couverture est partielle : aucun signal reçu ne prouve pas l’absence d’hélicoptères. Le fournisseur est gratuit au mieux de ses capacités et peut faire évoluer ses limites ; pour une audience soutenue, prendre contact selon sa documentation.

## Conservation et bilans

Les échantillons GPS utiles au diagnostic sont enregistrés au maximum une fois par minute, conservés **24 heures au maximum** avec un plafond de **200 000 lignes**, et désactivables. Ces limites sont configurables et bornées ; aucune trajectoire exhaustive n'est conservée indéfiniment.

Les détails d'incidents clos sont conservés sept jours puis nettoyés après validation des agrégats. Les incidents actifs et publications incertaines restent protégés. Les faits compacts et bilans hebdomadaires couvrent 52 semaines, selon les semaines locales Europe/Paris, y compris les changements d'heure. Les bilans décrivent des alertes et des durées annoncées, avec couverture des observations ; ils ne sont pas une mesure de l'interruption réelle du réseau.

Un registre indépendant conserve les empreintes des publications X confirmées ou incertaines. La migration et le nettoyage reprennent les anciens états avant toute suppression. Une alerte recréée après purge ne peut donc pas déclencher un nouvel envoi déjà enregistré.

```dotenv
TRANSIT_LIVE_ENABLED=true
TRANSIT_STORAGE_ENABLED=true
TRANSIT_PURGE_ENABLED=false
TRANSIT_GPS_ENABLED=true
TRANSIT_GPS_RETENTION_HOURS=24
TRANSIT_GPS_MAX_ROWS=200000
TRANSIT_GPS_SAMPLE_SECONDS=60
TRANSIT_STATS_WEEKS=52
TRANSIT_DATA_DIR=/app/.transit-data
```

Le Dockerfile exécute une migration SQL **additive** avant de démarrer Next.js, sans `db push`, suppression de table ou réinitialisation du schéma existant. En local, exécuter `npm run transit:migrate` avec une base de développement explicite. Pour prévisualiser la carte sans enregistrer de données, utiliser `TRANSIT_STORAGE_ENABLED=false X_POSTING_MODE=disabled npm run dev`.

Dans Coolify, les flags du collecteur et du stockage sont disponibles au runtime uniquement, afin d'éviter toute collecte pendant la construction. Monter un volume persistant à `/app/.transit-data` et conserver séparément le volume privé de session X. Le référentiel embarqué sert de repli si le volume est vide ou si une actualisation échoue.

Commandes et routes de maintenance :

- `npm run transit:sync` : télécharge les sources publiques, compile et valide le nouveau référentiel, puis active son manifeste atomiquement. À planifier chaque nuit dans le conteneur.
- `POST /api/transit/maintenance?dryRun=true` : compte les anciens contenus éligibles sans les modifier.
- `POST /api/transit/maintenance?purge=true` : reprend le registre de publication, valide les bilans, puis nettoie les lots éligibles. Authentification `Authorization: Bearer <CRON_SECRET>` obligatoire.
- `TRANSIT_PURGE_ENABLED=true` autorise aussi le nettoyage périodique depuis le collecteur ; un échec d'agrégation conserve les données. Les GPS sont toujours soumis à leurs propres plafonds.

Surveiller taille des tables/index, autovacuum, WAL et sauvegardes : `DELETE` permet la réutilisation de l'espace sans réduire immédiatement les fichiers. Aucune tâche `VACUUM FULL` automatique n'est installée.

## Documentation

Pour plus de détails sur chaque composant du système, consultez les liens ci-dessous :

- [API d'alertes](README_API.md) - Documentation complète de l'API REST
- [Automatisation Twitter](README_AUTO.md) - Documentation du système de publication automatique

## Architecture du projet

Le système se compose de trois parties principales :

1. **API d'alertes** - Une API REST pour accéder aux informations d'alertes de transport
2. **Système d'automatisation Twitter** - Un service qui publie automatiquement les alertes sur Twitter/X
3. **Carte voyageurs** - Un référentiel statique compilé, un cache temps réel partagé et des bilans compacts

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

- Node.js 22 recommandé ; image Docker Node.js 22 avec Chromium
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
