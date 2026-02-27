import { PlayerSlugBrowser } from "@/components/player-slug-browser";
import { getPlayerSlugOverview } from "@/lib/players/slugs";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  const overview = await getPlayerSlugOverview();

  return <PlayerSlugBrowser initialOverview={overview} />;
}
