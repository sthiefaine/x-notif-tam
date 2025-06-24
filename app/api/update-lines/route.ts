import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const prisma = new PrismaClient();

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (
      process.env.CRON_SECRET &&
      authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
      });
    }

    console.log(
      "Démarrage de la mise à jour des données de lignes de transport..."
    );
    const startTime = Date.now();

    console.log("Téléchargement des fichiers JSON...");
    const [tramResponse, busResponse, projetResponse] = await Promise.all([
      fetch(
        "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json"
      ),
      fetch(
        "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_BusLigne.json"
      ),
      fetch(
        "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_ProjetReseauBustram.json"
      ),
    ]);

    const tramData = await tramResponse.json();
    const busData = await busResponse.json();
    const projetData = await projetResponse.json();

    console.log(
      `Données téléchargées - Tram: ${
        tramData.features?.length || 0
      } lignes, Bus: ${busData.features?.length || 0} lignes, Projet: ${
        projetData.features?.length || 0
      } lignes`
    );

    // Récupérer les routes existantes pour mapper les IDs
    const routes = await prisma.route.findMany({
      select: {
        id: true,
        shortName: true,
      },
    });

    // Créer un mapping des shortName vers les IDs
    const routeMapping = new Map();
    routes.forEach((route) => {
      if (route.shortName) {
        routeMapping.set(route.shortName, route.id);
      }
    });

    console.log(
      `${routes.length} routes existantes trouvées dans la base de données`
    );

    // Traiter et insérer les données tram
    const tramResults = await processTramLines(tramData, routeMapping);

    // Traiter et insérer les données bus
    const busResults = await processBusLines(busData, routeMapping);

    // Traiter et insérer les données du projet réseau
    const projetResults = await processProjetLines(projetData, routeMapping);

    // Calculer les statistiques finales
    const totalProcessed =
      tramResults.processed + busResults.processed + projetResults.processed;
    const totalCreated =
      tramResults.created + busResults.created + projetResults.created;
    const totalUpdated =
      tramResults.updated + busResults.updated + projetResults.updated;
    const totalSkipped =
      tramResults.skipped + busResults.skipped + projetResults.skipped;

    const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`Traitement terminé en ${durationSeconds}s`);
    console.log(
      `Total traité: ${totalProcessed}, Créé: ${totalCreated}, Mis à jour: ${totalUpdated}, Ignoré: ${totalSkipped}`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Données des lignes mises à jour avec succès",
        stats: {
          duration: `${durationSeconds}s`,
          processed: totalProcessed,
          created: totalCreated,
          updated: totalUpdated,
          skipped: totalSkipped,
          tram: tramResults,
          bus: busResults,
          projet: projetResults,
        },
      })
    );
  } catch (error) {
    console.error(
      "Erreur lors de la mise à jour des données de lignes:",
      error
    );
    return new Response(
      JSON.stringify({
        error: "Erreur lors de la mise à jour des données",
        message: error instanceof Error ? error.message : String(error),
      }),
      { status: 500 }
    );
  }
}

function extractLineNumber(properties: any, lineType: string): string | null {
  let rawLineNumber = null;

  // Vérifier d'abord nom_ligne qui contient le format L8
  if (properties.nom_ligne) {
    const nomLigneMatch = properties.nom_ligne.match(/^([LT]\d+[a-zA-Z]?)/i);
    if (nomLigneMatch) {
      rawLineNumber = nomLigneMatch[1].trim();
    }
  }

  // Utiliser codetotem si disponible et pas encore trouvé
  if (!rawLineNumber && properties.codetotem) {
    rawLineNumber = properties.codetotem.trim();
  }

  // Vérifier nom_carto si pas encore trouvé
  if (!rawLineNumber && properties.nom_carto) {
    const nomCartoMatch = properties.nom_carto.match(/Ligne\s+(\d+[a-zA-Z]?)/i);
    if (nomCartoMatch) {
      rawLineNumber = nomCartoMatch[1].trim();
    }
  }

  // Utiliser l'id en dernier recours
  if (!rawLineNumber && properties.id) {
    rawLineNumber = properties.id.toString().trim();
  }

  if (!rawLineNumber) {
    return null;
  }

  // Convertir au format correct pour la base de données
  if (lineType === "tram") {
    // Si le format est L1, L2, etc., convertir en T1, T2, etc.
    if (rawLineNumber.toUpperCase().startsWith("L")) {
      const convertedNumber = "T" + rawLineNumber.substring(1);
      console.log(`Conversion tram: ${rawLineNumber} → ${convertedNumber}`);
      return convertedNumber;
    }
    // Si le numéro est fourni sans préfixe, ajouter T
    if (/^\d+$/.test(rawLineNumber)) {
      const convertedNumber = "T" + rawLineNumber;
      console.log(`Conversion tram: ${rawLineNumber} → ${convertedNumber}`);
      return convertedNumber;
    }
  } else if (lineType === "bus") {
    // Si le format est L44, extraire juste le numéro 44
    if (rawLineNumber.toUpperCase().startsWith("L")) {
      rawLineNumber = rawLineNumber.substring(1);
      console.log(
        `Extraction numéro bus: L${rawLineNumber} → ${rawLineNumber}`
      );
    }

    // Ajouter un padding zéro pour les numéros de 1 à 9
    if (/^[1-9]$/.test(rawLineNumber)) {
      const paddedNumber = "0" + rawLineNumber;
      console.log(`Padding numéro bus: ${rawLineNumber} → ${paddedNumber}`);
      return paddedNumber;
    }
  }

  // Si déjà au bon format ou format inconnu, retourner tel quel
  return rawLineNumber;
}

