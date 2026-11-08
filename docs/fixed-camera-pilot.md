# Échantillon illustré fixe — centre élargi, nord en haut

Publié sur `/lab/illustration`. L’ancien `/lab/3d` redirige définitivement vers
cette page ; son modèle de 85 Mo n’est plus servi publiquement.

## Image retenue

- Fichier : `public/lab/montpellier-centre-nord-v2.png`.
- Dimensions natives : **1672 × 941 px**, 4 745 091 octets.
- SHA-256 : `45179eef5f3190f166be652922e2935819997302ab38ca63183a8faf4c46c0bf`.
- Outil : génération d’image intégrée, références de composition et transfert de style.
- Zone plus étendue que le précédent échantillon Comédie : Peyrou, Écusson,
  Comédie, Esplanade–Corum, Saint-Roch et bordure ouest d’Antigone.
- Caméra : nord en haut, environ 39° d’inclinaison ; Comédie au-dessus de la gare.
- Crédit visible dans l’interface : **Illustration IA · Référence : Google Maps.
  Images ©2026 Google.** Aucun SDK ou clé Google n’est intégré au site.

Le fichier est un nouveau dessin, pas un agrandissement de l’ancien. Le prompt
visait une résolution native supérieure, mais l’outil a livré 1672 × 941 px :
ce résultat n’est donc pas présenté comme du 4K. Le gain porte sur l’étendue
représentée et les références architecturales rapprochées ; le zoom au-delà
des pixels natifs ne crée pas de détail supplémentaire.

## Références capturées le 9 novembre 2026

Sept vues anonymes Google Maps, même orientation, navigateur 1280 × 720.
Les cinq vues les plus proches sont environ quatre fois plus rapprochées que
la vue générale (indication de caméra ~377 m contre ~1534 m, pas une échelle
métrique certifiée). Les coordonnées dans les URL Google décrivent la caméra.

1. [Vue d’ensemble élargie, nord en haut](https://www.google.com/maps/@43.59761,3.8788,1534a,35y,39.03t/data=!3m1!1e3) — `01-overview.png`.
2. [Comédie, Écusson, Polygone à deux fois le rapprochement](https://www.google.com/maps/@43.6032076,3.8791885,762a,35y,39.21t/data=!3m1!1e3) — `02-comedie-ecusson.png`.
3. [Détail Comédie et Opéra, quatre fois plus proche](https://www.google.com/maps/@43.6060214,3.8793828,377a,35y,39.34t/data=!3m1!1e3) — `03-comedie-close.png`.
4. [Détail gare Saint-Roch et square Planchon](https://www.google.com/maps/@43.6016465,3.8793693,386a,35y,39.34t/data=!3m1!1e3) — `04-gare-saint-roch-close.png`.
5. [Détail Peyrou, arc de triomphe, boulevard du Jeu de Paume, Sainte-Anne](https://www.google.com/maps/@43.606985,3.8722492,372a,35y,39.34t/data=!3m1!1e3) — `05-peyrou-ecusson-close.png`.
6. [Détail Corum et Esplanade Charles-de-Gaulle](https://www.google.com/maps/@43.6100767,3.8817709,377a,35y,39.34t/data=!3m1!1e3) — `06-corum-esplanade-close.png`.
7. [Détail de la bordure ouest d’Antigone et du lycée Joffre](https://www.google.com/maps/@43.60767,3.8867683,384a,35y,39.34t/data=!3m1!1e3) — `07-antigone-joffre-close.png`.

Les captures sources sont conservées hors dépôt dans le dossier de travail
`fixed-north-v2`, avec un journal `references.json`. L’image fournie par
l’utilisateur fixe le style et l’orientation ; la nouvelle vue générale fixe
la couverture plus large.

L’appel retenu utilise la vue générale, les détails Comédie, Saint-Roch et
Corum, plus la référence de style utilisateur. Un second essai ajoute les vues
Peyrou et Antigone, mais a été écarté : il modifiait trop certains monuments.
Le fichier publié correspond au premier essai, jugé plus fidèle au cadrage.

## Consultation et limites

Le dessin remplit l’écran au départ, y compris sur mobile. Les boutons + / −,
le glisser, le pincement et le clavier permettent de se déplacer sans changer
l’orientation. « Tout voir » montre l’ensemble. Le zoom conserve le point vu.
Le crédit reste visible et l’image originale est accessible dans l’en-tête.

Les façades, matières, arbres et certains détails sont interprétés. Aucun
calage GPS ou raccord d’atlas n’est certifié ; aucun véhicule en direct n’est
superposé à cette image. Ce n’est pas encore toute Montpellier redessinée.
La référence Google reste créditée : un redessin IA ne transforme pas sa source
en donnée ouverte CityGML.

## Prompt exact retenu

Voir [`montpellier-centre-nord-v2.prompt.txt`](../output/imagegen/montpellier-centre-nord-v2.prompt.txt).
Les indices d’images correspondent aux cinq entrées de l’appel retenu ci-dessus.
