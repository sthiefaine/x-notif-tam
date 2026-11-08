# Montpellier dessinée : du pilote à la carte 3D

Le rendu retenu est une véritable scène 3D navigable : la géométrie publique
CityGML de Montpellier (2020) conserve les volumes et toitures, tandis que deux
matériaux originaux générés par IA habillent façades et toits. Les positions des
arbres viennent de l’inventaire municipal ; leurs formes et tailles sont stylisées.

Le premier cadrage est Comédie–Saint-Roch. Les données compilées couvrent toute
la commune : 42 085 bâtiments répartis en 315 tuiles et 60 648 arbres. La scène
charge les détails seulement autour de la vue ; elle ne charge pas les 85 Mo
complets au démarrage. Les boutons permettent de zoomer, tourner, incliner et
recentrer la carte.

- [Sources, méthode, licence, limites et reproduction](montpellier-city-production.md).
- [Prompts exacts et fichiers des matériaux IA](city-materials-prompts.md).
- [Échantillon illustré à caméra fixe et son prompt](fixed-camera-pilot.md) :
  un seul cadrage du centre, à comparer avec la 3D libre. Le catalogue géométrique
  complet ne signifie pas que toute la ville est déjà redessinée en atlas.

## Rôle de Google Maps

La vue 3D Google Maps indiquée par l’utilisateur sert de référence visuelle de
niveau de détail et de cadrage pendant la préparation. Les premières images
fixes ont permis d’évaluer le style, mais ne sont pas le fond de la carte actuelle.
Aucun SDK Google, capture satellite, photomaillage Google ou texture Google n’est
intégré à cette scène. Les prompts des matériaux sont textuels, sans image Google.
Aucune clé Google Maps n’a été créée ou configurée pour ce pilote.

Assembler des captures indépendantes aurait demandé environ 1 700 dessins au
pas proposé de 192 m utiles, avec des problèmes de perspective et de raccords.
L’URL Google ne définit d’ailleurs pas seule une résolution métrique certifiée.
La géométrie commune permet ici de garder les rues et les volumes indépendants
de l’habillage, et de changer librement de caméra.

## Limites du premier rendu

- Le millésime des bâtiments est 2020, pas une reconstruction actuelle garantie.
- Les façades, matières et dimensions des arbres sont des interprétations.
- Le relief entre les bâtiments n’est pas reconstitué : chaque bâtiment est
  abaissé jusqu’à son sol local pour le fond de carte plan.
- Les véhicules et alertes de la carte principale ne sont pas encore superposés
  à cet atelier. Leur calage et leur visibilité derrière les bâtiments restent
  une étape distincte.
