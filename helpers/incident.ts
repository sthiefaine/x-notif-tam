export function determineCauseByKeywords(
  descriptionText: string,
  headerText: string
) {
  const lowerDesc = (descriptionText || "").toLowerCase();
  const lowerHeader = (headerText || "").toLowerCase();
  const fullText = lowerDesc + " " + lowerHeader;

  // not real gtfs cause enum
  // http://gtfs.org/fr/documentation/realtime/reference/
  //
  if (
    fullText.includes("condition") &&
    fullText.includes("circulation") &&
    fullText.includes("difficile")
  ) {
    return "TRAFFIC_JAM";
  }

  if (
    fullText.includes("secours") ||
    fullText.includes("ambulance") ||
    fullText.includes("blessé") ||
    fullText.includes("médical") ||
    fullText.includes("malaise")
  ) {
    return "MEDICAL_EMERGENCY";
  }

  if (
    fullText.includes("police") ||
    fullText.includes("gendarmerie") ||
    fullText.includes("sécurité") ||
    fullText.includes("interpellation") ||
    fullText.includes("contrôle")
  ) {
    return "POLICE_ACTIVITY";
  }

  if (
    fullText.includes("panne") ||
    fullText.includes("technique") ||
    fullText.includes("défaillance") ||
    fullText.includes("incident tech") ||
    fullText.includes("incident d'exploitation")
  ) {
    return "TECHNICAL_PROBLEM";
  }

  if (
    fullText.includes("travaux") ||
    fullText.includes("chantier") ||
    fullText.includes("aménagement")
  ) {
    return "CONSTRUCTION";
  }

  if (
    fullText.includes("maintenance") ||
    fullText.includes("entretien") ||
    fullText.includes("réparation")
  ) {
    return "MAINTENANCE";
  }

  if (
    fullText.includes("accident") ||
    fullText.includes("collision") ||
    fullText.includes("accrochage") ||
    fullText.includes("véhicule sur la voie")
  ) {
    return "ACCIDENT";
  }

  if (
    fullText.includes("grève") ||
    fullText.includes("social") ||
    fullText.includes("mouvement social")
  ) {
    return "STRIKE";
  }

  if (
    fullText.includes("manifestation") ||
    fullText.includes("cortège") ||
    fullText.includes("rassemblement") ||
    fullText.includes("défilé") ||
    fullText.includes("marche")
  ) {
    return "DEMONSTRATION";
  }

  if (
    fullText.includes("neige") ||
    fullText.includes("pluie") ||
    fullText.includes("météo") ||
    fullText.includes("tempête") ||
    fullText.includes("vent") ||
    fullText.includes("intempérie") ||
    fullText.includes("orage") ||
    fullText.includes("inondation")
  ) {
    return "WEATHER";
  }

  if (
    fullText.includes("fête") ||
    fullText.includes("festival") ||
    fullText.includes("événement") ||
    fullText.includes("férié")
  ) {
    return "HOLIDAY";
  }

  return "OTHER_CAUSE";
}

export function determineEffectByKeywords(
  descriptionText: string,
  headerText: string
) {
  const lowerDesc = (descriptionText || "").toLowerCase();
  const lowerHeader = (headerText || "").toLowerCase();
  const fullText = lowerDesc + " " + lowerHeader;

  if (
    fullText.includes("interrompu") ||
    fullText.includes("supprimé") ||
    fullText.includes("suppression") ||
    fullText.includes("annulé") ||
    fullText.includes("annulation") ||
    fullText.includes("ne circule pas")
  ) {
    return "NO_SERVICE";
  }

  if (
    fullText.includes("service réduit") ||
    fullText.includes("fréquence réduite") ||
    fullText.includes("fréquence allégée") ||
    fullText.includes("moins de tramways")
  ) {
    return "REDUCED_SERVICE";
  }

  if (
    fullText.includes("retard") ||
    fullText.includes("ralenti") ||
    fullText.includes("ralentissement") ||
    fullText.includes("perturbé") ||
    fullText.includes("perturbation")
  ) {
    return "SIGNIFICANT_DELAYS";
  }

  if (
    fullText.includes("déviation") ||
    fullText.includes("dévié") ||
    fullText.includes("itinéraire modifié") ||
    fullText.includes("contournement")
  ) {
    return "DETOUR";
  }

  if (
    fullText.includes("arrêt non desservi") ||
    fullText.includes("station non desservie") ||
    fullText.includes("ne marque pas l'arrêt") ||
    fullText.includes("sans arrêt à")
  ) {
    return "STOP_MOVED";
  }

  if (
    fullText.includes("arrêt déplacé") ||
    fullText.includes("reporté à") ||
    fullText.includes("déplacé à") ||
    fullText.includes("utiliser l'arrêt")
  ) {
    return "STOP_MOVED";
  }

  if (
    fullText.includes("modifi") ||
    fullText.includes("changement") ||
    fullText.includes("altération")
  ) {
    return "OTHER_EFFECT";
  }

  if (
    fullText.includes("complément d'info") ||
    fullText.includes("information") ||
    fullText.includes("à noter") ||
    fullText.includes("rappel")
  ) {
    return "OTHER_EFFECT";
  }

  return "UNKNOWN_EFFECT";
}
