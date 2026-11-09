# Atlas réaliste de Montpellier

L’atelier `/lab/illustration` remplace le grand dessin pixel-art agrandi par des
illustrations semi-réalistes, créées avec l’outil de génération d’images intégré,
puis assemblées dans une carte continue à caméra fixe.
Le mode public de caméra libre reste retiré et `/lab/3d` redirige vers l’atelier.

## Livrable et consultation

- 1 vue générale de Montpellier et de ses environs.
- 24 secteurs de référence couvrant le plan de la commune.
- 5 vues rapprochées : Comédie, Saint-Roch, Peyrou, Corum, Joffre–ouest d’Antigone.
- 30 images natives de 1672 × 940 ou 941 pixels, sans upscale de l’ancien dessin.
- Couleurs pierre/tuiles naturelles, lumière douce, sans pixel-art ni contours noirs.
- Images : `public/lab/atlas/` ; manifeste : `manifest.json` ; audit : champ `audit` du manifeste.
- Prompts exacts utilisés : `output/imagegen/atlas/`, un fichier par image.

Les 30 PNG pèsent au total 126,61 Mo, stockés sur le système de fichiers,
sans ajout en base. Une visite ne télécharge pas l’atlas complet.

La galerie et le sélecteur de quartiers ont été remplacés par un seul espace
pixel de 1672 × 941. Le zoom reste ancré sous le curseur et la carte se déplace
sans changement de cadrage au chargement des détails. Certaines vues périphériques
montrent aussi les communes voisines.

Une pyramide WebP de six niveaux (échelles 1, 2, 4, 8, 16, 32) conserve la même
composition à tous les niveaux. Les quatre premiers couvrent toute la carte ;
les deux derniers sont clairsemés autour des cinq vues rapprochées. Le moteur
conserve automatiquement les parents disponibles ailleurs ou pendant le chargement.
Le niveau initial est centré sur Comédie, à l’échelle 24 ; « Tout voir » recadre
la ville entière. Les niveaux détaillés utilisent les images rapprochées réelles,
sans prétendre ajouter des détails IA lors du zoom. La netteté varie en dehors
de ces zones, et les raccords ne sont pas tous invisibles.

Les tuiles de 512 pixels sont chargées près de l’écran, avec au plus huit
requêtes et un cache borné à 64 images / 24 millions de pixels décodés.
La version produite contient 853 tuiles pour 36 879 106 octets (36,88 Mo).
Les originaux restent conservés pour la traçabilité et ne sont plus chargés par
la page. Aucun besoin de clé Google ou de base de données n’est ajouté.

L’en-tête est compact et les boutons mesurent au moins 44 pixels. Le glisser,
le pincement, les flèches et +/− fonctionnent ; « Tout voir » ajuste l’image.

## Références et production

Les 24 sources régionales ont été capturées dans Google Maps, sans compte
personnel affiché, avec une caméra orientée au nord et une inclinaison ~39°.
Les URL de caméra réellement observées et les empreintes des captures sont
conservées. Les cinq détails utilisent les vues Google rapprochées du pilote.
La vue générale est issue d’un cadrage distinct de toute la ville.

L’illustration de Comédie sert d’étalon de style. Chaque photo régionale reste
la référence de géométrie : l’IA doit conserver ses routes, échangeurs, stades,
forêts, champs et formes urbaines ; elle ne doit pas copier les immeubles de
Comédie sur les périphéries. Les images sont contrôlées visuellement face aux
photos avant de devenir disponibles. Les façades et les marges masquées par
l’interface restent interprétées.

Le crédit « Illustration IA · Référence : Google Maps. Images ©2026 Google. »
reste visible dans l’application avec un lien vers la référence. Aucun SDK,
compte facturé ou clé Google n’est intégré au site. Les captures brutes restent
hors dépôt, avec leurs journaux ; seules les illustrations et leurs métadonnées
sont publiées. Les captures CUA sont parfois des JPEG malgré leur suffixe `.png` ;
leur format réel est détecté lors du contrôle, sans modifier les octets sources.

## Plan de référence et portée de la couverture

