// api/games.js
// Proxies BallDontLie — API key stays server-side.
// For playoff games, derives Game N, series record, and round from the series history.

const bdlFetch = (path) =>
  fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: process.env.BALLDONTLIE_API_KEY },
  });

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

    const series = (data.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const gameNumber = series.findIndex(g => g.id === id);
    if (gameNumber === -1) return {};

    let homeWins = 0, visitorWins = 0;
    for (let i = 0; i < gameNumber; i++) {
      const g = series[i];
      if (g.status !== 'Final' && g.status !== 'Final/OT') continue;
      if (g.home_team_score > g.visitor_team_score) {
        if (g.home_team.id === home_team.id) homeWins++;
        else visitorWins++;
      } else {
        if (g.visitor_team.id === visitor_team.id) visitorWins++;
        else homeWins++;
      }
    }

    const rawRound    = game.round ?? series[0]?.round ?? null;
    const roundNumber = rawRound
      ? parseInt(rawRound, 10)
      : deriveRoundFromSeason(season, series[0]?.date);

    return {
      playoff_game_number:  gameNumber + 1,
      playoff_round_number: roundNumber,
      playoff_round_name:   ROUND_NAMES[roundNumber] || `Round ${roundNumber}`,
      series_home_wins:     homeWins,
      series_visitor_wins:  visitorWins,
      series_games_played:  gameNumber,
    };
  } catch (err) {
    console.error('series info error:', err);
    return {};
  }
}

function deriveRoundFromSeason(season, firstGameDate) {
  if (!firstGameDate) return null;
  const month = new Date(firstGameDate).getMonth() + 1;
  if (month <= 4) return 1;
  if (month === 5) return 2;
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
    const start    = new Date(start_date);
    const end      = new Date(end_date);
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
