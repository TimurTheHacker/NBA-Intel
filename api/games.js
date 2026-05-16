// api/games.js
// Proxies BallDontLie — API key stays server-side.

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

// Derive playoff round from the calendar date of Game 1 of the series.
// This is more reliable than BDL's round field which is often null.
function deriveRound(game1Date) {
  if (!game1Date) return null;
  const d = new Date(game1Date);
  const month = d.getMonth() + 1; // 1-indexed
  const day   = d.getDate();
  // First Round: mid-April to mid-May
  if (month === 4) return 1;
  if (month === 5 && day <= 20) return 2;
  if (month === 5 && day > 20)  return 3;
  if (month === 6) return 4; // NBA Finals
  return 1; // safe fallback
}

async function getPlayoffSeriesInfo(game) {
  try {
    const { season, home_team, visitor_team, id, date: gameDate } = game;

    // Query postseason=true only — never mix in regular season games.
    // Use a broad date window: start of playoffs (Apr 1) to end of season (Jul 31).
    const params = new URLSearchParams({ per_page: '100' });
    params.append('seasons[]', season);
    params.append('team_ids[]', home_team.id);
    params.append('team_ids[]', visitor_team.id);
    params.append('postseason', 'true');

    const res = await bdlFetch(`/games?${params.toString()}`);
    if (!res.ok) return {};

    const raw = await res.json();

    // Keep only games between exactly these two teams
    const series = (raw.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Find this game's 0-based index by ID
    let idx = series.findIndex(g => g.id === id);

    if (idx === -1) {
      // BDL hasn't set postseason=true on this game yet.
      // Count series games with a date strictly before today's game date.
      const thisDate = new Date(gameDate);
      idx = series.filter(g => new Date(g.date) < thisDate).length;
      // If still nothing in series, we can't derive a number reliably — bail.
      if (series.length === 0) return {};
    }

    // Series wins for each team in games BEFORE this one
    let homeWins = 0, visitorWins = 0;
    for (let i = 0; i < idx; i++) {
      const g = series[i];
      if (g.status !== 'Final' && g.status !== 'Final/OT') continue;
      const homeWon = g.home_team_score > g.visitor_team_score;
      if (homeWon) {
        if (g.home_team.id === home_team.id) homeWins++;
        else visitorWins++;
      } else {
        if (g.visitor_team.id === visitor_team.id) visitorWins++;
        else homeWins++;
      }
    }

    // Round: prefer BDL's field, fall back to calendar-based derivation from Game 1
    const rawRound   = game.round ?? series[0]?.round ?? null;
    const roundNum   = rawRound ? parseInt(rawRound, 10) : deriveRound(series[0]?.date ?? gameDate);
    const roundName  = ROUND_NAMES[roundNum] ?? null;

    return {
      playoff_game_number:  idx + 1,
      playoff_round_number: roundNum,
      playoff_round_name:   roundName,
      series_home_wins:     homeWins,
      series_visitor_wins:  visitorWins,
      series_games_played:  idx,
    };
  } catch (err) {
    console.error('series info error:', err);
    return {};
  }
}

async function getTopScorers(game) {
  try {
    if (game.home_team_score == null && game.visitor_team_score == null) return null;

    const res = await bdlFetch(`/stats?game_ids[]=${game.id}&per_page=100`);
    if (!res.ok) return null;

    const data  = await res.json();
    const stats = data.data || [];
    if (!stats.length) return null;

    const homeId    = game.home_team.id;
    const visitorId = game.visitor_team.id;
    const byTeam    = { [homeId]: [], [visitorId]: [] };

    for (const s of stats) {
      const tid = s.team?.id;
      if (!byTeam[tid]) continue;
      // Skip players with no points recorded and no minutes at all
      // Note: for live games BDL may return min=null, so we only skip if pts is also null
      if (s.pts == null) continue;
      const min = s.min ?? '';
      if (min === '00' || min === '0:00') continue;
      byTeam[tid].push({
        name: `${s.player.first_name} ${s.player.last_name}`,
        pts:  s.pts ?? 0,
        reb:  s.reb ?? 0,
        ast:  s.ast ?? 0,
      });
    }

    const top3 = arr => arr.sort((a, b) => b.pts - a.pts).slice(0, 3);

    const home    = top3(byTeam[homeId]);
    const visitor = top3(byTeam[visitorId]);

    if (!home.length && !visitor.length) return { home: [], visitor: [], unavailable: true };
    return { home, visitor, unavailable: false };
  } catch (err) {
    console.error('top scorers error:', err);
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
    const s = new Date(start_date), e = new Date(end_date);
    const diff = (e - s) / 86400000;
    if (diff < 0)  return res.status(400).json({ error: 'end_date must be after start_date' });
    if (diff > 30) return res.status(400).json({ error: 'Date range cannot exceed 30 days' });
    params.append('start_date', start_date);
    params.append('end_date', end_date);
  }

  try {
    const bdlRes = await bdlFetch(`/games?${params.toString()}`);
    const data   = await bdlRes.json();
    if (!bdlRes.ok) return res.status(bdlRes.status).json({ error: data.error || 'BallDontLie error' });

    const games = data.data || [];

    // Enrich playoff games and fetch top scorers in parallel
    await Promise.all([
      ...games
        .filter(g => g.postseason)
        .map(async g => {
          const info = await getPlayoffSeriesInfo(g);
          Object.assign(g, info);
        }),
      ...games
        .filter(g => g.home_team_score != null || g.visitor_team_score != null)
        .map(async g => {
          g.top_scorers = await getTopScorers(g);
        }),
    ]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
