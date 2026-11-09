# Atlas réaliste de Montpellier

L’atelier `/lab/illustration` remplace le grand dessin pixel-art agrandi par des
vues semi-réalistes distinctes, créées avec l’outil de génération d’images intégré.
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

Le menu Quartiers propose des miniatures et une recherche. Les noms des secteurs
utilisent des repères TaM proches de leur centre, pas des limites administratives
ou des emprises officielles de quartiers. Certaines vues périphériques montrent
aussi les communes voisines. Le fil de navigation donne accès à la vue générale.

Une seule image originale est active à la fois ; les petites miniatures sont
chargées à la demande dans le menu. Le zoom maximum correspond à un pixel source
par pixel CSS (convention habituelle des visionneuses photo). Un écran Retina
peut interpoler plusieurs pixels physiques ; le site ne prétend pas afficher
une résolution 4K native ou créer des détails par le zoom. Un véritable détail
rapproché est une image différente, pas un recadrage agrandi de la vue générale.

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
n’est certifiée dans cet atlas. La carte TaM principale conserve ces fonctions.

## Assemblage et validation

Le compilateur `scripts/build-illustration-atlas.cjs` lit le plan, les URL de
capture réelles et les PNG locaux. Il contrôle structure, dimensions, contenu
décodable et empreintes des images avant de les annoncer disponibles. Il vérifie
les formats réels PNG/JPEG des références, sans supposer leur format à partir
du nom de fichier. Il écrit atomiquement le manifeste avec son audit intégré. La variante TypeScript
`data/illustration-atlas.ts` conserve le contrat typé utilisé par la page.

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