`data/illustration-atlas-plan.json` contient les 24 cadres. Ils ont été établis
en Lambert-93 à partir de la limite communale officielle de Montpellier (INSEE
34172), surface calculée 57,119 km² : cadres 2800 × 2040,47 m, recouvrement 15 %,
hypothèse de projection oblique orthographique à 39,44°. L’union de cette grille
couvre théoriquement le polygone sans trou. La densité théorique d’une image
régionale est d’environ 1,675 m/pixel est–ouest et 2,168 m/pixel nord–sud.

Les centres des captures sont ajustés à moins de 200 m des centres demandés,
selon un modèle de pose Google approximatif. Cela contrôle le cadrage de
production, pas une empreinte au sol exacte. `boundsRole=reference-envelope` et
`registration=independent-frame` sont conservés pour chaque vue. Le manifeste
ne présente pas la couverture théorique comme une validation du géocalage des
illustrations. Aucune couture continue ni superposition de véhicules en direct
n’est certifiée dans cet atlas. La composition pixel est continue, mais ne
constitue pas un relevé géographique : la parallaxe des toits, les interprétations
IA et les différences de densité restent visibles. La carte TaM principale
conserve les véhicules et le géocalage opérationnel.

## Carte continue

`data/continuous-atlas-calibration.json` conserve les empreintes des trente
originaux et leurs transformations vers l’image générale. Le recalage source
vers illustration utilise des correspondances visuelles ; la pose des caméras
sert de modèle entre les vues, avec des ancrages centraux contrôlés. Les cadres
de planification ne sont pas traités comme des empreintes GPS exactes.

`scripts/build-continuous-atlas.py` reprojette les images et leurs masques,
adoucit les bords puis construit les niveaux parents depuis la même composition.
Les marges couvertes par l’interface des références sont exclues. Ce traitement
géométrique ne modifie pas les originaux. Il utilise Python, NumPy et OpenCV,
uniquement hors ligne :

```sh
python scripts/build-continuous-atlas.py \
  --calibration data/continuous-atlas-calibration.json --workers 4
```

Le résultat se trouve dans `public/lab/continuous/v1/` : `manifest.json` décrit
les niveaux et les tuiles présentes ; `audit.json` donne les dimensions, octets,
empreintes et contrôles de décodage. Le contrat de la page est généré dans
`data/continuous-atlas.ts`. Les captures brutes ne sont pas publiées. Le moteur
ne demande jamais une tuile absente d’un niveau clairsemé et conserve la même
caméra pendant les changements de niveau. Les tests contrôlent notamment cet
ancrage, les limites de navigation, la sélection des tuiles et le budget mémoire.

## Assemblage et validation

Le compilateur `scripts/build-illustration-atlas.cjs` lit le plan, les URL de
capture réelles et les PNG locaux. Il contrôle structure, dimensions, contenu
décodable et empreintes des images avant de les annoncer disponibles. Il vérifie
les formats réels PNG/JPEG des références, sans supposer leur format à partir
du nom de fichier. Il écrit atomiquement le manifeste avec son audit intégré. La variante TypeScript
`data/illustration-atlas.ts` conserve le contrat typé de l’ancienne galerie.

```sh
node scripts/build-illustration-atlas.cjs \
  --plan data/illustration-atlas-plan.json \
  --captures /chemin/prive/atlas-realiste-v3/captures.json \
  --out public/lab/atlas/manifest.json \
  --check-complete
```

`--check-complete` exige 30 images distinctes effectivement présentes et
vérifiées, dont 24 captures régionales distinctes au nord avec ~39° de tilt.
Un échec n’écrase pas le dernier manifeste. Les tests couvrent notamment les
assets absents, les fausses preuves de capture et les PNG indécodables. Aucun
accès à la base ni appel de génération IA n’a lieu pendant une visite du site.

## Historique

Le [pilote initial](fixed-camera-pilot.md) était une image de centre-ville de
même résolution : l’agrandir jusqu’à 409 % produisait le flou signalé par
l’utilisateur. Le présent atlas change le style et utilise de vraies vues
rapprochées, tout en bornant l’agrandissement. La voie native CityGML reste
[archivée](montpellier-city-production.md), sans moteur 3D libre public.