// Fonction pour traiter les lignes de tram
async function processTramLines(
  tramData: any,
  routeMapping: Map<string, string>
) {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  if (!tramData.features || !Array.isArray(tramData.features)) {
    console.warn("Données de tram invalides ou vides");
    return { processed, created, updated, skipped };
  }

  console.log(`Traitement de ${tramData.features.length} lignes de tram...`);

  for (const feature of tramData.features) {
    processed++;

    try {
      // Utiliser la fonction améliorée d'extraction
      const lineNumber = extractLineNumber(feature.properties, "tram");

      if (!lineNumber) {
        console.warn(
          `Impossible d'identifier le numéro de ligne pour une entrée tram: ${JSON.stringify(
            feature.properties
          )}`
        );
        skipped++;
        continue;
      }

      const routeId = routeMapping.get(lineNumber);

      if (!routeId) {
        console.warn(
          `Aucune route correspondante trouvée pour la ligne de tram ${lineNumber}`
        );
        skipped++;
        continue;
      }

      const existing = await prisma.lineGeometry.findFirst({
        where: {
          routeId,
          lineType: "tram",
        },
      });

      if (existing) {
        await prisma.lineGeometry.update({
          where: { id: existing.id },
          data: {
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        updated++;
        console.log(`Ligne de tram ${lineNumber} (ID: ${routeId}) mise à jour`);
      } else {
        await prisma.lineGeometry.create({
          data: {
            routeId,
            lineType: "tram",
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        created++;
        console.log(`Ligne de tram ${lineNumber} (ID: ${routeId}) créée`);
      }
    } catch (error) {
      console.error(
        `Erreur lors du traitement de la ligne de tram #${processed}:`,
        error
      );
      skipped++;
    }
  }

  return { processed, created, updated, skipped };
}

async function processBusLines(
  busData: any,
  routeMapping: Map<string, string>
) {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  if (!busData.features || !Array.isArray(busData.features)) {
    console.warn("Données de bus invalides ou vides");
    return { processed, created, updated, skipped };
  }

  console.log(`Traitement de ${busData.features.length} lignes de bus...`);

  for (const feature of busData.features) {
    processed++;

    try {
      // Utiliser la fonction améliorée d'extraction
      const lineNumber = extractLineNumber(feature.properties, "bus");

      if (!lineNumber) {
        console.warn(
          `Impossible d'identifier le numéro de ligne pour une entrée bus: ${JSON.stringify(
            feature.properties
          )}`
        );
        skipped++;
        continue;
      }

      const routeId = routeMapping.get(lineNumber);

      if (!routeId) {
        console.warn(
          `Aucune route correspondante trouvée pour la ligne de bus ${lineNumber}`
        );
        skipped++;
        continue;
      }

      const existing = await prisma.lineGeometry.findFirst({
        where: {
          routeId,
          lineType: "bus",
        },
      });

      if (existing) {
        await prisma.lineGeometry.update({
          where: { id: existing.id },
          data: {
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        updated++;
        console.log(`Ligne de bus ${lineNumber} (ID: ${routeId}) mise à jour`);
      } else {
        await prisma.lineGeometry.create({
          data: {
            routeId,
            lineType: "bus",
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        created++;
        console.log(`Ligne de bus ${lineNumber} (ID: ${routeId}) créée`);
      }
    } catch (error) {
      console.error(
        `Erreur lors du traitement de la ligne de bus #${processed}:`,
        error
      );
      skipped++;
    }
  }

  return { processed, created, updated, skipped };
}

// Fonction pour traiter les données du projet réseau
async function processProjetLines(
  projetData: any,
  routeMapping: Map<string, string>
) {
  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  if (!projetData.features || !Array.isArray(projetData.features)) {
    console.warn("Données de projet réseau invalides ou vides");
    return { processed, created, updated, skipped };
  }

  console.log(
    `Traitement de ${projetData.features.length} lignes du projet réseau...`
  );

  for (const feature of projetData.features) {
    processed++;

    try {
      // Déterminer le type de ligne (bus ou tram)
      let lineType = "bus";
      if (
        feature.properties.mode &&
        feature.properties.mode.toLowerCase().includes("tram")
      ) {
        lineType = "tram";
      }

      // Utiliser la fonction améliorée d'extraction
      const lineNumber = extractLineNumber(feature.properties, lineType);

      if (!lineNumber) {
        console.warn(
          `Impossible d'identifier le numéro de ligne pour une entrée projet: ${JSON.stringify(
            feature.properties
          )}`
        );
        skipped++;
        continue;
      }

      const routeId = routeMapping.get(lineNumber);

      if (!routeId) {
        console.warn(
          `Aucune route correspondante trouvée pour la ligne ${lineNumber} du projet`
        );
        skipped++;
        continue;
      }

      const existing = await prisma.lineGeometry.findFirst({
        where: {
          routeId,
          lineType: "projet",
        },
      });

      if (existing) {
        await prisma.lineGeometry.update({
          where: { id: existing.id },
          data: {
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        updated++;
        console.log(`Ligne projet ${lineNumber} (ID: ${routeId}) mise à jour`);
      } else {
        await prisma.lineGeometry.create({
          data: {
            routeId,
            lineType: "projet",
            geometry: feature.geometry,
            properties: feature.properties,
            lastUpdated: new Date(),
          },
        });
        created++;
        console.log(`Ligne projet ${lineNumber} (ID: ${routeId}) créée`);
      }
    } catch (error) {
      console.error(
        `Erreur lors du traitement de la ligne de projet #${processed}:`,
        error
      );
      skipped++;
    }
  }

  return { processed, created, updated, skipped };
}
