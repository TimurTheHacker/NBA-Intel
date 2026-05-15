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

  const { game, length = 'long' } = body;
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

  const playoffLine = game.postseason
    ? `Playoff game${game.playoff_game_number ? ` — Game ${game.playoff_game_number} of the series` : ''}`
    : 'Regular season game';

  const isShort = length === 'short';

  const prompt = `You are an expert NBA analyst and broadcaster. Analyze this NBA game.

Game Details:
- Matchup: ${game.visitor_team.full_name} (away) @ ${game.home_team.full_name} (home)
- Date: ${game.date}
- Status: ${statusLabel}
- ${scoreInfo}
- Season: ${game.season}
- ${playoffLine}

${isShort
  ? `Write a single sharp paragraph (3–5 sentences) that captures the essence of this game — the result or stakes, one key storyline, and a punchy closing take. No headers. Be vivid and direct.`
  : `Write 3–4 paragraphs covering:
1. A compelling game narrative (what happened, or what's at stake if upcoming)
2. Key storylines, matchups, or player performances worth noting
3. Historical or seasonal context about these two franchises
4. Your analytical take on the result, or a prediction if not yet played

Write in the style of a sharp, knowledgeable sports broadcaster — vivid, confident, and fun to read.`}`;

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
