// api/analyze.js
// Proxies Anthropic Claude with SSE streaming. API key never leaves the server.
// Accepts: { game, length } where length is 'short' | 'long'

export const config = { runtime: 'edge' };

// Fetch recent coverage via Serper (Google Search API).
// Requires SERPER_API_KEY env var — silently returns '' if absent or on error.
async function fetchWebContext(game) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return '';
  try {
    const gameYear = game.date?.slice(0, 4) ?? '';
    let q;
    if (game.postseason && game.playoff_round_name && game.playoff_game_number != null) {
      q = `${game.visitor_team.full_name} vs ${game.home_team.full_name} ${game.playoff_round_name} Game ${game.playoff_game_number} ${gameYear} NBA`;
    } else {
      q = `${game.visitor_team.full_name} vs ${game.home_team.full_name} NBA ${game.date}`;
    }
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 5 }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const snippets = (data.organic || [])
      .slice(0, 4)
      .map(r => `- ${r.title}: ${r.snippet}`)
      .filter(Boolean)
      .join('\n');
    return snippets
      ? `\nWeb context (recent coverage and public reaction — use to add color, verify before citing):\n${snippets}`
      : '';
  } catch {
    return '';
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { game, length = 'short' } = body;
  if (!game) {
    return new Response(JSON.stringify({ error: 'Missing game data' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const hasScores = game.home_team_score != null && game.visitor_team_score != null;
  const scoreInfo = hasScores
    ? `Score: ${game.visitor_team.full_name} ${game.visitor_team_score} – ${game.home_team.full_name} ${game.home_team_score}`
    : 'Game has not started yet or score is unavailable.';

  const statusLabel =
    game.status === 'Final' || game.status === 'Final/OT' ? 'Final'
    : game.status?.includes('Qtr') || game.status === 'In Progress' ? 'Live / In Progress'
    : `Scheduled (${game.status})`;

  const isComplete = game.status === 'Final' || game.status === 'Final/OT';
  const isPregame  = statusLabel.startsWith('Scheduled');

  let playoffContext = game.postseason ? 'Postseason (playoffs)\n' : 'Regular season\n';
  if (game.postseason) {
    if (game.playoff_round_name) {
      playoffContext += `- Round: ${game.playoff_round_name}\n`;
    }
    if (game.playoff_game_number) {
      playoffContext += `- Game ${game.playoff_game_number} of this series\n`;
    }
    if (game.series_games_played > 0) {
      const hw = game.series_home_wins ?? 0;
      const vw = game.series_visitor_wins ?? 0;
      if (isComplete && game.series_over) {
        const winner = hw > vw ? game.home_team.full_name : game.visitor_team.full_name;
        playoffContext += `- Series result: ${winner} wins the series ${Math.max(hw, vw)}–${Math.min(hw, vw)}\n`;
      } else if (isComplete) {
        const recordStr = hw === vw
          ? `Series tied ${hw}–${vw}`
          : `${hw > vw ? game.home_team.full_name : game.visitor_team.full_name} leads ${Math.max(hw, vw)}–${Math.min(hw, vw)}`;
        playoffContext += `- Series record after this game: ${recordStr}\n`;
      } else {
        const recordStr = hw === vw
          ? `Series tied ${hw}–${vw}`
          : `${hw > vw ? game.home_team.full_name : game.visitor_team.full_name} leads ${Math.max(hw, vw)}–${Math.min(hw, vw)}`;
        playoffContext += `- Series record heading into this game: ${recordStr}\n`;
        if (hw === 3 || vw === 3) {
          const teamWithMatchpoint = hw === 3 ? game.home_team.full_name : game.visitor_team.full_name;
          playoffContext += `- ${teamWithMatchpoint} has a chance to close out the series this game\n`;
        }
      }
    } else if (game.playoff_game_number === 1) {
      playoffContext += `- Series is tied 0–0 (this is Game 1)\n`;
    }
  }

  // Build top scorers context if available
  let scorersContext = '';
  if (game.top_scorers) {
    const fmt = (players, teamName) => {
      if (!players || !players.length) return '';
      const lines = players.map(p => `    - ${p.name}: ${p.pts} pts, ${p.reb} reb, ${p.ast} ast`).join('\n');
      return `  ${teamName}:\n${lines}`;
    };
    const homeStr    = fmt(game.top_scorers.home,    game.home_team.full_name);
    const visitorStr = fmt(game.top_scorers.visitor, game.visitor_team.full_name);
    if (homeStr || visitorStr) {
      scorersContext = `\nTop scorers in this game:\n${[visitorStr, homeStr].filter(Boolean).join('\n')}`;
    }
  }

  // Fetch web context in parallel with nothing else — fast Serper call before we stream
  const webContext = await fetchWebContext(game);

  const isShort = length === 'short';

  const prompt = `You are an expert NBA analyst. For the GAME DATA below, rely strictly on what is provided — do not invent stats, series results, or outcomes not stated here. Where Web context is present, incorporate real-world details, analyst takes, and public reaction into your analysis.

GAME DATA (ground truth — reference these specific numbers, do not substitute):
- Matchup: ${game.visitor_team.full_name} (away) vs ${game.home_team.full_name} (home)
- Date: ${game.date}
- Status: ${statusLabel}
- ${scoreInfo}
- Season: ${game.season}
- Context: ${playoffContext}${scorersContext}
${webContext}
${isShort
  ? `Write a single sharp paragraph (3–5 sentences) capturing: the result or stakes, one key storyline weaving in current public reaction or coverage where available, and a punchy closing take. Stick strictly to what the data tells you. No headers.`
  : `Write 3–4 paragraphs covering:
1. The game narrative based on the score and status above
2. Playoff series context and what's at stake, using the series record provided
3. What this result means for each team going forward, incorporating relevant public reaction or analyst takes from the web context
4. A sharp analytical take or prediction

Important: Only reference facts given above and verified web context. Do not invent player stats, team records, or historical claims you aren't certain of.`}

Write in the style of a sharp, confident sports broadcaster.${isPregame ? '\n\nEnd with a score prediction on its own line formatted exactly as:\nPREDICTION: ' + game.visitor_team.abbreviation + ' 000 – 000 ' + game.home_team.abbreviation + '\n(Replace 000 with your predicted scores — no other text on that line.)' : ''}`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: isShort ? 300 : 1024,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err.error?.message || `Anthropic error ${anthropicRes.status}` }),
        { status: anthropicRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(anthropicRes.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    console.error('analyze proxy error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
