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

// Calendar-based round derivation from the date of Game 1 of the series.
function deriveRound(game1Date) {
  if (!game1Date) return 1;
  const month = new Date(game1Date).getMonth() + 1;
  const day   = new Date(game1Date).getDate();
  if (month === 4)              return 1;  // April = First Round
  if (month === 5 && day <= 14) return 2;  // Early May = Conf Semis
  if (month === 5 && day <= 28) return 3;  // Late May = Conf Finals
  if (month >= 6)               return 4;  // June = NBA Finals
  return 1;
}

// A game is a playoff game if BDL says so OR it falls in playoff months (Apr–Jun)
function isPlayoff(g) {
  if (g.postseason) return true;
  const month = new Date(g.date).getMonth() + 1;
  return month >= 4 && month <= 6;
}

// Fetch seeds for a season. Returns { [teamId]: seed }
async function getSeedsForSeason(season) {
  try {
    // BDL v1 standings endpoint
    const res = await bdlFetch(`/standings?seasons[]=${season}&per_page=30`);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const entry of (data.data || [])) {
      const id   = entry.team?.id;
      // BDL may use playoff_seed or conference_rank depending on season
      const seed = entry.playoff_seed ?? entry.conference_rank ?? null;
      if (id && seed != null) map[id] = parseInt(seed, 10);
    }
    return map;
  } catch {
    return {};
  }
}

async function getPlayoffSeriesInfo(game, seedMap = {}) {
  try {
    const { season, home_team, visitor_team, id, date: gameDate } = game;

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

    // Find by ID first; fall back to date-position if BDL hasn't flagged this game yet
    let idx = series.findIndex(g => g.id === id);
    if (idx === -1) {
      if (series.length === 0) return {};
      const thisDate = new Date(gameDate);
      idx = series.filter(g => new Date(g.date) < thisDate).length;
    }

    // Count wins for each team in games before this one
    let homeWins = 0, visitorWins = 0;
    for (let i = 0; i < idx; i++) {
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

    const rawRound  = game.round ?? series[0]?.round ?? null;
    const roundNum  = rawRound ? parseInt(rawRound, 10) : deriveRound(series[0]?.date ?? gameDate);
    const roundName = ROUND_NAMES[roundNum] ?? null;

    return {
      playoff_game_number:  idx + 1,
      playoff_round_number: roundNum,
      playoff_round_name:   roundName,
      series_home_wins:     homeWins,
      series_visitor_wins:  visitorWins,
      series_games_played:  idx,
      home_seed:            seedMap[home_team.id]    ?? null,
      visitor_seed:         seedMap[visitor_team.id] ?? null,
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

    // BDL returns an empty array until stats are processed — treat as pending
    if (!stats.length) return null;

    const homeId    = game.home_team.id;
    const visitorId = game.visitor_team.id;
    const byTeam    = { [homeId]: [], [visitorId]: [] };

    for (const s of stats) {
      const tid = s.team?.id;
      if (!byTeam[tid]) continue;
      // Only skip DNP rows: pts must be non-null AND minutes must not be literally zero
      if (s.pts == null) continue;
      const min = String(s.min ?? '');
      if (min === '00' || min === '0:00' || min === '0') continue;
      byTeam[tid].push({
        name: `${s.player.first_name} ${s.player.last_name}`,
        pts:  s.pts,
        reb:  s.reb ?? 0,
        ast:  s.ast ?? 0,
      });
    }

    const top3 = arr => [...arr].sort((a, b) => b.pts - a.pts).slice(0, 3);

    const home    = top3(byTeam[homeId]);
    const visitor = top3(byTeam[visitorId]);

    // Both teams empty means BDL has the game row but no player stats yet
    if (!home.length && !visitor.length) return { home: [], visitor: [], pending: true };
    return { home, visitor, pending: false };
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

    // Mark games as playoff by date if BDL's postseason flag hasn't caught up
    games.forEach(g => { if (!g.postseason && isPlayoff(g)) g.postseason = true; });

    // Fetch seeds once per unique season across all playoff games
    const playoffGames = games.filter(g => g.postseason);
    const seasons      = [...new Set(playoffGames.map(g => g.season))];
    const seedMaps     = {};
    await Promise.all(seasons.map(async s => { seedMaps[s] = await getSeedsForSeason(s); }));

    // Enrich playoff games + fetch top scorers, all in parallel
    await Promise.all([
      ...playoffGames.map(async g => {
        const info = await getPlayoffSeriesInfo(g, seedMaps[g.season] ?? {});
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
