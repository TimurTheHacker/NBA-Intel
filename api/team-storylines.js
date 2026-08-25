// api/team-storylines.js
// Fetches team-specific NBA storylines via Serper + Claude streaming.

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

  const { team } = body;
  if (!team?.abbreviation || !team?.full_name) {
    return new Response(JSON.stringify({ error: 'Missing team data' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  let webContext = '';
  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) {
    try {
      const now   = new Date();
      const year  = now.getFullYear();
      const month = now.toLocaleString('en-US', { month: 'long' });

      const serper = (q) => fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 5 }),
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      const toSnippets = (data, limit) =>
        (data?.organic || []).slice(0, limit).map(r => `- ${r.title}: ${r.snippet}`).filter(Boolean);

      const [news, moves] = await Promise.all([
        serper(`${team.full_name} NBA news ${month} ${year}`),
        serper(`${team.full_name} NBA performance trade roster moves ${month} ${year}`),
      ]);

      const parts = [
        toSnippets(news, 4).join('\n'),
        toSnippets(moves, 3).join('\n'),
      ].filter(Boolean);

      if (parts.length) webContext = `Current ${team.full_name} news:\n\n${parts.join('\n\n')}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider with deep knowledge of the ${team.full_name} (${team.abbreviation}). Based on the news below, write a tight briefing on what is happening with this team right now.

Write ONE paragraph of 5–6 sentences. Lead with the team's identity and what makes them compelling right now — their star power, system, depth, or trajectory. Cover the biggest current storyline, then close with a confident, forward-looking take on what they can achieve. The tone should always be energized and fan-facing: celebrate what's working, contextualize what isn't, and leave the reader excited. For elite teams, be bold about their ceiling. For rebuilding teams, make the upside feel real and near. Never sound like an obituary. Write like a polished press release — no headers, no labels, just the paragraph.

${webContext || `No current news available — use the most relevant recent context you know about the ${team.full_name}.`}

Rules: rely on the news above as your primary source; max 120 words; no run-on sentences; prioritize storylines about performance, roster moves, standings, and team identity — only mention injuries if a star player is out and it materially changes the team's outlook.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 250,
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
  } catch {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
