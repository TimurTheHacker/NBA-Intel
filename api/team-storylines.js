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

  const { team, length = 'short' } = body;
  const isLong = length === 'long';
  if (!team?.abbreviation || !team?.full_name) {
    return new Response(JSON.stringify({ error: 'Missing team data' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  let webContext = '';
  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) {
    try {
      const news = (q, tbs) => fetch('https://google.serper.dev/news', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 10, tbs }),
      }).then(r => r.ok ? r.json() : null).then(d => d?.news || []).catch(() => []);

      const JUNK = /fantasy|betting|\bodds\b|parlay|\bdfs\b|best bets|\bprops?\b/i;
      const clean = items => items.filter(r => r.title && !JUNK.test(r.title));
      const toSnippets = items =>
        items.map(r => `- ${r.title}${r.date ? ` (${r.date})` : ''}: ${r.snippet || ''}`);
      const words = t => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);

      // Same three angles as the league storylines, scoped to this team. Each
      // widens to the past month if the week is quiet.
      const SEARCHES = [
        { label: 'Headlines', q: team.full_name },
        { label: 'Players',   q: `${team.full_name} (injury OR trade OR signing OR extension OR star OR coach)` },
        { label: 'Team',      q: `${team.full_name} (record OR roster OR rotation OR season)` },
      ];
      const results = await Promise.all(SEARCHES.map(async s => {
        const week = clean(await news(s.q, 'qdr:w'));
        return week.length ? week : clean(await news(s.q, 'qdr:m'));
      }));

      // Keep the sections distinct: skip any headline that repeats one already used.
      const used = [];
      const sections = SEARCHES.map((s, i) => {
        const kept = [];
        for (const r of results[i]) {
          const w = words(r.title);
          if (used.some(u => [...w].filter(x => u.has(x)).length >= 3)) continue;
          used.push(w);
          kept.push(r);
          if (kept.length === 4) break;
        }
        return kept.length && `[${s.label}]\n${toSnippets(kept).join('\n')}`;
      }).filter(Boolean);

      if (sections.length) webContext = `Current ${team.full_name} news:\n\n${sections.join('\n\n')}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider with deep knowledge of the ${team.full_name} (${team.abbreviation}). Based on the news below, write a tight briefing on what is happening with this team right now.

Write ONE paragraph of ${isLong ? '10–12' : '6–7'} sentences. Name the team's anchor star(s) naturally — they are the identity. Cover the biggest current storyline. Reference recent history only when it directly shapes the current narrative — for example, a defending champion chasing a repeat, a team bouncing back after missing the playoffs, or a franchise cornerstone recently extended. Do not cite a specific win-loss record unless it is the story right now. Close with a confident, forward-looking take. Always energized and fan-facing: celebrate what is working, contextualize what is not, never sound like an obituary. Write like a polished press release — no headers, no labels, just the paragraph.

${webContext || `No current news could be loaded — keep it to broad points about the ${team.full_name} and do not state any specific recent events, trades, or results.`}

Rules: rely on the news above as your primary source; max ${isLong ? '260' : '140'} words; no run-on sentences; prioritize storylines about performance, roster moves, standings, and team identity — only mention injuries if a star player is out and it materially changes the team's outlook; never mention the news, search results, or sources you were given — present everything as your own knowledge.`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        thinking: { type: 'between_tools' },
        max_tokens: isLong ? 650 : 300,
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
