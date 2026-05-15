// api/games.js
// Proxies BallDontLie — API key stays server-side.
// For playoff games, derives the correct "Game N" number by fetching the full series.

const bdlFetch = (path) =>
  fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: process.env.BALLDONTLIE_API_KEY },
  });

// Derive playoff game number by sorting all games in the same series by date.
async function getPlayoffGameNumber(game) {
  try {
    const { season, home_team, visitor_team, id } = game;
    const url =
      `/games?seasons[]=${season}&team_ids[]=${home_team.id}&team_ids[]=${visitor_team.id}&postseason=true&per_page=100`;

    const res = await bdlFetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const series = (data.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const idx = series.findIndex(g => g.id === id);
    return idx >= 0 ? idx + 1 : null;
  } catch {
    return null;
  }
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
    const end = new Date(end_date);
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) return res.status(400).json({ error: 'end_date must be after start_date' });
    if (diffDays > 30) return res.status(400).json({ error: 'Date range cannot exceed 30 days' });
    params.append('start_date', start_date);
    params.append('end_date', end_date);
  }

  try {
    const bdlRes = await bdlFetch(`/games?${params.toString()}`);
    const data = await bdlRes.json();

    if (!bdlRes.ok) {
      return res.status(bdlRes.status).json({ error: data.error || 'BallDontLie error' });
    }

    // For playoff games, attach the derived game number in parallel
    const games = data.data || [];
    await Promise.all(
      games
        .filter(g => g.postseason)
        .map(async g => {
          g.playoff_game_number = await getPlayoffGameNumber(g);
        })
    );

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
