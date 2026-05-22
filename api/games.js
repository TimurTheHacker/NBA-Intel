// api/games.js — Proxies BallDontLie. API key stays server-side.
//
// BDL v1 endpoint availability by plan:
//   /games        — available on all plans
//   /stats        — available on all plans (but may be empty for recent games)
//   /standings    — ALL-STAR plan only; we skip gracefully if unavailable
//   postseason    — flag is often missing/delayed; we detect by date range
//   round         — field often null; we derive from series Game 1 date

const bdlFetch = (path) =>
  fetch(`https://api.balldontlie.io/nba/v1${path}`, {
    headers: { Authorization: process.env.BALLDONTLIE_API_KEY },
  });

const ROUND_NAMES = {
  1: 'First Round',
  2: 'Conference Semifinals',
  3: 'Conference Finals',
  4: 'NBA Finals',
};

// NBA playoffs run mid-April through mid-June.
function looksLikePlayoff(dateStr) {
  const d     = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day   = d.getDate();
  if (month === 4 && day >= 13) return true;
  if (month === 5 || month === 6) return true;
  return false;
}

// Derive round from Game 1 date of the series
function deriveRound(dateStr) {
  if (!dateStr) return 1;
  const month = new Date(dateStr).getMonth() + 1;
  const day   = new Date(dateStr).getDate();
  if (month === 4)               return 1;  // April       → First Round
  if (month === 5 && day <= 14)  return 2;  // May 1–14    → Conf Semis
  if (month === 5 && day <= 28)  return 3;  // May 15–28   → Conf Finals
  return 4;                                 // June+       → NBA Finals
}

