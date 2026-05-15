// api/games.js
// Proxies BallDontLie — API key stays server-side.
// For playoff games, derives Game N, series record, and round from the series history.

const bdlFetch = (path) =>
  fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: process.env.BALLDONTLIE_API_KEY },
  });

// Playoff round names by number of remaining teams (BDL doesn't expose round directly,
// so we infer from how many total games are in the series at that point in the season).
// Instead we derive round from game_ids relative order within the postseason — but
// BDL DOES return a `round` field on playoff games in some seasons. We try that first,
// then fall back to inferring from series count.
const ROUND_NAMES = {
  1: 'First Round',
  2: 'Conference Semifinals',
  3: 'Conference Finals',
  4: 'NBA Finals',
};

async function getPlayoffSeriesInfo(game) {
  try {
    const { season, home_team, visitor_team, id } = game;
    const url =
      `/games?seasons[]=${season}&team_ids[]=${home_team.id}&team_ids[]=${visitor_team.id}&postseason=true&per_page=100`;

    const res = await bdlFetch(url);
    if (!res.ok) return {};

    const data = await res.json();

    // Filter to only games between these exact two teams
    const series = (data.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const gameNumber = series.findIndex(g => g.id === id);
    if (gameNumber === -1) return {};

    // Series record: count wins up to (not including) this game
    let homeWins = 0, visitorWins = 0;
    for (let i = 0; i < gameNumber; i++) {
      const g = series[i];
      const isFinal = g.status === 'Final' || g.status === 'Final/OT';
      if (!isFinal) continue;
      if (g.home_team_score > g.visitor_team_score) {
        // home team of THAT game won
        if (g.home_team.id === home_team.id) homeWins++;
        else visitorWins++;
      } else {
        if (g.visitor_team.id === visitor_team.id) visitorWins++;
        else homeWins++;
      }
    }

    // Try to get round from the raw BDL field, otherwise derive from series index
    // BDL returns `round` as an integer (1–4) on some seasons
    const rawRound = game.round ?? series[0]?.round ?? null;
    const roundNumber = rawRound
      ? parseInt(rawRound, 10)
      : deriveRoundFromSeason(season, series[0]?.date);

    return {
      playoff_game_number: gameNumber + 1,
      playoff_round_number: roundNumber,
      playoff_round_name: ROUND_NAMES[roundNumber] || `Round ${roundNumber}`,
      series_home_wins: homeWins,
      series_visitor_wins: visitorWins,
      series_games_played: gameNumber,
    };
  } catch (err) {
    console.error('series info error:', err);
    return {};
  }
}

// Rough round derivation by month: Apr/early May = R1, mid-May = R2, late May/Jun = CF, Jun = Finals
function deriveRoundFromSeason(season, firstGameDate) {
  if (!firstGameDate) return null;
  const month = new Date(firstGameDate).getMonth() + 1; // 1-indexed
  if (month <= 4) return 1;
  if (month === 5) return 2; // imprecise but better than nothing
  return 3;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { date, start_date, end_date } = req.query;

  if (!date && !(start_date && end_date)) {
    return res.status(400).json({ error: 'Provide ?date=YYYY-MM-DD or ?start_date=&end_date=' });
  }

  const params = new URLSearchParams({ per_page: '50' });
  if (date) {
    params.append('dates[]', date);
  } else {
    const start = new Date(start_date);
    const end   = new Date(end_date);
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    if (diffDays < 0)  return res.status(400).json({ error: 'end_date must be after start_date' });
    if (diffDays > 30) return res.status(400).json({ error: 'Date range cannot exceed 30 days' });
    params.append('start_date', start_date);
    params.append('end_date', end_date);
  }

  try {
    const bdlRes = await bdlFetch(`/games?${params.toString()}`);
    const data   = await bdlRes.json();

    if (!bdlRes.ok) {
      return res.status(bdlRes.status).json({ error: data.error || 'BallDontLie error' });
    }

    const games = data.data || [];

    // Enrich playoff games in parallel
    await Promise.all(
      games
        .filter(g => g.postseason)
        .map(async g => {
          const info = await getPlayoffSeriesInfo(g);
          Object.assign(g, info);
        })
    );

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
