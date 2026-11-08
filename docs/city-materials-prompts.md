# Matériaux IA de Montpellier

Deux matériaux originaux sont générés avec l’outil d’image intégré. Les prompts ne contiennent aucune image Google ou photographie de façade. Les ouvertures et teintes sont interprétées et ne constituent pas un relevé architectural.

- Toiture : `public/city/materials/roof.png`.
- Façade : `public/city/materials/wall.png`.

La géométrie est indépendante de ces images : bâtiments CityGML officiels de Montpellier, millésime 2020, avec leurs véritables toitures. L’habillage ne modifie pas les volumes.

## Prompts exacts

### roof

```text
Use case: stylized-concept. Asset: one original seamless repeating material texture for a stylized 3D city of Montpellier. Produce ONLY a flat orthographic overhead material swatch of Mediterranean terracotta barrel roof tiles, roughly a 6 by 6 metre patch, in finely resolved pixel-art game style. Regular interlocking rows of small curved clay tiles, warm muted orange and ochre with restrained natural color variations and thin crisp edge shading. Perfectly tileable on all four edges. Uniform neutral illumination; no cast shadows, no perspective, no building roof outline, no ridge, no border, no text, no logos, no objects. The complete square is the repeating roof surface.
```

### wall

```text
Use case: stylized-concept. Asset: one original seamless repeating facade material texture for a stylized 3D city of Montpellier. Produce ONLY a flat frontal orthographic material swatch, roughly an 8 by 8 metre pale cream limestone French Mediterranean building facade, in finely resolved pixel-art game style. Three restrained stories and four evenly spaced vertical window bays; dark blue-grey window panes, thin pale stone surrounds and modest muted blue-grey shutters. Small realistic windows on a mostly quiet warm pale-stone surface; no doors, balconies, roof, ground, sky, people, signs, text, logos or border. Uniform neutral illumination, no perspective, no cast shadows. Perfectly tileable on all four edges, with window openings fully inside the square and aligned floors that repeat cleanly vertically and horizontally.
```
