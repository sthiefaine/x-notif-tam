# Prototype illustré Comédie–Gare Saint-Roch

## Accès et périmètre

La page `/lab/3d` reste hors de la navigation principale et porte `noindex`.
Le pilote couvre un seul quartier. La référence 3D est géographique ; le
redessin IA est un aperçu fixe expérimental, avec des détails à vérifier.

## Plan de réalisation

1. Construire la référence avec les empreintes et hauteurs ouvertes
   OpenStreetMap/OpenFreeMap. Les données IGN pourront enrichir les volumes.
2. Fixer une caméra et enregistrer la référence et ses paramètres.
3. Redessiner une image par IA avec les rues, intersections et empreintes comme
   invariants. Contrôler les raccords, perspectives et repères sur l'échantillon.
4. Pour une carte illustrée navigable, choisir une projection et un système de
   tuilage communs avant de produire les tuiles voisines. Une capture déjà
   inclinée ne doit pas être inclinée une seconde fois comme une texture au sol.
5. Superposer des positions et tracés réels seulement après validation des
   transformations géographiques et des masques de profondeur. Le pilote
   illustré n'affiche aucun faux véhicule.

Les images sont préparées puis servies comme fichiers statiques. Aucun appel de
génération d'image n'est déclenché par un voyageur et aucune clé de génération
n'est distribuée au navigateur.

## Référence

- Capture : `public/lab/montpellier-reference-3d.png`, 8 novembre 2026.
- Caméra : centre `[3.8795,43.6068]`, zoom `17`, inclinaison `55°`, orientation `-25°`.
- Vue navigateur : `1280×1024`, carte extraite du rectangle
  `[0,175.59375,1280,812.40625]` en pixels CSS.
- [Style Liberty OpenFreeMap](https://tiles.openfreemap.org/styles/liberty).
- [Hauteurs OpenMapTiles](https://openmaptiles.org/docs/schema/#building).
- [Source et attribution OpenStreetMap](https://www.openstreetmap.org/copyright).
- [Conditions OpenFreeMap](https://openfreemap.org/tos/).
- [Référence MapLibre : bâtiments 3D](https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/).

Les volumes OSM sont simplifiés et leurs hauteurs peuvent être estimées. Les
façades ajoutées par l'IA ne constituent pas un relevé architectural.

## Génération

Première version : outil intégré de génération d'images, sans appel à une API
payante depuis le site. Résultat : `public/lab/montpellier-illustration-pilot.png`.
Le redessin conserve l'organisation générale, mais ses façades et certains détails
sont interprétés ; il est présenté comme une illustration fixe. Prompt exact ci-dessous.

```text
Use case: style-transfer.
Asset: one experimental illustrated map image for a hidden Montpellier prototype.
Input image 1 is BOTH the edit target and the strict geometric reference: a real OpenStreetMap/OpenFreeMap 3D rendering of the Comédie–Gare Saint-Roch area.

Redraw this exact image as a beautiful, highly detailed high-bit pixel-art miniature Mediterranean French city. Warm pale-limestone and cream façades, restrained terracotta and slate roof details, crisp window rhythms, green trees within the existing parks, subtle natural daylight and clean readable streets. Finely resolved pixel-art textures, not coarse low-resolution blocks, no tilt-shift blur.

Geometric invariants: keep the exact camera, perspective, framing, street edges, street intersections, plazas, building footprints, courtyard openings, and approximate building heights from the input. Do not move or replace blocks. Comédie is in the upper central part; the Rue Maguelone corridor runs down toward Gare Saint-Roch and Square Planchon in the lower centre. Preserve these relationships exactly. Do not create new roads, extra landmarks, towers, bridges or invented monuments. Keep the same landscape aspect ratio and viewpoint.

Produce city artwork only: the interface controls, point-of-interest icons, map labels, station rings and coloured route guide overlays in the reference are not part of the illustration. Depict the underlying real roads in those same positions. Do not add vehicles, people, words, labels, logos, borders or interface. Attribution will be displayed outside the image by the application.

The resulting image is a style prototype, not a claim of surveyed façade accuracy. Return one finished landscape image.
```
