import { prisma } from "@/lib/prisma";
import { unstable_cache } from "next/cache";
import Link from "next/link";
import Image from "next/image";

const getRoutesLineNumbers = unstable_cache(
  async () => {
    const routes = await prisma.route.findMany({
      select: {
        id: true,
      },
    });

    routes
      .filter((route) => route.id.startsWith("7-"))
      .map((route) => Number(route.id.split("-")[1]))
      .sort((a, b) => {
        return a - b;
      });

    return routes
      .filter((route) => route.id.startsWith("7-"))
      .map((route) => Number(route.id.split("-")[1]))
      .sort((a, b) => a - b);
  },
  ["routes-line-numbers"],
  { revalidate: 86400, tags: ["routes-line-numbers"] }
);

export default async function Home() {
  const routesLineNumbers = await getRoutesLineNumbers();
  const apiBaseUrl = "https://x-notif-tam.vercel.app/api/alerts";

  return (
    <main>
      <div className="container">
        {" "}
        <div className="scroll-container">
          <header className="header">
            <h1 className="title">
              API d'alertes des transports de Montpellier
            </h1>
            <p className="subtitle">
              Documentation complète pour accéder aux données d'alertes du
              réseau de transport en commun
            </p>
            <div
              className="button-group"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "1rem",
              }}
            >
              <Link
                href="https://github.com/sthiefaine/x-notif-tam"
                className="button"
                style={{ backgroundColor: "#24292e", color: "white", zIndex: 20 }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <svg
                    height="16"
                    width="16"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
                  </svg>
                  GitHub
                </span>
              </Link>
            </div>
          </header>

          <div className="scrolling-banner-container">
            <div className="scrolling-banner">
              <Image
                src="/tram2-tam.png"
                alt="Transports Montpellier L2 tramway"
                priority
                width={200}
                height={120}
              />
              <div style={{ width: "100vw" }}></div>
              <Image
                src="/tram2-tam.png"
                alt="Transports Montpellier L2 tramway"
                width={200}
                height={120}
              />
              <div style={{ width: "100vw" }}></div>
              <Image
                src="/tram2-tam.png"
                alt="Transports Montpellier L2 tramway"
                width={200}
                height={120}
              />
            </div>
          </div>

          <section className="section">
            <h2 className="section-title">Présentation de l'API</h2>
            <p className="paragraph">
              Cette API REST permet d'accéder aux informations sur les
              perturbations, travaux et autres événements affectant le réseau de
              transport en commun de Montpellier. Elle est conçue pour être
              facilement intégrable dans vos applications.
            </p>
            <div className="info-box">
              <p className="info-text">
                L'API est limitée à <strong>10 requêtes par minute</strong> par
                adresse IP.
              </p>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Endpoint principal</h2>
            <div className="code-block">
              <a
                href={apiBaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "inherit",
                  textDecoration: "none",
                  display: "block",
                }}
              >
                GET /api/alerts
              </a>
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <h3 className="subheading" style={{ marginTop: 0 }}>
                Récupérer les alertes actives
              </h3>
              <div className="code-block">
                <a
                  href={`${apiBaseUrl}?active=true`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "inherit",
                    textDecoration: "none",
                    display: "block",
                  }}
                >
                  GET /api/alerts?active=true
                </a>
              </div>
            </div>

            <h3 className="subheading">Paramètres de requête</h3>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Paramètre</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="key">active</td>
                    <td>boolean</td>
                    <td>
                      Si <code>true</code>, retourne les alertes actuellement
                      actives
                    </td>
                  </tr>
                  <tr>
                    <td className="key">completed</td>
                    <td>boolean</td>
                    <td>
                      Si <code>true</code>, retourne les alertes terminées
                    </td>
                  </tr>
                  <tr>
                    <td className="key">upcoming</td>
                    <td>boolean</td>
                    <td>
                      Si <code>true</code>, retourne les alertes à venir
                    </td>
                  </tr>
                  <tr>
                    <td className="key">route</td>
                    <td>string</td>
                    <td>
                      Filtre par identifiant de ligne:{" "}
                      {routesLineNumbers.join(", ")}
                    </td>
                  </tr>
                  <tr>
                    <td className="key">stop</td>
                    <td>string</td>
                    <td>Filtre par identifiant d'arrêt</td>
                  </tr>
                  <tr>
                    <td className="key">timeFrame</td>
                    <td>string</td>
                    <td>Période: 'today', 'week', 'month'</td>
                  </tr>
                  <tr>
                    <td className="key">page</td>
                    <td>number</td>
                    <td>Numéro de page (défaut: 1)</td>
                  </tr>
                  <tr>
                    <td className="key">pageSize</td>
                    <td>number</td>
                    <td>Nombre d'éléments par page (défaut: 20)</td>
                  </tr>
                  <tr>
                    <td className="key">sortBy</td>
                    <td>string</td>
                    <td>Champ de tri (défaut: 'timeStart')</td>
                  </tr>
                  <tr>
                    <td className="key">sortOrder</td>
                    <td>string</td>
                    <td>Ordre de tri: 'asc' ou 'desc' (défaut: 'desc')</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Exemples d'utilisation</h2>

            <div style={{ marginBottom: "1.5rem" }}>
              <h3 className="subheading">
                Récupérer les alertes à venir pour une ligne spécifique
              </h3>
              <div className="code-block">
                <a
                  href={`${apiBaseUrl}?upcoming=true&route=T1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "inherit",
                    textDecoration: "none",
                    display: "block",
                  }}
                >
                  GET /api/alerts?upcoming=true&route=1
                </a>
              </div>
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <h3 className="subheading">
                Récupérer les alertes d'aujourd'hui
              </h3>
              <div className="code-block">
                <a
                  href={`${apiBaseUrl}?timeFrame=today`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "inherit",
                    textDecoration: "none",
                    display: "block",
                  }}
                >
                  GET /api/alerts?timeFrame=today
                </a>
              </div>
            </div>

            <div>
              <h3 className="subheading">Paginer les résultats</h3>
              <div className="code-block">
                <a
                  href={`${apiBaseUrl}?page=2&pageSize=10`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "inherit",
                    textDecoration: "none",
                    display: "block",
                  }}
                >
                  GET /api/alerts?page=2&pageSize=10
                </a>
              </div>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Structure de la réponse</h2>
            <p className="paragraph">
              L'API retourne les données au format JSON avec la structure
              suivante:
            </p>
            <div className="code-block">
              {`{
  "data": [
    {
      "id": "1234",
      "timeStart": "2025-03-15T08:00:00Z",
      "timeEnd": "2025-03-15T17:00:00Z",
      "cause": "MAINTENANCE",
      "effect": "DETOUR",
      "headerText": "Travaux sur la ligne T1",
      "descriptionText": "En raison de travaux de maintenance...",
      "url": "https://example.com/alerts/1234",
      "routeIds": "7-1",
      "stopIds": "1234,5678",
      "isComplement": false,
      "parentAlertId": null,
      "routeDetails": [
        {
          "routeId": "7-1",
          "routeNumber": "1",
          "lineType": "main",
          "shortName": "1",
          "longName": "Tram Line 1",
          "type": 0,
          "color": "#FF0000",
          "textColor": "#FFFFFF"
        }
      ],
      "complements": [...]
    }
  ],
  "pagination": {
    "totalItems": 100,
    "totalPages": 5,
    "currentPage": 1,
    "pageSize": 20,
    "hasNextPage": true,
    "hasPrevPage": false
  }
}`}
            </div>

            <h3 className="subheading">Codes de statut</h3>
            <ul className="list">
              <li>
                <strong>200</strong> - Succès
              </li>
              <li>
                <strong>429</strong> - Limite de taux dépassée
              </li>
              <li>
                <strong>500</strong> - Erreur serveur
              </li>
            </ul>
          </section>

          <section className="section">
            <h2 className="section-title">Types énumérés</h2>

            <h3 className="subheading">Causes d'alertes</h3>
            <div className="code-block">
              {`enum AlertCause {
  UNKNOWN_CAUSE = "UNKNOWN_CAUSE",
  OTHER_CAUSE = "OTHER_CAUSE",
  TECHNICAL_PROBLEM = "TECHNICAL_PROBLEM",
  STRIKE = "STRIKE",
  DEMONSTRATION = "DEMONSTRATION",
  ACCIDENT = "ACCIDENT",
  HOLIDAY = "HOLIDAY",
  WEATHER = "WEATHER",
  MAINTENANCE = "MAINTENANCE",
  CONSTRUCTION = "CONSTRUCTION",
  POLICE_ACTIVITY = "POLICE_ACTIVITY",
  MEDICAL_EMERGENCY = "MEDICAL_EMERGENCY",
  TRAFFIC_JAM = "TRAFFIC_JAM"
}`}
            </div>

            <h3 className="subheading">Effets d'alertes</h3>
            <div className="code-block">
              {`enum AlertEffect {
  NO_SERVICE = "NO_SERVICE",
  REDUCED_SERVICE = "REDUCED_SERVICE",
  SIGNIFICANT_DELAYS = "SIGNIFICANT_DELAYS",
  DETOUR = "DETOUR",
  ADDITIONAL_SERVICE = "ADDITIONAL_SERVICE",
  MODIFIED_SERVICE = "MODIFIED_SERVICE",
  OTHER_EFFECT = "OTHER_EFFECT",
  UNKNOWN_EFFECT = "UNKNOWN_EFFECT",
  STOP_MOVED = "STOP_MOVED",
  NO_EFFECT = "NO_EFFECT",
  ACCESSIBILITY_ISSUE = "ACCESSIBILITY_ISSUE"
}`}
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">
              Utilisation automatisée des alertes
            </h2>
            <p className="paragraph">
              Ces alertes sont automatiquement publiées sur Twitter/X via un
              système d'automatisation utilisant Puppeteer et des cron jobs
              Vercel. Pour plus d'informations sur ce système, consultez la
              documentation technique du projet.
            </p>
            <div>
              <a
                href="https://twitter.com/AlertsTam50044"
                target="_blank"
                className="button"
                style={{
                  backgroundColor: "rgba(59, 130, 246, 0.2)",
                  border: "1px solid rgba(59, 130, 246, 0.3)",
                  padding: "0.5rem 1rem",
                  fontSize: "0.875rem",
                }}
              >
                Voir les alertes sur Twitter
              </a>
            </div>
          </section>

          <section className="section">
            <h2 className="section-title">Source des données et licence</h2>
            <p className="paragraph">
              Les données fournies par cette API proviennent de{" "}
              <a
                href="https://data.montpellier3m.fr/dataset/offre-de-transport-tam-en-temps-reel"
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "underline" }}
              >
                Montpellier Méditerranée Métropole
              </a>{" "}
              via le jeu de données "Offre de transport TAM en temps réel".
            </p>

            <p className="paragraph">
              Cette API est distribuée sous licence{" "}
              <a
                href="https://opendatacommons.org/licenses/odbl/summary/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "underline" }}
              >
                ODbL (Open Database License)
              </a>
              .
            </p>

            <div className="info-box" style={{ marginTop: "1rem" }}>
              <h3 className="subheading" style={{ marginTop: 0 }}>
                Transformation et enrichissement des données
              </h3>
              <p className="info-text">
                Cette API effectue plusieurs transformations sur les données
                d'origine tout en respectant la licence ODbL :
              </p>
              <ul className="list" style={{ marginTop: "0.5rem" }}>
                <li>
                  <strong>Conversion de format</strong> : Les données originales
                  au format Protocol Buffers (.pb) sont converties en JSON pour
                  une meilleure accessibilité et compatibilité web.
                </li>
                <li>
                  <strong>Enrichissement des données</strong> : Notre API
                  enrichit les données brutes en ajoutant des informations
                  complémentaires et des métadonnées pour faciliter la
                  navigation.
                </li>
                <li>
                  <strong>Structuration optimisée</strong> : La structure de
                  l'API est conçue pour faciliter l'intégration dans des
                  applications clientes.
                </li>
              </ul>
              <p className="info-text" style={{ marginTop: "0.5rem" }}>
                Ces transformations préservent la nature des informations, leur
                granularité, leurs conditions temporelles et leur emprise
                géographique, conformément à l'article 4.4 de la licence ODbL.
              </p>
            </div>
          </section>

          <footer className="footer">
            <p>© 2025 API d'alertes de transport Montpellier</p>
            <p style={{ marginTop: "0.25rem" }}>
              <Link
                href="https://montpellier-transport-alerts.vercel.app/"
                className="footer-link"
              >
                Retour au site principal
              </Link>
            </p>
            <p
              style={{
                marginTop: "0.25rem",
                fontSize: "0.75rem",
                color: "#666",
              }}
            >
              Données issues de Montpellier Méditerranée Métropole - Licence
              ODbL
            </p>
          </footer>
        </div>
      </div>
    </main>
  );
}
