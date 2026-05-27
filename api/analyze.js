// api/analyze.js
// Proxies Anthropic Claude with SSE streaming. API key never leaves the server.
// Accepts: { game, length } where length is 'short' | 'long'

export const config = { runtime: 'edge' };

// Fetch recent coverage via Serper (Google Search API).
// Requires SERPER_API_KEY env var — silently returns '' if absent or on error.
// For pre-game: runs two parallel searches (matchup preview + injury/form intel).
// For live/final: single search on the specific game.
async function fetchWebContext(game, isPregame) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return '';

  const serper = (q, num = 5) =>
    fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num }),
    }).then(r => r.ok ? r.json() : null).catch(() => null);

  try {
    const gameYear = game.date?.slice(0, 4) ?? '';
    const away = game.visitor_team.full_name;
    const home = game.home_team.full_name;

    if (isPregame) {
      // Two parallel searches: game preview + injury/recent-form intel
      const [preview, injuries] = await Promise.all([
        serper(
          game.postseason && game.playoff_round_name && game.playoff_game_number != null
            ? `${away} vs ${home} ${game.playoff_round_name} Game ${game.playoff_game_number} ${gameYear} NBA preview prediction`
            : `${away} vs ${home} NBA ${game.date} preview prediction`,
          5
        ),
        serper(`${away} ${home} NBA injury report lineup ${gameYear}`, 4),
      ]);

      const toSnippets = (data, limit) =>
        (data?.organic || []).slice(0, limit).map(r => `- ${r.title}: ${r.snippet}`).filter(Boolean);

      const snippets = [...toSnippets(preview, 3), ...toSnippets(injuries, 3)].join('\n');
      return snippets
        ? `\nWeb context (preview articles, injury reports, recent form — use to sharpen your prediction):\n${snippets}`
        : '';
    }

    // Live / final: single search on the specific game
    let q;
    if (game.postseason && game.playoff_round_name && game.playoff_game_number != null) {
      q = `${away} vs ${home} ${game.playoff_round_name} Game ${game.playoff_game_number} ${gameYear} NBA`;
    } else {
      q = `${away} vs ${home} NBA ${game.date}`;
    }
    const data = await serper(q, 5);
    const snippets = (data?.organic || [])
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
  const webContext = await fetchWebContext(game, isPregame);

  const isShort = length === 'short';

  const prompt = `You are an expert NBA analyst.${isPregame
  ? ` This game has not yet been played. Rely primarily on the Web context below for current team information — rosters, injuries, recent form, and storylines. Use your own knowledge only for general strategic tendencies and historical matchup patterns; do not state specific current facts (players, venues, records) that aren't backed by the web context.`
  : ` For the GAME DATA below, rely strictly on what is provided — do not invent stats, series results, or outcomes not stated here. Where Web context is present, incorporate real-world details, analyst takes, and public reaction into your analysis.`}

GAME DATA${isPregame ? ' (matchup context — no score yet)' : ' (ground truth — reference these specific numbers, do not substitute)'}:
- Matchup: ${game.visitor_team.full_name} (away) vs ${game.home_team.full_name} (home)
- Date: ${game.date}
- Status: ${statusLabel}
- ${scoreInfo}
- Season: ${game.season}
- Context: ${playoffContext}${scorersContext}
${webContext}
${isShort
  ? isPregame
    ? `Write a single sharp paragraph (3–5 sentences): lead with the central narrative or stakes, name the decisive factor (a matchup edge, a player to watch, momentum, or home-court impact), and close with a punchy take on who controls this and why. No headers.`
    : `Write a single sharp paragraph (3–5 sentences) capturing: the result or stakes, one key storyline weaving in current public reaction or coverage where available, and a punchy closing take. Stick strictly to what the data tells you. No headers.`
  : isPregame
    ? `Write 3–4 paragraphs covering:
1. The narrative and stakes heading in — momentum, series or season context, what each team needs
2. The decisive matchup or X-factor — which side has the edge and the specific reason why
3. Injury/rotation intel from the web context, plus how crowd and home-court shape the outcome
4. A bold, committed prediction with clear reasoning — pick a winner and explain the margin

Ground all specific claims in the web context above.`
    : `Write 3–4 paragraphs covering:
1. The game narrative based on the score and status above
2. Playoff series context and what's at stake, using the series record provided
3. What this result means for each team going forward, incorporating relevant public reaction or analyst takes from the web context
4. A sharp analytical take or prediction

Important: Only reference facts given above and verified web context. Do not invent player stats, team records, or historical claims you aren't certain of.`}

Write in the style of a sharp, confident sports broadcaster.${isPregame ? '\n\nEnd with a score prediction on its own line formatted exactly as:\nPREDICTION: ' + game.visitor_team.abbreviation + ' 000 – 000 ' + game.home_team.abbreviation + '\nLet the margin reflect the actual matchup — a lopsided game should look lopsided, a tight series should be closer. No other text on that line.' : ''}`;

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
