# Automatisation des alertes TaM sur X

Le projet collecte les alertes TaM au format GTFS-RT, les enregistre dans PostgreSQL avec Prisma, puis peut les publier sur X. Le mode de publication est explicite : `disabled` par défaut, `browser` pour la session navigateur, ou `api` pour l'API officielle. Aucun passage automatique vers l'API n'est effectué.

## Configuration commune

Copier `.env.example` vers `.env` en local. Dans Coolify, renseigner les mêmes variables dans la configuration de l'application :

```dotenv
DATABASE_URL=postgresql://user:password@host:port/notiftam
CRON_SECRET=un-secret-long-et-aleatoire
X_POSTING_MODE=disabled
X_ACCOUNT_HANDLE=NomDuCompte
X_BROWSER_SESSION_PATH=.x-browser/session.json
```

La collecte fonctionne sans publication lorsque `X_POSTING_MODE=disabled`. Les anciennes variables de mot de passe et les codes de vérification ne sont pas utilisés pour une connexion automatique. `USER_HANDLE` reste accepté si `X_ACCOUNT_HANDLE` n'est pas renseigné.

## Session navigateur réutilisable

Ce mode utilise Chrome ou Chromium avec `playwright-core`, sans appel à l'API officielle facturée. Il ne garantit pas la fiabilité de la publication : l'interface et les sessions X peuvent changer. Les [règles d'automatisation de X](https://help.x.com/fr/rules-and-policies/x-automation) interdisent l'automatisation du site hors API et prévoient notamment une suspension du compte. Le code ne contourne pas les écrans de connexion ou les vérifications et s'arrête si ceux-ci apparaissent.

Pour préparer la session sur votre ordinateur :

1. Renseigner le nom exact du compte dans `X_ACCOUNT_HANDLE` et garder le mode `disabled` pendant la préparation.
2. Installer les dépendances du projet et Google Chrome localement, puis lancer `npm run x:login` dans un terminal interactif.
3. La commande ouvre Chrome normalement avec un profil réservé au bot dans `.x-browser/login-profile`. Se connecter manuellement avec le **nom d'utilisateur X** configuré (pour ce bot : `AlertsTam50044`), plutôt qu'avec l'adresse e-mail, et effectuer soi-même toute vérification demandée par X. La bibliothèque de pilotage n'intervient pas pendant cette connexion.
4. Une fois la page d'accueil X affichée, appuyer sur Entrée dans le terminal. La commande demande l'arrêt propre de cette instance dédiée, puis rouvre ce même profil avec Playwright pour vérifier le compte avant d'enregistrer la session. Si Chrome ne se ferme pas, le script s'arrête et demande de fermer ses fenêtres dédiées manuellement.

La commande ne publie aucun post et n'utilise pas votre profil Chrome personnel. Le profil de connexion reste privé et peut être réutilisé pour les renouvellements ; il doit être fermé avant l'étape de vérification. Le fichier `.x-browser/session.json`, ou celui indiqué dans `X_BROWSER_SESSION_PATH`, est enregistré avec des permissions `0600`. L'export conserve uniquement les cookies et le stockage des domaines X ; une éventuelle connexion à une messagerie dans un autre onglet n'est pas incluse dans ce fichier. Le dossier créé utilise `0700`. Le contenu de la session n'est jamais affiché. Le profil et le fichier de session donnent accès au compte : ils restent hors Git, de l'image Docker et des messages de chat.

Cette procédure n'est pas une garantie d'acceptation par X. Si « Nous avons temporairement limité votre connexion » apparaît, interrompre la commande avec Ctrl+C et ne pas multiplier les tentatives. Une connexion réussie dans votre navigateur personnel ne valide pas automatiquement le profil du bot. X peut également refuser la session lors de sa vérification ou lors de son utilisation sur le serveur ; le script doit alors s'arrêter.

Si la connexion dans le profil dédié a réussi mais que l'enregistrement a été interrompu, `npm run x:save-session` vérifie et exporte ce profil existant sans recommencer la connexion. Fermer d'abord ses fenêtres Chrome. Un verrou dont le processus a disparu sur le même ordinateur est laissé à Chrome pour nettoyage ; un profil encore ouvert reste bloquant. Le profil Chrome personnel n'est jamais utilisé.

Si la réouverture du profil affiche à nouveau la connexion, lancer `npm run x:save-session -- --interactive`. Se connecter manuellement avec le nom d'utilisateur dans **cette nouvelle fenêtre**, fermer les panneaux facultatifs, puis appuyer sur Entrée dans le terminal. Le compte est vérifié et la session exportée dans ce même contexte navigateur, sans fermeture intermédiaire. Aucun identifiant n'est saisi automatiquement et toute vérification demandée par X reste manuelle.

`CHROMIUM_EXECUTABLE_PATH` permet d'indiquer un navigateur installé. Sinon, la commande essaie l'ancien `PUPPETEER_EXECUTABLE_PATH` s'il existe, puis les emplacements usuels de Chrome sur macOS et de Chromium sur Linux. Si aucun binaire n'est trouvé, elle s'arrête avant tout lancement. Un ancien `/usr/bin/chromium-browser` absent peut ainsi être remplacé par `/usr/bin/chromium` disponible sur Debian.

Pour le serveur Coolify, transférer le fichier de session par un canal privé et le placer dans un stockage persistant monté dans le conteneur, lisible par l'utilisateur de l'application. Configurer `X_BROWSER_SESSION_PATH` avec le chemin de ce fichier **dans le conteneur**, `X_ACCOUNT_HANDLE` avec le même compte et `X_POSTING_MODE=browser`. Ne pas mettre le JSON de session dans une variable d'environnement ou dans le dépôt. Une session expirée exige une nouvelle connexion manuelle locale et un nouveau transfert. Le navigateur est réutilisé pendant un lot de publications afin de limiter les démarrages.

L'application propose un transfert authentifié : `POST /api/x-session`, avec `Content-Type: application/json` et `Authorization: Bearer <CRON_SECRET>`, reçoit le contenu du fichier local. Utiliser exclusivement l'adresse **HTTPS** de l'application. La destination est imposée par `X_BROWSER_SESSION_PATH` sur le serveur ; le fichier est écrit atomiquement dans le volume persistant avec des permissions privées. La requête est limitée à 128 Kio et refuse les données hors des domaines X ou un jeton de session expiré. La réponse ne contient aucune valeur de cookie. `GET /api/x-session`, avec la même authentification, ouvre le navigateur pour vérifier le compte attendu puis le ferme, sans publier. Un transfert réussi ne suffit pas : attendre `ready: true` avant d'activer la tâche de publication.

## API officielle facultative

Le mode `api` utilise uniquement les identifiants OAuth 1.0a suivants, créés dans le [portail développeur X](https://developer.x.com/) :

```dotenv
X_POSTING_MODE=api
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
```

L'application doit disposer du droit d'écriture ; régénérer un jeton créé avant l'activation de ce droit. Ce mode est une option distincte susceptible d'impliquer des frais X : le laisser désactivé si vous ne souhaitez aucun usage de l'API. Le mode navigateur n'utilise pas ces clés.

## Nouvelle source TaM

Le flux public commun aux réseaux urbain et suburbain est désormais :

```text
https://gtfsproxy.e-tam.fr/COMMON/Alert.pb
```

La [communication officielle de Montpellier Méditerranée Métropole](https://www.data.montpellier3m.fr/evolution-majeure-de-la-diffusion-des-donnees-de-transport-de-montpellier-mediterranee-metropole) décrit le remplacement des anciennes URL distinctes par les flux `COMMON`. La [fiche du Point d'Accès National](https://transport.data.gouv.fr/resources/84201?locale=fr) référence les alertes communes.

Les anciens chemins `/TAM_MMM_GTFSRT/Alert.pb`, `/GTFS/Urbain/Alert.pb` et `/GTFS/Suburbain/Alert.pb` ne doivent plus être configurés. Si `ALERT_URL` existe déjà dans Coolify, la supprimer pour utiliser le défaut à jour, ou la remplacer par :

```dotenv
ALERT_URL=https://gtfsproxy.e-tam.fr/COMMON/Alert.pb
```

Une liste d'URL séparées par des virgules reste acceptée. Chaque téléchargement dispose d'un délai maximal de 15 secondes et ignore le cache HTTP de Next.js. Un flux valide sans alerte est un succès. Un flux inaccessible ou invalide apparaît dans le bilan ; l'échec d'un flux n'empêche pas la collecte des autres.

Les identifiants de lignes du nouveau flux peuvent être simples, par exemple `33`, alors que les anciennes données utilisent des préfixes comme `7-33`. Les filtres de l'API et les données de référence doivent tenir compte de cette transition.

## Planification

`coolify.yaml` décrit les commandes de tâches prévues pour Coolify ; vérifier qu'elles sont bien enregistrées et actives dans le déploiement. `vercel.json` décrit les tâches de Vercel et ne suffit pas à planifier les appels d'une application hébergée ailleurs.

- `/api/get_alerts` accepte `GET` et `POST` : collecte les flux, enregistre les alertes puis peut déclencher leur publication.
- `/api/post_tweets` accepte `GET` et `POST` : traite les alertes en attente de publication.
- Les appels transmettent `Authorization: Bearer <CRON_SECRET>`.

La collecte refuse de démarrer si `CRON_SECRET` est absent (HTTP 503), ou si le secret transmis ne correspond pas (HTTP 401).

La réponse de collecte contient `status` (`success`, `partial` ou `failed`), le nombre de flux réussis et échoués, le nombre d'entités traitées et le détail par flux. Une collecte partielle ou totalement en échec renvoie HTTP 502 ; une erreur de connexion à la base renvoie HTTP 500. Consulter aussi le résultat de publication et les journaux X : un succès de collecte ne prouve pas qu'un post a été publié.

Exemple d'appel manuel **qui peut publier sur X** :

```bash
curl --fail-with-body -X POST "$BASE_URL/api/get_alerts" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Pour une vérification sans publication, choisir `X_POSTING_MODE=disabled` sur un environnement de test isolé. Ne pas lancer les tâches de collecte ou de publication contre la production pour un simple contrôle de disponibilité.

## Publication et diagnostic

Les alertes sont regroupées par en-tête, formatées avec l'heure de Paris, les lignes et la description, puis publiées avec le mode explicitement choisi. Leur état en base suit le traitement afin d'éviter de republier les alertes déjà envoyées.

Avant chaque envoi, le groupe est conservé avec `isProcessing=true`, `inProcessSince=null` pour qu'un crash ne provoque pas une nouvelle publication automatique. Après confirmation, il est marqué publié ; après refus explicite, il est libéré. Si l'envoi ou son enregistrement en base reste incertain, le résultat porte `uncertain: true` et le groupe ne passe pas par le nettoyage automatique. Un administrateur doit vérifier le profil X, puis marquer ces alertes publiées si le message est présent, ou les libérer pour un nouvel essai s'il est absent.

Pour une reprise, contrôler dans cet ordre : la tâche de collecte, le statut HTTP des sources TaM, la connexion PostgreSQL, le mode de publication choisi, puis la validité de la session navigateur ou les réponses de l'API X selon ce mode. Un bot silencieux peut provenir d'une source retirée, d'une tâche absente ou de droits API manquants. Ces erreurs ne constituent pas une preuve de restriction de visibilité du compte.

Les données proviennent de Montpellier Méditerranée Métropole et sont diffusées sous licence ODbL et conditions particulières. Consulter les conditions du producteur pour l'attribution et la redistribution ; un hashtag de localisation ne suffit pas à lui seul à établir leur respect.