// Try to fetch seeds from /standings. Returns {} gracefully if endpoint
// is unavailable (plan restriction) or returns unexpected data.
async function getSeedsForSeason(season) {
  try {
    const res  = await bdlFetch(`/standings?seasons[]=${season}&per_page=30`);
    const text = await res.text();
    if (!res.ok) return {};
    if (!text.trim().startsWith('{')) return {};
    const data = JSON.parse(text);
    console.log('standings status:', res.status, 'keys:', Object.keys(data.data?.[0] || {}));
    const map  = {};
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

    const res  = await bdlFetch(`/games?${params.toString()}`);
    if (!res.ok) return {};
    const text = await res.text();
    if (!text.trim().startsWith('{')) return {};
    const raw  = JSON.parse(text);

    // Keep only matchups between exactly these two teams
    const series = (raw.data || [])
      .filter(g => {
        const ids = [g.home_team.id, g.visitor_team.id];
        return ids.includes(home_team.id) && ids.includes(visitor_team.id);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // If BDL returned 0 postseason games for this matchup, retry without the
    // postseason filter and manually keep only playoff-month dates.
    let effectiveSeries = series;
    let usedFallback    = false;
    if (series.length === 0) {
      const params2 = new URLSearchParams({ per_page: '100' });
      params2.append('seasons[]', season);
      params2.append('team_ids[]', home_team.id);
      params2.append('team_ids[]', visitor_team.id);
      const res2 = await bdlFetch(`/games?${params2.toString()}`);
      if (res2.ok) {
        const text2 = await res2.text();
        if (text2.trim().startsWith('{')) {
          const raw2 = JSON.parse(text2);
          effectiveSeries = (raw2.data || [])
            .filter(g => {
              const ids = [g.home_team.id, g.visitor_team.id];
              return ids.includes(home_team.id) && ids.includes(visitor_team.id) && looksLikePlayoff(g.date);
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date));
          usedFallback = true;
        }
      }
    }

    console.log('series length:', effectiveSeries.length, 'fallback used:', usedFallback);

    if (effectiveSeries.length === 0) return {};

    // Find position by ID; fall back to counting games strictly before this date
    let idx = effectiveSeries.findIndex(g => g.id === id);
    if (idx === -1) {
      idx = effectiveSeries.filter(g => new Date(g.date) < new Date(gameDate)).length;
    }

    // Count wins in games before this one
    let homeWins = 0, visitorWins = 0;
    for (let i = 0; i < idx; i++) {
      const g = effectiveSeries[i];
      if (g.status !== 'Final' && g.status !== 'Final/OT') continue;
      if (g.home_team_score > g.visitor_team_score) {
        if (g.home_team.id === home_team.id) homeWins++;
        else visitorWins++;
      } else {
        if (g.visitor_team.id === visitor_team.id) visitorWins++;
        else homeWins++;
      }
    }

    // If this game is finished, fold its result in so the record is current
    const isFinal = game.status === 'Final' || game.status === 'Final/OT';
    if (isFinal && game.home_team_score != null && game.visitor_team_score != null) {
      if (game.home_team_score > game.visitor_team_score) homeWins++;
      else visitorWins++;
    }

    const rawRound  = game.round ?? effectiveSeries[0]?.round ?? null;
    const roundNum  = rawRound ? parseInt(rawRound, 10) : deriveRound(effectiveSeries[0]?.date ?? gameDate);
    const roundName = ROUND_NAMES[roundNum] ?? null;

    return {
      playoff_game_number:  idx + 1,
      playoff_round_number: roundNum,
      playoff_round_name:   roundName,
      series_home_wins:     homeWins,
      series_visitor_wins:  visitorWins,
      series_games_played:  isFinal ? idx + 1 : idx,
      series_over:          isFinal && (homeWins >= 4 || visitorWins >= 4),
      home_seed:            seedMap?.[home_team.id]    ?? null,
      visitor_seed:         seedMap?.[visitor_team.id] ?? null,
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

    const text = await res.text();
    if (!text.trim().startsWith('{')) return null;
    const data  = JSON.parse(text);
    const stats = data.data || [];

    console.log('stats rows:', stats.length, 'sample:', JSON.stringify(stats[0]));

    if (!stats.length) return { home: [], visitor: [], pending: true };

    const homeId    = game.home_team.id;
    const visitorId = game.visitor_team.id;
    const byTeam    = { [homeId]: [], [visitorId]: [] };

    for (const s of stats) {
      const tid = s.team?.id;
      if (byTeam[tid] === undefined) continue;

      // Skip DNPs: only when BOTH minutes look like zero/empty AND pts is absent.
      // A player with min: null but pts: 14 (live game lag) should still appear.
      const minStr     = s.min != null ? String(s.min).trim() : '';
      const minIsEmpty = !minStr || minStr === '00' || minStr === '0' || minStr === '0:00';
      const ptsIsNull  = s.pts == null;
      if (minIsEmpty && ptsIsNull) continue;

      byTeam[tid].push({
        name: `${s.player.first_name} ${s.player.last_name}`,
        pts:  s.pts ?? 0,
        reb:  s.reb ?? 0,
        ast:  s.ast ?? 0,
      });
    }

    const top3    = arr => [...arr].sort((a, b) => b.pts - a.pts).slice(0, 3);
    const home    = top3(byTeam[homeId]);
    const visitor = top3(byTeam[visitorId]);

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
    const bdlRes  = await bdlFetch(`/games?${params.toString()}`);
    const bdlText = await bdlRes.text();
    if (!bdlRes.ok) {
      const errData = bdlText.trim().startsWith('{') ? JSON.parse(bdlText) : {};
      return res.status(bdlRes.status).json({ error: errData.error || 'BallDontLie error' });
    }
    if (!bdlText.trim().startsWith('{')) {
      return res.status(502).json({ error: 'Unexpected response from BallDontLie' });
    }
    const data = JSON.parse(bdlText);

    // Spread into new objects so we can safely mutate
    const games = (data.data || []).map(g => ({ ...g }));

    // Apply date-based playoff detection before anything else
    games.forEach(g => {
      if (!g.postseason && looksLikePlayoff(g.date)) g.postseason = true;
    });

    const playoffGames = games.filter(g => g.postseason);

    // Fetch seeds per season (graceful — returns {} if endpoint unavailable)
    const seasons  = [...new Set(playoffGames.map(g => g.season))];
    const seedMaps = {};
    await Promise.all(seasons.map(async s => {
      seedMaps[s] = await getSeedsForSeason(s);
    }));

    // All enrichment in parallel
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
    return res.status(200).json({ ...data, data: games });
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
