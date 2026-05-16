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

function deriveRound(dateStr) {
  if (!dateStr) return 1;
  const month = new Date(dateStr).getMonth() + 1;
  const day   = new Date(dateStr).getDate();
  if (month === 4)               return 1;
  if (month === 5 && day <= 14)  return 2;
  if (month === 5 && day <= 28)  return 3;
  if (month >= 6)                return 4;
  return 1;
}

// True if the game date falls in NBA playoff months (April–June)
function looksLikePlayoff(dateStr) {
  const month = new Date(dateStr).getMonth() + 1;
  return month >= 4 && month <= 6;
}

// Fetch seeds for a season via the player_season_stats or standings endpoint.
// BDL v1 exposes /standings — try it, return empty map on failure.
async function getSeedsForSeason(season) {
  try {
    const res = await bdlFetch(`/standings?seasons[]=${season}&per_page=30`);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const entry of (data.data || [])) {
      const id   = entry.team?.id;
      const seed = entry.playoff_seed ?? entry.conference_rank ?? null;
      if (id != null && seed != null) map[id] = parseInt(seed, 10);
    }
    return map;
  } catch {
    return {};
  }
}

async function getPlayoffSeriesInfo(game, seedMap) {
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

    const series = (raw.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    let idx = series.findIndex(g => g.id === id);
    if (idx === -1) {
      if (series.length === 0) return {};
      idx = series.filter(g => new Date(g.date) < new Date(gameDate)).length;
    }

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
      home_seed:            (seedMap && seedMap[home_team.id])    ?? null,
      visitor_seed:         (seedMap && seedMap[visitor_team.id]) ?? null,
    };
  } catch (err) {
    console.error('series info error:', err);
    return {};
  }
}

async function getTopScorers(game) {
  try {
    if (game.home_team_score == null && game.visitor_team_score == null) return null;

    // Fetch up to 100 stat rows; a full box score is ~25-30 rows so this should be enough
    const res = await bdlFetch(`/stats?game_ids[]=${game.id}&per_page=100`);
    if (!res.ok) return null;

    const data  = await res.json();
    const stats = data.data || [];

    // Empty array = BDL hasn't processed this game yet
    if (!stats.length) return { home: [], visitor: [], pending: true };

    const homeId    = game.home_team.id;
    const visitorId = game.visitor_team.id;
    const byTeam    = { [homeId]: [], [visitorId]: [] };

    for (const s of stats) {
      const tid = s.team?.id;
      if (byTeam[tid] === undefined) continue;

      // Skip true DNPs: must have played some minutes
      // BDL encodes DNP as min=null or min="00" or min="0" or min="0:00"
      const minStr = s.min != null ? String(s.min).trim() : null;
      const didNotPlay = (minStr === null || minStr === '' || minStr === '00' || minStr === '0' || minStr === '0:00');
      if (didNotPlay) continue;

      // pts can be 0 legitimately — only skip if null
      if (s.pts === null || s.pts === undefined) continue;

      byTeam[tid].push({
        name: `${s.player.first_name} ${s.player.last_name}`,
        pts:  s.pts,
        reb:  s.reb  ?? 0,
        ast:  s.ast  ?? 0,
      });
    }

    const top3 = arr => [...arr].sort((a, b) => b.pts - a.pts).slice(0, 3);
    const home    = top3(byTeam[homeId]);
    const visitor = top3(byTeam[visitorId]);

    // If we got stat rows but both teams are empty, something is wrong with team ID matching
    if (!home.length && !visitor.length) {
      console.error('stats returned but no players matched team IDs', homeId, visitorId,
        stats.slice(0, 3).map(s => ({ teamId: s.team?.id, player: s.player?.first_name })));
      return { home: [], visitor: [], pending: true };
    }

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

    // Spread each game into a new object so we can safely mutate postseason flag
    const games = (data.data || []).map(g => ({ ...g }));

    // Flag any game in Apr–Jun as playoff if BDL hasn't set it yet
    games.forEach(g => {
      if (!g.postseason && looksLikePlayoff(g.date)) g.postseason = true;
    });

    const playoffGames = games.filter(g => g.postseason);

    // Fetch seeds once per season (in parallel)
    const seasons  = [...new Set(playoffGames.map(g => g.season))];
    const seedMaps = {};
    await Promise.all(seasons.map(async s => {
      seedMaps[s] = await getSeedsForSeason(s);
    }));

    // Enrich all games in parallel
    await Promise.all([
      // Playoff series info + seeds
      ...playoffGames.map(async g => {
        const info = await getPlayoffSeriesInfo(g, seedMaps[g.season] ?? {});
        Object.assign(g, info);
      }),
      // Top scorers for any game that has scores
      ...games
        .filter(g => g.home_team_score != null || g.visitor_team_score != null)
        .map(async g => {
          g.top_scorers = await getTopScorers(g);
        }),
    ]);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ ...data, data: games });
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
