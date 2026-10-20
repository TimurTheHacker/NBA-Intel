// api/storylines.js
// Fetches current NBA storylines via Serper + Claude streaming.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { length = 'short' } = body;
  const isLong = length === 'long';

  let webContext = '';
  const serperKey = process.env.SERPER_API_KEY;
  if (serperKey) {
    try {
      const news = (q, tbs = 'qdr:w') => fetch('https://google.serper.dev/news', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 10, tbs }),
      }).then(r => r.ok ? r.json() : null).then(d => d?.news || []).catch(() => []);

      const JUNK = /fantasy|betting|\bodds\b|parlay|\bdfs\b|best bets|\bprops?\b/i;
      const clean = items => items.filter(r => r.title && !JUNK.test(r.title));
      const toSnippets = items =>
        items.map(r => `- ${r.title}${r.date ? ` (${r.date})` : ''}: ${r.snippet || ''}`);
      const words = t => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);

      // Three angles on the league. None is tied to a time of year; each widens
      // to the past month if the week is quiet.
      const SEARCHES = [
        { label: 'League',  q: 'NBA' },
        { label: 'Players', q: 'NBA (player OR coach) (injury OR trade OR draft OR signing OR extension OR hired OR fired)' },
        { label: 'Teams',   q: 'NBA team (record OR roster OR rebuild OR contender OR legacy)' },
      ];
      const results = await Promise.all(SEARCHES.map(async s => {
        const week = clean(await news(s.q));
        return week.length ? week : clean(await news(s.q, 'qdr:m'));
      }));

      // Keep the sections distinct: skip any headline that repeats one already used.
      const used = [];
      const take = (items, max) => {
        const kept = [];
        for (const r of items) {
          const w = words(r.title);
          if (used.some(u => [...w].filter(x => u.has(x)).length >= 3)) continue;
          used.push(w);
          kept.push(r);
          if (kept.length === max) break;
        }
        return kept;
      };

      // Recent: anything from the last 48 hours across all three searches, pulled
      // out first so a fresh story can't be crowded out by bigger names.
      const isRecent = r => /just now|\b(mins?|minutes?|hours?) ago\b|\b1 day ago\b/i.test(r.date || '');
      const recent = take(results.flat().filter(isRecent), 5);

      const sections = [
        recent.length && `[Recent — last 48 hours]\n${toSnippets(recent).join('\n')}`,
        ...SEARCHES.map((s, i) => {
          const kept = take(results[i], 4);
          return kept.length && `[${s.label}]\n${toSnippets(kept).join('\n')}`;
        }),
      ].filter(Boolean);

      if (sections.length) webContext = `Current NBA news (past week):\n\n${sections.join('\n\n')}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider. Report the biggest current storylines, prioritizing the most current and biggest news over theories, older news, and stories of less importance. Based on the current news below, produce a structured storylines briefing in EXACTLY this format — no deviations, no extra headers:

MAIN
[One tight paragraph: ${isLong ? '10–13' : '6–7'} sentences, max ${isLong ? '250' : '130'} words. Cover the single biggest NBA storyline right now, drawn from the [League] or [Recent] news. Specific and opinionated.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words. A player or coach story drawn from the [Players] or [Recent] news.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words. A team story drawn from the [Teams] or [Recent] news.]

${webContext || 'No current news could be loaded. Do not state any specific recent events, trades, or results — write MAIN as one sentence saying fresh news is unavailable, and skip the SIDE items.'}

Rules: rely on the news above as your primary source; rank stories by significance, not name recognition — a season-altering injury, a major trade, or a firing outranks routine performance news; a significant story under [Recent] takes the slot it fits (MAIN if it is the biggest story overall, otherwise the matching SIDE); if a news section is missing, use the strongest remaining story instead; exactly 2 SIDE items; each item must cover a DIFFERENT topic — never repeat or overlap with another section (e.g. if MAIN is about the Finals, SIDE items must cover different subjects like trades, a player situation, coaching news, etc.); no run-on sentences; write like a polished press release.`;

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
        max_tokens: isLong ? 1800 : 850,
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
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
