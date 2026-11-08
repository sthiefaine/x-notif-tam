import TransitStatistics from "../components/transit-statistics";

export const metadata = { title: "Le réseau en chiffres · TaM en direct", description: "Les alertes du réseau de Montpellier, résumées par semaine avec leur couverture d’observation." };

export default function StatisticsPage() {
  return <TransitStatistics />;
}
