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
      const toSnippets = (items, limit) =>
        items.slice(0, limit).map(r => `- ${r.title}${r.date ? ` (${r.date})` : ''}: ${r.snippet || ''}`);

      // Round 1: whatever is dominating NBA news this week (widen to a month if quiet)
      let headlines = clean(await news('NBA'));
      if (!headlines.length) headlines = clean(await news('NBA', 'qdr:m'));

      // Round 2: dig into the two most distinct headlines. Follow-up queries come
      // from the news itself, so nothing is tied to a time of year.
      const words = t => new Set(t.toLowerCase().match(/[a-z]{4,}/g) || []);
      const picked = [];
      for (const h of headlines) {
        const w = words(h.title);
        if (picked.every(p => [...w].filter(x => p.w.has(x)).length < 2)) picked.push({ title: h.title, w });
        if (picked.length === 2) break;
      }
      const followUps = await Promise.all(picked.map(p => news(p.title).then(clean)));

      const sections = [
        headlines.length && `[Headlines]\n${toSnippets(headlines, 6).join('\n')}`,
        ...followUps.map((items, i) => items.length && `[Deep dive — ${picked[i].title}]\n${toSnippets(items, 3).join('\n')}`),
      ].filter(Boolean);

      if (sections.length) webContext = `Current NBA news (past week):\n\n${sections.join('\n\n')}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider. Report the biggest current storylines, prioritizing the most current and biggest news over theories, older news, and stories of less importance. Based on the current news below, produce a structured storylines briefing in EXACTLY this format — no deviations, no extra headers:

MAIN
[One tight paragraph: ${isLong ? '10–13' : '6–7'} sentences, max ${isLong ? '250' : '130'} words. Cover the single biggest NBA storyline dominating every conversation right now. Specific and opinionated.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words.]

${webContext || 'No current news could be loaded. Do not state any specific recent events, trades, or results — write MAIN as one sentence saying fresh news is unavailable, and skip the SIDE items.'}

Rules: rely on the news above as your primary source; exactly 2 SIDE items; each item must cover a DIFFERENT topic — never repeat or overlap with another section (e.g. if MAIN is about the Finals, SIDE items must cover different subjects like trades, a player situation, coaching news, etc.); no run-on sentences; write like a polished press release.`;

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
