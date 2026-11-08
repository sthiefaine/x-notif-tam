# Montpellier : atlas natif des bâtiments 3D

L’atlas utilise les géométries publiques des bâtiments de Montpellier, millésime
2020. Il remplace, pour cette voie de rendu, la référence photographique fixe par
une scène dont les positions proviennent du CityGML. Les couleurs et les matières
du rendu sont un habillage graphique, pas des photographies des façades réelles.

## État contrôlé le 8 novembre 2026

L’atlas de la commune entière a passé la validation stricte avec l’audit source :
42 085 bâtiments, 315 tuiles, 3 431 498 triangles et 5 767 942 sommets. Les quinze
lots ont été inventoriés : onze lus, quatre ignorés après vérification que leurs
enveloppes n’intersectent pas la commune. Les 42 085 emprises retenues
intersectent le véritable contour ; six bâtiments frontaliers sont conservés
entiers. Aucun sommet publié n’est inutilisé.

Les géométries représentent 78 294 860 octets non compressés. Leur estimation
gzip est de 30 188 726 octets avec le compilateur, ou 34 664 616 octets avec le
zlib du Node utilisé pour la validation. Le répertoire d’atlas complet, comprenant
les deux matières, les arbres et les métadonnées, représente environ 85,29 Mo.
Ces volumes ne décrivent pas le chargement initial du visualiseur, qui ne demande
que les tuiles de son cadrage.

La compilation compte 30 polygones réparés, 182 polygones inutilisables écartés et
101 913 triangles dégénérés ou incompatibles avec la quantification écartés.
L’écart relatif maximal de surface après réparation et triangulation est
`0.0007616034` ; le champ `maxSourceTriangulationAreaDeviation` décrit le problème
initial avant réparation et ne doit pas être pris pour l’erreur résiduelle.
Les toitures quasi verticales peuvent avoir une composante haute de normale
arrondie à zéro en `Int8` : 31 sommets dans cet atlas, aucune composante orientée
vers le bas. Le contrôle d’accord des normales avec les triangles reste actif.

L’audit complet privé comporte 42 085 enregistrements et porte le SHA-256
`f0583bc6275e205c7e10dd327dd4feaadb0c2b2603bb61fb539a552b080626b2`.

## Sources vérifiées et disponibilité

