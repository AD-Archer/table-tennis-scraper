import { Dashboard } from "@/components/dashboard";
import { getDashboardOverview } from "@/lib/overview";

export const dynamic = "force-dynamic";

export default async function Home() {
  const overview = await getDashboardOverview();

  return <Dashboard initialOverview={overview} />;
}
