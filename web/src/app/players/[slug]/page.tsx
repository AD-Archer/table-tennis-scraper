import Link from "next/link";
import { getPlayerDetailBySlug } from "@/lib/players/detail";

export const dynamic = "force-dynamic";

interface PlayerDetailPageProps {
  params: Promise<{ slug: string }>;
}

function formatNullable(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function formatBirthday(unixSeconds: number | null): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds === null) {
    return "-";
  }

  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toISOString().slice(0, 10);
}

function formatOccurredAt(value: string | null): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().slice(0, 10);
}

export default async function PlayerDetailPage({ params }: PlayerDetailPageProps) {
  const { slug } = await params;
  const detail = await getPlayerDetailBySlug(slug);

  if (!detail) {
    return (
      <main className="mx-auto my-8 grid w-[min(1200px,calc(100%-2rem))] gap-4">
        <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
          <h1 className="m-0 text-3xl font-semibold text-slate-900">Player not found</h1>
          <p className="mt-2 mb-0 text-sm text-slate-600">
            Could not resolve player slug <code>{slug}</code>.
          </p>
          <div className="mt-3 flex gap-2">
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 no-underline hover:bg-slate-100"
              href="/players"
            >
              Back To Players
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const { player, members, allMatches, opponentSlugBySourceId } = detail;

  return (
    <main className="mx-auto my-8 grid w-[min(1200px,calc(100%-2rem))] gap-4">
      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="grid gap-1">
            <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
              Player Profile
            </p>
            <h1 className="m-0 text-4xl font-semibold leading-tight text-slate-900">
              {player.displayName}
            </h1>
            <p className="m-0 text-sm text-slate-600">
              <code>{player.slug}</code> | <code>{player.canonicalKey}</code>
            </p>
            <p className="m-0 text-sm text-slate-600">
              Sources: {player.sources.join(", ")} | Seasons:{" "}
              {player.seasons.length > 0 ? player.seasons.join(", ") : "-"}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 no-underline hover:bg-slate-100"
              href="/players"
            >
              Back To Players
            </Link>
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 no-underline hover:bg-slate-100"
              href="/"
            >
              Back To Control Deck
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Matches
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{player.matchesPlayed}</strong>
          <small className="text-sm text-slate-600">All known TTBL/WTT matches</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Win/Loss
          </span>
          <strong className="text-2xl leading-tight text-slate-900">
            {player.wins} / {player.losses}
          </strong>
          <small className="text-sm text-slate-600">Win rate {formatNullable(player.winRate)}%</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Country
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{player.country ?? "-"}</strong>
          <small className="text-sm text-slate-600">
            Gender {player.gender} | {player.countrySource} | {player.genderSource}
          </small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Source IDs
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{player.sourceIds.length}</strong>
          <small className="text-sm text-slate-600">Canonical member records</small>
        </article>
      </section>

      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <h2 className="m-0 text-xl font-semibold text-slate-900">Source Profiles</h2>
        <div className="mt-3 grid gap-3">
          {members.map((member) => (
            <article
              key={`${member.source}:${member.sourceId}:${member.sourceKey}`}
              className="rounded-xl border border-slate-300 bg-slate-50 p-3"
            >
              <div className="grid gap-1 text-sm text-slate-700">
                <div>
                  <strong>Source:</strong> {member.source.toUpperCase()} | <strong>ID:</strong>{" "}
                  <code>{member.sourceId}</code>
                </div>
                <div>
                  <strong>Names:</strong> {member.names.join(", ")}
                </div>
                <div>
                  <strong>Seasons:</strong>{" "}
                  {member.seasons.length > 0 ? member.seasons.join(", ") : "-"}
                </div>
              </div>

              {member.source === "ttbl" ? (
                member.ttblProfile ? (
                  <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                    <div>
                      <strong>Nationality:</strong> {formatNullable(member.ttblProfile.nationality)}
                    </div>
                    <div>
                      <strong>Birthday:</strong>{" "}
                      {formatBirthday(member.ttblProfile.birthdayUnix)}
                    </div>
                    <div>
                      <strong>Height:</strong> {formatNullable(member.ttblProfile.heightCm)} cm
                    </div>
                    <div>
                      <strong>Weight:</strong> {formatNullable(member.ttblProfile.weightKg)} kg
                    </div>
                    <div>
                      <strong>Hand:</strong> {formatNullable(member.ttblProfile.hand)}
                    </div>
                    <div>
                      <strong>Racket Posture:</strong>{" "}
                      {formatNullable(member.ttblProfile.racketPosture)}
                    </div>
                    <div>
                      <strong>Current Club:</strong>{" "}
                      {formatNullable(member.ttblProfile.currentClub)}
                    </div>
                    <div>
                      <strong>Outfitter:</strong> {formatNullable(member.ttblProfile.outfitter)}
                    </div>
                    <div>
                      <strong>Season Label:</strong>{" "}
                      {formatNullable(member.ttblProfile.seasonLabel)}
                    </div>
                    <div>
                      <strong>Stable Player ID:</strong>{" "}
                      {formatNullable(member.ttblProfile.stablePlayerId)}
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 mb-0 text-sm text-slate-600">
                    TTBL profile fields not yet cached for this source ID.
                  </p>
                )
              ) : member.wttProfile ? (
                <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                  <div>
                    <strong>WTT Full Name:</strong> {formatNullable(member.wttProfile.full_name)}
                  </div>
                  <div>
                    <strong>Nationality:</strong>{" "}
                    {formatNullable(member.wttProfile.nationality)}
                  </div>
                  <div>
                    <strong>Country Name:</strong>{" "}
                    {formatNullable(member.wttProfile.country_name)}
                  </div>
                  <div>
                    <strong>Organization:</strong>{" "}
                    {formatNullable(member.wttProfile.organization_name)}
                  </div>
                  <div>
                    <strong>DOB:</strong> {formatNullable(member.wttProfile.dob)}
                  </div>
                  <div>
                    <strong>Age:</strong> {formatNullable(member.wttProfile.age)}
                  </div>
                  <div>
                    <strong>Gender:</strong> {formatNullable(member.wttProfile.gender)}
                  </div>
                  <div>
                    <strong>Style:</strong> {formatNullable(member.wttProfile.style)}
                  </div>
                  <div>
                    <strong>Handedness:</strong>{" "}
                    {formatNullable(member.wttProfile.handedness)}
                  </div>
                  <div>
                    <strong>World Ranking:</strong>{" "}
                    {formatNullable(member.wttProfile.world_ranking)}
                  </div>
                  <div>
                    <strong>Ranking Points:</strong>{" "}
                    {formatNullable(member.wttProfile.world_ranking_points)}
                  </div>
                  <div>
                    <strong>Team/Org:</strong> {formatNullable(member.wttProfile.team)}
                  </div>
                  <div>
                    <strong>Matches:</strong> {member.wttProfile.stats.matches_played}
                  </div>
                  <div>
                    <strong>Wins/Losses:</strong> {member.wttProfile.stats.wins}/
                    {member.wttProfile.stats.losses}
                  </div>
                </div>
              ) : (
                <p className="mt-3 mb-0 text-sm text-slate-600">
                  WTT profile fields not found for this source ID.
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <h2 className="m-0 text-xl font-semibold text-slate-900">All Matches</h2>
        {allMatches.length === 0 ? (
          <p className="mt-3 mb-0 text-sm text-slate-600">No matches found.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Match ID</th>
                  <th>Date</th>
                  <th>Outcome</th>
                  <th>Score</th>
                  <th>Opponent</th>
                  <th>Season/Year</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {allMatches.map((match) => {
                  const opponentKey = match.opponentSourceId
                    ? `${match.source}:${match.opponentSourceId}`
                    : null;
                  const opponentSlug =
                    opponentKey ? opponentSlugBySourceId[opponentKey] ?? null : null;
                  const opponentLabel = match.opponent ?? opponentSlug ?? "-";

                  return (
                    <tr key={`${match.source}:${match.matchId}`}>
                      <td>{match.source.toUpperCase()}</td>
                      <td>
                        <Link
                          className="font-semibold text-teal-700 no-underline hover:underline"
                          href={{
                            pathname: "/players/match",
                            query: {
                              source: match.source,
                              matchId: match.matchId,
                            },
                          }}
                        >
                          {match.matchId}
                        </Link>
                      </td>
                      <td>{formatOccurredAt(match.occurredAt)}</td>
                      <td>{match.outcome ?? "-"}</td>
                      <td>{match.score ?? "-"}</td>
                      <td>
                        {opponentSlug ? (
                          <Link
                            className="font-semibold text-teal-700 no-underline hover:underline"
                            href={`/players/${encodeURIComponent(opponentSlug)}`}
                          >
                            {opponentLabel}
                          </Link>
                        ) : (
                          opponentLabel
                        )}
                      </td>
                      <td>{match.seasonOrYear ?? "-"}</td>
                      <td>{match.event ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