La [fiche officielle des bâtiments 3D](https://opendata.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier)
décrit un jeu CityGML de 2020, niveau de détail LoD 2.2, sous ODbL. L’archive
[MMM_MMM_Bat3D.zip](https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D.zip)
est téléchargeable directement ; elle a été récupérée pendant le travail du
8 novembre 2026. La [fiche de la ressource](https://opendata.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier/resource/6b26a18b-5e81-4935-a0c0)
annonce 477 429 686 octets. Elle liste les quinze archives `Batch0` à `Batch14`
et une archive supplémentaire `bati_2020_Batchs.zip`, alors que le descriptif
général parle de quatorze zones. Le compilateur inventorie les quinze lots de
bâtiments nommés ; il ne déduit pas leur nombre du texte descriptif.

La [note technique du fournisseur](https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D_Note.pdf)
reste la référence associée aux données. La limite administrative vient du
[GeoJSON officiel de la commune](https://data.montpellier3m.fr/sites/default/files/ressources/VilleMTP_MTP_LimiteCommune.geojson).
La sélection concerne Montpellier, code INSEE `34172`.

Le [photomaillage métropolitain](https://opendata.montpellier3m.fr/dataset/modele-photomesh-3d-de-la-ville-et-metropole-de-montpellier)
est un autre produit : le portail indique des dalles OBJ texturées, disponibles
sur demande. Ce photomaillage n’est pas utilisé par ce pipeline.

Les positions d’arbres viennent du
[fichier officiel des arbres de Montpellier](https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MTP_Arbres.json),
également identifié ODbL-1.0 dans l’export. `scripts/compile-montpellier-trees.py`
ne conserve que les positions dans le véritable contour communal et retire les
doublons exacts. Le fichier résultant contient 60 648 positions, vérifiées dans
le contour officiel, sans doublon exact. Sa date `2026-11-08` est la date de
récupération, pas une date de mesure garantie pour chaque arbre.

## Provenance et licence

L’attribution publique à conserver est :

> © Montpellier Méditerranée Métropole · Avineon · 2020 · ODbL 1.0

Les métadonnées du fournisseur annoncent la licence
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
L’atlas conserve sa provenance, le millésime, la licence, les URL source et la
méthode de transformation dans son manifeste. La version dérivée reste identifiée
`ODbL-1.0`. Les matières de toiture et de façade ont leur propre provenance
documentée dans [city-materials-prompts.md](city-materials-prompts.md) : ce sont
des créations graphiques générées à partir de descriptions, sans image Google
en entrée. Elles ne modifient pas la provenance des géométries.

Aucune texture Google, capture satellite ni archive CityGML n’est une ressource
de cet atlas public. Les archives et la preuve détaillée de sélection restent
dans un répertoire de travail privé, hors de `public`.

## Transformation et limites géographiques

Le compilateur lit les XML contenus dans les archives sans décompresser plusieurs
gigaoctets de CityGML sur disque. Le repère source déclaré est
`EPSG:2154+EPSG:5720`. Il transforme les coordonnées vers le Web Mercator
normalisé utilisé par MapLibre. Les axes de position sont est, sud, haut ; les
normales sont exprimées est, nord, haut.

La sélection s’appuie sur l’intersection entre l’emprise `GroundSurface` du
bâtiment et le véritable polygone communal. Une boîte englobante sert uniquement
à accélérer les rejets. Un bâtiment qui traverse la limite est conservé entier ;
les triangles ne sont pas découpés le long de cette limite. Il est donc normal de
voir quelques géométries dépasser du contour communal.

Chaque bâtiment possède une seule tuile propriétaire. Les tuiles suivent une
grille Lambert-93 de 512 mètres, avec subdivision si nécessaire. Leurs emprises
publiées englobent réellement les bâtiments entiers. Les `RoofSurface` et
`WallSurface`, y compris les anneaux intérieurs utilisables, sont triangulés. Les
polygones invalides peuvent être réparés avant triangulation ; les réparations et
les faces rejetées sont comptées dans les statistiques du manifeste.

Les positions locales sont quantifiées par pas de 5 cm. Ce pas de stockage ne
constitue pas une précision de levé de 5 cm. Pour le rendu actuel, chaque bâtiment
est abaissé par son `ZMIN` source, ou par le minimum de sa surface de sol si cette
valeur manque. Aucun modèle numérique de terrain n’est inclus. Les différences
de niveau du terrain entre bâtiments ne sont donc pas restituées.

`status: complete` signifie que le traitement porte sur la commune entière et que
les quinze lots sont inventoriés comme lus ou rejetés par une enveloppe située
hors de la commune. Cela ne garantit ni la présence de tous les bâtiments de
2026, ni l’absence d’erreurs dans le levé 2020. Le modèle ne certifie pas la
précision d’une position GPS, la topologie des rues, les voies de circulation ou
la hauteur correcte d’un véhicule sur une chaussée.

Les arbres sont symbolisés en 3D à partir de leurs positions : hauteur, largeur
de couronne et forme du tronc relèvent du style du visualiseur. Ces dimensions
ne sont pas des mesures de terrain. `manifest.vegetation` référence leur fichier,
leur source, leur licence, leur date, leur nombre et leur SHA-256.

## Format livré et compression

`public/city/manifest.json` décrit les sources, le contour, les statistiques, la
couverture et les tuiles. `index.json`, lorsqu’il existe, est un alias identique.
`boundary.geojson` contient le contour administratif publié.

Chaque tuile `.bin` utilise le format `MCT1`, en little endian :

- En-tête de 80 octets : signature, version, drapeau de largeur des indices,
  nombres de sommets et d’indices, origine Mercator en `Float64`, échelle locale,
  pas de quantification, offsets des quatre sections, longueur totale et nombre
  de bâtiments.
- Positions locales `Int16` à trois composantes, normales `Int8` à trois
  composantes normalisées par 127, surfaces `Uint8` avec `0 = toiture` et
  `1 = façade`, puis indices `Uint16` ou `Uint32`.
- Sections alignées sur quatre octets. Une position monde vaut
  `origin + positionQuantifiee × scaleNorm`.

Les `.bin` présents dans le dépôt sont non compressés. `gzipByteLength` mesure
leur compression théorique gzip niveau 6 ; cette valeur ne doit pas être
présentée comme le volume réellement transféré avant vérification du
`Content-Encoding` de l’hébergement. Le validateur distingue les octets publiés,
le volume des tuiles et les deux estimations gzip : celle du compilateur et celle
recalculée par Node. Des versions différentes de zlib peuvent produire des
tailles différentes à niveau égal. Les matières sont de petits fichiers
PNG séparés. Le visualiseur charge les tuiles visibles, limite les requêtes
simultanées et évince les anciennes données GPU selon son budget.

## Reproduction

Prérequis : Node.js, `uv`, accès au téléchargement officiel et espace de travail
hors du répertoire public. Les versions utilisées par le compilateur sont
Python 3.14.3, pyproj 3.8.0, lxml 6.1.3, mapbox-earcut 2.1.0, numpy 2.5.4 et
shapely 2.2.0. Les dépendances effectives sont aussi inscrites au manifeste.

```sh
CITY_SOURCE_DIR="$HOME/.cache/x-notif-tam-city"
mkdir -p "$CITY_SOURCE_DIR"
curl --fail --location --retry 3 \
  --output "$CITY_SOURCE_DIR/MMM_MMM_Bat3D.zip" \
  https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D.zip
curl --fail --location --retry 3 \
  --output "$CITY_SOURCE_DIR/VilleMTP_MTP_LimiteCommune.geojson" \
  https://data.montpellier3m.fr/sites/default/files/ressources/VilleMTP_MTP_LimiteCommune.geojson
uv venv --python 3.14.3 "$CITY_SOURCE_DIR/.venv"
uv pip install --python "$CITY_SOURCE_DIR/.venv/bin/python" \
  pyproj==3.8.0 lxml==6.1.3 mapbox-earcut==2.1.0 numpy==2.5.4 shapely==2.2.0
"$CITY_SOURCE_DIR/.venv/bin/python" scripts/compile-montpellier-trees.py \
  --download --source "$CITY_SOURCE_DIR/MMM_MTP_Arbres.json" \
  --boundary "$CITY_SOURCE_DIR/VilleMTP_MTP_LimiteCommune.geojson" \
  --output "$CITY_SOURCE_DIR/trees.json" --date 2026-11-08
"$CITY_SOURCE_DIR/.venv/bin/python" scripts/compile-montpellier-city.py \
  --archive "$CITY_SOURCE_DIR/MMM_MMM_Bat3D.zip" \
  --boundary "$CITY_SOURCE_DIR/VilleMTP_MTP_LimiteCommune.geojson" \
  --trees "$CITY_SOURCE_DIR/trees.json" \
  --output "$CITY_SOURCE_DIR/compiled-city" \
  --audit "$CITY_SOURCE_DIR/selection-audit.full.ndjson.gz"
node scripts/validate-montpellier-city.cjs \
  --city "$CITY_SOURCE_DIR/compiled-city" \
  --audit "$CITY_SOURCE_DIR/selection-audit.full.ndjson.gz"
```

Utiliser un nouveau dossier de sortie vide pour chaque compilation. La sortie
validée peut ensuite remplacer les données de `public/city`, en conservant les
deux matières originales de `public/city/materials`, puis être validée de nouveau
avec le même audit. Les volumes indiqués plus haut incluent ces matières.

Pour un essai limité au centre, ajouter
`--bbox 3.875 43.601 3.886 43.612` à la compilation et utiliser un autre nom
d’audit. Le manifeste devient `sample` ; le validateur exige alors explicitement
`--allow-sample`. Ne pas substituer cet essai à la validation de la commune
entière. Pour valider un atlas de préparation situé ailleurs, passer
`--city chemin/vers/atlas` au validateur.

## Validation indépendante

`scripts/validate-montpellier-city.cjs` n’importe aucun code du compilateur ni du
visualiseur. Il relit les octets produits et vérifie :

- En-têtes, tailles, alignement et absence de sections chevauchantes ; indices
  valides, nombre de triangles et surfaces limitées aux deux types publiés.
- Valeurs géographiques finies, origine et échelle Mercator cohérentes,
  géométries dans leurs emprises, normales unitaires, toiture orientée vers le
  haut et accord entre normales et ordre des sommets après quantification.
- Absence de triangles dégénérés après quantification ; cohérence des comptages
  par tuile et globaux, fichiers référencés présents et absence de fichiers
  d’atlas oubliés.
- Attribution, source officielle, millésime, licence, vrai contour communal et
  inventaire des lots. Un lot ignoré doit posséder une enveloppe qui
  n’intersecte pas le contour communal.
- Absence d’archives et de géométries source brutes dans `public`, absence de
  ressources Google dans l’atlas ; seules les deux matières documentées sont
  acceptées comme images d’atlas.
- Fichier d’arbres référencé par son SHA-256, source et licence conservées,
  coordonnées finies à deux composantes, nombre exact, positions dans le vrai
  contour et absence de doublons exacts.

La géométrie du contour est aussi comparée à une empreinte indépendante du
fichier officiel récupéré le 8 novembre 2026 : SHA-256 du JSON canonique de la
géométrie `244804faad907da0b5b3e76433a6996ba9d1414d4275644b4c173ffefe4636bd`.
Une évolution officielle de cette limite nécessite une vérification et une mise
à jour explicite de cette empreinte ; ajouter des sommets à une fausse boîte ne
suffit pas à passer ce contrôle.

L’audit privé gzip NDJSON contient l’identifiant source de chaque bâtiment,
l’emprise `GroundSurface`, la tuile et sa plage d’indices. Le manifeste porte le
SHA-256 de cet audit. Le validateur recalcule ce hash, vérifie l’intersection de
chaque emprise avec la commune, contrôle que les emprises du maillage et du sol
se recoupent et que les plages couvrent tous les triangles une seule fois. Cette preuve
de sélection apporte un contrôle plus fort que des points situés dans une simple
boîte englobante.

Le validateur ne reparcourt pas les XML source pour certifier que chaque emprise
de l’audit correspond exactement à son objet CityGML initial ; l’audit est une
preuve de transformation à conserver avec l’archive source.

L’option `--geometry-only` permet de vérifier la structure publique sans l’audit
privé. Le rapport indique alors explicitement une portée limitée et ne confirme
pas les intersections des emprises source. Sans cette option et sans audit, le
validateur échoue.

La cohérence numérique des fichiers ne remplace pas une vérification visuelle
de repères connus, des rues, des cours et des bâtiments aux limites de la
commune. Le résultat reste un rendu stylisé d’un jeu de données daté.
