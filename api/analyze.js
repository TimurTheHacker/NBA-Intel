// api/analyze.js
// Proxies Anthropic Claude with SSE streaming. API key never leaves the server.
// Accepts: { game, length } where length is 'short' | 'long'

export const config = { runtime: 'edge' };

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

  // Build rich playoff context from API data so Claude doesn't have to guess
  let playoffContext = game.postseason ? 'Postseason (playoffs)\n' : 'Regular season\n';
  if (game.postseason) {
    if (game.playoff_round_name) {
      playoffContext += `- Round: ${game.playoff_round_name}\n`;
    }
    if (game.playoff_game_number) {
      playoffContext += `- Game ${game.playoff_game_number} of this series\n`;
    }
    if (game.series_games_played > 0) {
      // Express series record from each team's perspective
      const hw = game.series_home_wins ?? 0;
      const vw = game.series_visitor_wins ?? 0;
      playoffContext += `- Series record heading into this game: ${game.home_team.full_name} leads ${hw}–${vw}`;
      if (hw === vw) playoffContext = playoffContext.replace(`leads ${hw}–${vw}`, `tied ${hw}–${vw}`);
      playoffContext += '\n';
      if (hw === 3 || vw === 3) {
        const teamWithMatchpoint = hw === 3 ? game.home_team.full_name : game.visitor_team.full_name;
        playoffContext += `- ${teamWithMatchpoint} has a chance to close out the series this game\n`;
      }
    } else if (game.playoff_game_number === 1) {
      playoffContext += `- Series is tied 0–0 (this is Game 1)\n`;
    }
  }

  const isShort = length === 'short';

  const prompt = `You are an expert NBA analyst. You must rely ONLY on the factual data provided below — do not use your training knowledge to fill in team records, series results, or outcomes that aren't stated here. If you don't have the data, say so rather than guessing.

GAME DATA (treat this as ground truth):
- Matchup: ${game.visitor_team.full_name} (away) vs ${game.home_team.full_name} (home)
- Date: ${game.date}
- Status: ${statusLabel}
- ${scoreInfo}
- Season: ${game.season}
- Context: ${playoffContext}

${isShort
  ? `Write a single sharp paragraph (3–5 sentences) capturing: the result or stakes, one key storyline based on the series context above, and a punchy closing take. Stick strictly to what the data tells you. No headers.`
  : `Write 3–4 paragraphs covering:
1. The game narrative based on the score and status above
2. Playoff series context and what's at stake, using the series record provided
3. What this result means for each team going forward
4. A sharp analytical take or prediction

Important: Only reference facts given above. Do not invent player stats, team records, or historical claims you aren't certain of.`}

Write in the style of a sharp, confident sports broadcaster.`;

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
