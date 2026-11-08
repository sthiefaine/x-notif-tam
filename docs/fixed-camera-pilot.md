# Échantillon illustré à caméra fixe — Comédie

Ce rendu compare une illustration dessinée à la maquette 3D libre. Il couvre
uniquement le cadrage du centre présenté sur `/lab/illustration` ; il ne constitue
pas encore un atlas dessiné de toute la ville. La [vue 3D](montpellier-city-production.md)
utilise en revanche le catalogue de bâtiments 2020 compilé sur toute la commune.

- Image : `public/lab/montpellier-centre-illustration.png`.
- Outil : génération d’image intégrée, mode transfert de style.
- Référence : capture du modèle CityGML de Montpellier avec les matériaux IA
  originaux et les arbres municipaux symbolisés. Aucune image Google en entrée.
- Cadrage : centre [3.8794,43.6081], zoom 18.2, inclinaison 55°, direction 90°,
  navigateur 1280 × 720 ; l’interface est retirée par le redessin.
- Crédit : bâtiments © Montpellier Méditerranée Métropole / Avineon, 2020, ODbL.

Les façades, matières et certains détails sont interprétés. Ce dessin n’a pas
passé de validation de calage GPS. Il ne reçoit donc aucun faux véhicule en direct.
Un atlas continu demanderait une projection commune, des recouvrements et une
validation géométrique de chaque raccord ; une belle image ne démontre pas cela.

## Prompt exact

```text
Use case: style-transfer.
Asset: a fixed-camera illustrated atlas pilot of Place de la Comédie, Montpellier.
Input image 1 is the strict geometric reference and edit target: an actual georeferenced 3D rendering of official 2020 Montpellier building geometry, with symbolic municipal trees.

Transform the CITY ONLY into a beautiful, richly detailed high-bit pixel-art miniature that feels drawn by a skilled game environment artist, rather than like a plain GIS model. Fine crisp pixel craft, thin readable architectural outlines, individual terracotta roof tiles, varied pale limestone and cream façades, coherent windows and shutters, restrained ornamental stone details, lively soft green tree canopies and warm stone plaza paving. Subtle coherent daylight and contact shadows, excellent visual depth. Keep the actual irregular Mediterranean building forms; do not substitute generic Parisian blocks.

CRITICAL: preserve the exact source camera, perspective, street edges and intersections, central plaza shape, building footprints, silhouettes, roof shapes, dormers, courtyard holes and tree locations. Keep the large open Place de la Comédie and the small existing pale-blue fountain basin in their same positions. Preserve the separation between buildings and all visible passages. The illustrated façade details may be interpreted, but the city layout must stay aligned. No new monuments, roads, large pools, extra tree rows, shifted blocks, people or vehicles.

Crop away the application header, buttons, compass, scale, captions and interface overlays. Work only with the unobstructed city image; do not expand the scene to invent hidden streets. No title, interface or place-name labels in the city artwork.
Include a discreet white attribution strip below the image with this exact text: "Illustration IA — Bâtiments © Montpellier Méditerranée Métropole / Avineon, 2020 — ODbL."
Return one finished landscape illustration, keeping the same city framing.
```
