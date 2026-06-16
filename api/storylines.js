// api/storylines.js
// Fetches current NBA storylines via Serper + Claude streaming.

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

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

      const [general, postseason] = await Promise.all([
        serper(`NBA news storylines ${month} ${year}`),
        serper(`NBA Finals playoffs ${year} latest`),
      ]);

      const toSnippets = (data, limit) =>
        (data?.organic || []).slice(0, limit).map(r => `- ${r.title}: ${r.snippet}`).filter(Boolean);

      const snippets = [...toSnippets(general, 4), ...toSnippets(postseason, 3)].join('\n');
      if (snippets) webContext = `Current NBA news:\n${snippets}`;
    } catch {}
  }

  const prompt = `You are a sharp NBA insider. Based on the current news below, produce a structured storylines briefing in EXACTLY this format — no deviations, no extra headers:

MAIN
[One tight paragraph: 4–5 sentences, max 90 words. Cover the single biggest NBA storyline dominating every conversation right now. Specific and opinionated.]

SIDE: [Short punchy title]
[One tight paragraph: 3–4 sentences, max 70 words.]

SIDE: [Short punchy title]
[One tight paragraph: 3–4 sentences, max 70 words.]

${webContext || 'No current news available — use the most relevant recent NBA context you are aware of.'}

Rules: rely on the news above as your primary source; exactly 2 SIDE items; no run-on sentences; write like a sports insider, not a press release.`;

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
        max_tokens: 600,
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
