import TransitStatistics from "../components/transit-statistics";

export const metadata = { title: "Le réseau en chiffres", description: "Fréquences prévues et observées des trams et bus de Montpellier : moyenne, médiane par ligne et bilans des alertes." };

export default function StatisticsPage() {
  return <TransitStatistics />;
}
