import Link from "next/link";
import { MatchSource, getPlayerMatchDetail } from "@/lib/players/match-detail";

export const dynamic = "force-dynamic";

const PANEL_CLASSES = "rounded-2xl border border-slate-300 bg-white p-4 shadow-sm";
const GHOST_LINK_CLASSES =
  "inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 no-underline hover:bg-slate-100";
const METRIC_GRID_CLASSES = "grid gap-4 md:grid-cols-2 xl:grid-cols-4";
const METRIC_CARD_CLASSES = "grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4";

interface MatchDetailPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(value) && value.length > 0) {
    return firstParam(value[0]);
  }

  return null;
}

function isMatchSource(value: string | null): value is MatchSource {
  return value === "ttbl" || value === "wtt";
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function PlayerSlugLink({
  name,
  slug,
}: {
  name: string | null;
  slug: string | null;
}) {
  if (!name) {
    return <>-</>;
  }

  if (!slug) {
    return <>{name}</>;
  }

  return (
    <Link
      className="text-teal-700 underline decoration-teal-300 underline-offset-2 hover:text-teal-900"
      href={`/players/${slug}`}
    >
      {name}
    </Link>
  );
}

export default async function MatchDetailPage({ searchParams }: MatchDetailPageProps) {
  const params = await searchParams;
  const sourceParam = firstParam(params.source);
  const matchId = firstParam(params.matchId);
  const source = isMatchSource(sourceParam) ? sourceParam : null;

  return (
    <main className="mx-auto my-8 grid w-[min(1200px,calc(100%-2rem))] gap-4">
      <section className={`${PANEL_CLASSES} flex flex-col gap-4 md:flex-row md:items-start md:justify-between`}>
        <div className="grid gap-2">
          <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
            Player Match Detail
          </p>
          <h1 className="m-0 text-4xl font-semibold leading-tight text-slate-900">Match Lookup</h1>
          <p className="m-0 max-w-3xl text-sm text-slate-600">
            Inspect match scorelines, opponents, and raw match payloads.
          </p>
        </div>
        <div className="flex gap-2">
          <Link className={GHOST_LINK_CLASSES} href="/players">
            Back To Players
          </Link>
          <Link className={GHOST_LINK_CLASSES} href="/">
            Back To Control Deck
          </Link>
        </div>
      </section>

      {!source || !matchId ? (
        <section className={PANEL_CLASSES}>
          <h2 className="m-0 text-xl font-semibold text-slate-900">Invalid match reference</h2>
          <p className="m-0 text-sm text-slate-600">
            Provide <code>source</code> (<code>ttbl</code> or <code>wtt</code>) and{" "}
            <code>matchId</code> in the query string.
          </p>
        </section>
      ) : (
        <MatchDetailBody source={source} matchId={matchId} />
      )}
    </main>
  );
}

async function MatchDetailBody({ source, matchId }: { source: MatchSource; matchId: string }) {
  const detail = await getPlayerMatchDetail(source, matchId);

  if (!detail.found) {
    return (
      <section className={PANEL_CLASSES}>
        <h2 className="m-0 text-xl font-semibold text-slate-900">Match not found</h2>
        <p className="m-0 text-sm text-slate-600">
          Could not find <code>{detail.source.toUpperCase()}</code> match{" "}
          <code>{detail.requestedMatchId}</code> in local scraped data.
        </p>
      </section>
    );
  }

  if (detail.source === "ttbl") {
    return (
      <>
        <section className={METRIC_GRID_CLASSES}>
          <article className={METRIC_CARD_CLASSES}>
            <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">Source</span>
            <strong className="text-2xl leading-tight text-slate-900">TTBL</strong>
            <small className="text-sm text-slate-600">{detail.season ?? "-"}</small>
          </article>
          <article className={METRIC_CARD_CLASSES}>
            <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">Match</span>
            <strong className="text-lg leading-tight text-slate-900">
              {detail.homeTeamName ?? "Home"} vs {detail.awayTeamName ?? "Away"}
            </strong>
            <small className="text-sm text-slate-600">
              {detail.homeTeamGames ?? "-"}:{detail.awayTeamGames ?? "-"} games
            </small>
          </article>
          <article className={METRIC_CARD_CLASSES}>
            <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
              Selected Game
            </span>
            <strong className="text-2xl leading-tight text-slate-900">{detail.selectedGameIndex ?? "-"}</strong>
            <small className="text-sm text-slate-600">
              <PlayerSlugLink
                name={detail.selectedGameHomePlayer}
                slug={detail.selectedGameHomePlayerSlug}
              />{" "}
              vs{" "}
              <PlayerSlugLink
                name={detail.selectedGameAwayPlayer}
                slug={detail.selectedGameAwayPlayerSlug}
              />
            </small>
          </article>
          <article className={METRIC_CARD_CLASSES}>
            <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">When</span>
            <strong className="text-lg leading-tight text-slate-900">{formatDate(detail.occurredAt)}</strong>
            <small className="text-sm text-slate-600">{detail.gameday ?? "-"}</small>
          </article>
        </section>

        <section className={PANEL_CLASSES}>
          <h2 className="m-0 text-xl font-semibold text-slate-900">Match Summary</h2>
          <div className="mt-2 grid gap-1.5 text-sm text-slate-700">
            <div>
              <strong>Match ID:</strong> <code>{detail.matchId}</code>
              {detail.gameIndex !== null ? (
                <>
                  {" "}
                  / <strong>Game Index:</strong> <code>{detail.gameIndex}</code>
                </>
              ) : null}
            </div>
            <div>
              <strong>State:</strong> {detail.matchState ?? "-"} | <strong>Venue:</strong>{" "}
              {detail.venue ?? "-"}
            </div>
            <div>
              <strong>Team score:</strong> {detail.homeTeamGames ?? "-"}:{detail.awayTeamGames ?? "-"}{" "}
              games | <strong>Set score:</strong> {detail.homeTeamSets ?? "-"}:
              {detail.awayTeamSets ?? "-"}
            </div>
            <div>
              <strong>Selected game state:</strong> {detail.selectedGameState ?? "-"} |{" "}
              <strong>Winner side:</strong> {detail.selectedGameWinnerSide ?? "-"}
            </div>
            <div>
              <strong>Selected game sets:</strong> {detail.selectedGameHomeSets ?? "-"}:
              {detail.selectedGameAwaySets ?? "-"}
            </div>
          </div>
        </section>

        <section className={PANEL_CLASSES}>
          <h2 className="m-0 text-xl font-semibold text-slate-900">Selected Game Set Scores</h2>
          {detail.selectedGameSetScores.length === 0 ? (
            <p className="mt-2 mb-0 text-sm text-slate-600">No set-level scores found for this game.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th>Set</th>
                    <th>
                      <PlayerSlugLink
                        name={detail.selectedGameHomePlayer}
                        slug={detail.selectedGameHomePlayerSlug}
                      />
                    </th>
                    <th>
                      <PlayerSlugLink
                        name={detail.selectedGameAwayPlayer}
                        slug={detail.selectedGameAwayPlayerSlug}
                      />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.selectedGameSetScores.map((row) => (
                    <tr key={row.setNumber}>
                      <td>{row.setNumber}</td>
                      <td>{row.homeScore ?? "-"}</td>
                      <td>{row.awayScore ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={PANEL_CLASSES}>
          <h2 className="m-0 text-xl font-semibold text-slate-900">All Match Data</h2>
          <details>
            <summary className="mt-2 cursor-pointer text-sm font-semibold text-slate-800">
              Raw Match Payload
            </summary>
            <pre className="mt-2 max-h-[28rem] overflow-auto rounded-[10px] border border-slate-300 bg-slate-100 p-3 font-mono text-xs leading-[1.4] whitespace-pre">
              {stringify(detail.match)}
            </pre>
          </details>
          <details>
            <summary className="mt-2 cursor-pointer text-sm font-semibold text-slate-800">
              Raw Match Summary Row
            </summary>
            <pre className="mt-2 max-h-[28rem] overflow-auto rounded-[10px] border border-slate-300 bg-slate-100 p-3 font-mono text-xs leading-[1.4] whitespace-pre">
              {stringify(detail.summary)}
            </pre>
          </details>
          <details>
            <summary className="mt-2 cursor-pointer text-sm font-semibold text-slate-800">
              Raw Selected Game Payload
            </summary>
            <pre className="mt-2 max-h-[28rem] overflow-auto rounded-[10px] border border-slate-300 bg-slate-100 p-3 font-mono text-xs leading-[1.4] whitespace-pre">
              {stringify(detail.selectedGame)}
            </pre>
          </details>
          <details>
            <summary className="mt-2 cursor-pointer text-sm font-semibold text-slate-800">
              Raw Game Stats Row
            </summary>
            <pre className="mt-2 max-h-[28rem] overflow-auto rounded-[10px] border border-slate-300 bg-slate-100 p-3 font-mono text-xs leading-[1.4] whitespace-pre">
              {stringify(detail.gameStats)}
            </pre>
          </details>
        </section>
      </>
    );
  }

  return (
    <>
      <section className={METRIC_GRID_CLASSES}>
        <article className={METRIC_CARD_CLASSES}>
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">Source</span>
          <strong className="text-2xl leading-tight text-slate-900">WTT</strong>
          <small className="text-sm text-slate-600">{detail.year ?? "-"}</small>
        </article>
        <article className={METRIC_CARD_CLASSES}>
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">Match</span>
          <strong className="text-lg leading-tight text-slate-900">
            <PlayerSlugLink name={detail.playerAName} slug={detail.playerASlug} /> vs{" "}
            <PlayerSlugLink name={detail.playerXName} slug={detail.playerXSlug} />
          </strong>
          <small className="text-sm text-slate-600">
            Sets {detail.finalSetsA ?? "-"}:{detail.finalSetsX ?? "-"}
          </small>
        </article>
        <article className={METRIC_CARD_CLASSES}>
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">Event</span>
          <strong className="text-lg leading-tight text-slate-900">
            {detail.event ?? detail.tournament ?? "-"}
          </strong>
          <small className="text-sm text-slate-600">
            {detail.stage ?? "-"} / {detail.round ?? "-"}
          </small>
        </article>
        <article className={METRIC_CARD_CLASSES}>
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">When</span>
          <strong className="text-lg leading-tight text-slate-900">{formatDate(detail.occurredAt)}</strong>
          <small className="text-sm text-slate-600">{detail.walkover ? "Walkover" : "Played"}</small>
        </article>
      </section>

      <section className={PANEL_CLASSES}>
        <h2 className="m-0 text-xl font-semibold text-slate-900">Match Summary</h2>
        <div className="mt-2 grid gap-1.5 text-sm text-slate-700">
          <div>
            <strong>Match ID:</strong> <code>{detail.matchId}</code>
          </div>
          <div>
            <strong>Winner side:</strong> {detail.winnerInferred ?? "-"}
          </div>
          <div>
            <strong>Player A:</strong>{" "}
            <PlayerSlugLink name={detail.playerAName} slug={detail.playerASlug} /> (
            {detail.playerAAssociation ?? "-"})
          </div>
          <div>
            <strong>Player X:</strong>{" "}
            <PlayerSlugLink name={detail.playerXName} slug={detail.playerXSlug} /> (
            {detail.playerXAssociation ?? "-"})
          </div>
          <div>
            <strong>Tournament:</strong> {detail.tournament ?? "-"} | <strong>Event:</strong>{" "}
            {detail.event ?? "-"}
          </div>
        </div>
      </section>

      <section className={PANEL_CLASSES}>
        <h2 className="m-0 text-xl font-semibold text-slate-900">Game Scores</h2>
        {detail.games.length === 0 ? (
          <p className="mt-2 mb-0 text-sm text-slate-600">No per-game rows available.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>
                    <PlayerSlugLink name={detail.playerAName} slug={detail.playerASlug} />
                  </th>
                  <th>
                    <PlayerSlugLink name={detail.playerXName} slug={detail.playerXSlug} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.games.map((row) => (
                  <tr key={row.gameNumber}>
                    <td>{row.gameNumber}</td>
                    <td>{row.aPoints}</td>
                    <td>{row.xPoints}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={PANEL_CLASSES}>
        <h2 className="m-0 text-xl font-semibold text-slate-900">All Match Data</h2>
        <details>
          <summary className="mt-2 cursor-pointer text-sm font-semibold text-slate-800">
            Raw Match Payload
          </summary>
          <pre className="mt-2 max-h-[28rem] overflow-auto rounded-[10px] border border-slate-300 bg-slate-100 p-3 font-mono text-xs leading-[1.4] whitespace-pre">
            {stringify(detail.match)}
          </pre>
        </details>
      </section>
    </>
  );
}
