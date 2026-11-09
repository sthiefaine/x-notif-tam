> Mise à jour : l’atelier utilise désormais un [atlas réaliste de 30 vues](realistic-illustration-atlas.md). Le texte suivant conserve le contexte du pilote fixe.

# Montpellier dessinée — illustration fixe

Le rendu retenu est désormais une illustration à caméra fixe, orientée au nord,
consultable dans l’atelier non indexé `/lab/illustration`. On peut zoomer et se
déplacer dans le dessin, sans changer l’angle de vue.

Le nouvel échantillon couvre le centre élargi : Peyrou, Écusson, Comédie,
Esplanade, Corum, Saint-Roch et une partie d’Antigone. Les vues rapprochées
Google Maps fournissent les détails ; la vue générale fixe la composition.
Le [journal de l’atlas réaliste](realistic-illustration-atlas.md) décrit
les références, le fichier publié et les limites du résultat.

Il ne s’agit pas encore d’un atlas continu de toute Montpellier : pas de calage
GPS certifié, de raccords validés ou de véhicules temps réel sur ce dessin.

## Ancienne voie de rendu

La scène native à caméra libre a été retirée à la demande de l’utilisateur.
`/lab/3d` redirige définitivement vers l’illustration et les 85 Mo de données
CityGML compilées ne sont plus servis depuis `public/city`. Les sources compilées
ont été préservées hors dépôt ; leur historique reste récupérable dans Git.

- [Production et validation historique du CityGML](montpellier-city-production.md).
- [Prompts historiques des matériaux originaux](city-materials-prompts.md).

Aucun SDK ni clé Google Maps n’est intégré au site. Le dessin publié est une
interprétation IA de références Google et conserve ce crédit ; il n’est pas
présenté comme une donnée ouverte issue uniquement du CityGML.
