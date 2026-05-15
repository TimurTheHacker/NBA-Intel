// api/games.js
// Serverless function — proxies BallDontLie so the API key stays server-side.

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { date, start_date, end_date } = req.query;

  if (!date && !(start_date && end_date)) {
    return res.status(400).json({ error: 'Provide ?date=YYYY-MM-DD or ?start_date=&end_date=' });
  }

  // Build BallDontLie URL
  const params = new URLSearchParams({ per_page: '50' });

  if (date) {
    params.append('dates[]', date);
  } else {
    // Range mode — validate max 30 days
    const start = new Date(start_date);
    const end = new Date(end_date);
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);

    if (diffDays < 0) {
      return res.status(400).json({ error: 'end_date must be after start_date' });
    }
    if (diffDays > 30) {
      return res.status(400).json({ error: 'Date range cannot exceed 30 days' });
    }

    params.append('start_date', start_date);
    params.append('end_date', end_date);
  }

  try {
    const bdlRes = await fetch(
      `https://api.balldontlie.io/v1/games?${params.toString()}`,
      {
        headers: {
          Authorization: process.env.BALLDONTLIE_API_KEY,
        },
      }
    );

    const data = await bdlRes.json();

    if (!bdlRes.ok) {
      return res.status(bdlRes.status).json({ error: data.error || 'BallDontLie error' });
    }

    // Cache for 60s (live games) — increase for historical data
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);
  } catch (err) {
    console.error('games proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
