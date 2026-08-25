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
      const now  = new Date();
      const year = now.getFullYear();
      const month = now.toLocaleString('en-US', { month: 'long' });

      const serper = (q) => fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 5 }),
      }).then(r => r.ok ? r.json() : null).catch(() => null);

      const toSnippets = (data, limit) =>
        (data?.organic || []).slice(0, limit).map(r => `- ${r.title}: ${r.snippet}`).filter(Boolean);

      // Round 1: broad search to detect what's actually happening right now
      const initial = await serper(`NBA news ${month} ${year}`);
      const initialSnippets = toSnippets(initial, 5);
      const titleText = (initial?.organic || []).map(r => r.title.toLowerCase()).join(' ');

      // Detect which topics appear in the headlines — pick 2 distinct ones for follow-up
      const TOPICS = [
        { key: 'trade',      query: `NBA trades free agency ${year}` },
        { key: 'draft',      query: `NBA draft ${year} picks` },
        { key: 'final',      query: `NBA Finals ${year} champion analysis` },
        { key: 'playoff',    query: `NBA playoffs ${year} series results` },
        { key: 'injur',      query: `NBA injury report ${year}` },
        { key: 'sign',       query: `NBA player signings contracts ${year}` },
        { key: 'retir',      query: `NBA player retirement ${year}` },
        { key: 'coach',      query: `NBA coaching hire fire ${year}` },
        { key: 'contract',   query: `NBA contract extension ${year}` },
        { key: 'standing',   query: `NBA standings highlights ${year}` },
      ];
      const FALLBACKS = [
        `NBA player news ${year}`,
        `NBA standings season highlights ${year}`,
      ];

      const matched = TOPICS.filter(t => titleText.includes(t.key)).slice(0, 2).map(t => t.query);
      while (matched.length < 2) matched.push(FALLBACKS[matched.length]);

      // Round 2: two targeted deep-dives in parallel
      const [follow1, follow2] = await Promise.all(matched.map(q => serper(q)));

      const parts = [
        initialSnippets.join('\n'),
        toSnippets(follow1, 3).join('\n'),
        toSnippets(follow2, 3).join('\n'),
      ].filter(Boolean);

      if (parts.length) webContext = `Current NBA news:\n\n[Headlines]\n${parts[0]}${parts[1] ? `\n\n[Deep dive — ${matched[0]}]\n${parts[1]}` : ''}${parts[2] ? `\n\n[Deep dive — ${matched[1]}]\n${parts[2]}` : ''}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider. Report the biggest current storylines, prioritizing the most current and biggest news over theories, older news, and stories of less importance. Based on the current news below, produce a structured storylines briefing in EXACTLY this format — no deviations, no extra headers:

MAIN
[One tight paragraph: ${isLong ? '10–13' : '6–7'} sentences, max ${isLong ? '250' : '130'} words. Cover the single biggest NBA storyline dominating every conversation right now. Specific and opinionated.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words.]

SIDE: [Short punchy title]
[One tight paragraph: ${isLong ? '8–10' : '5–6'} sentences, max ${isLong ? '190' : '110'} words.]

${webContext || 'No current news available — use the most relevant recent NBA context you are aware of.'}

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
        model: 'claude-sonnet-4-6',
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
