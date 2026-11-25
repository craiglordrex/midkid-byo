/*
  MidKid Build Your Own: counts which stacks get ordered, so "Most ordered" on the page can show real favorites.

  GET  /api/orders?top=8   ->  { stacks: [{ bread, items, count }, ...] }   most ordered first
  POST /api/orders         <-  { bread, items }   one order (sent when someone copies, messages, calls or prints their order)

  Storage: a Redis database connected to this Vercel project (Storage > Upstash for Redis).
  Connecting it adds KV_REST_API_URL and KV_REST_API_TOKEN to the project; redeploy after connecting.
  Until it's connected, this answers 503 and the page simply keeps showing MidKid's picks.
*/
const crypto = require('crypto');

// keep in step with the ingredient ids in the page's data
const BREADS = ['potato', 'pbagel', 'pbun', 'pandesal', 'sour', 'sourhalf'];
const ITEMS = ['sausage', 'chicken', 'ham', 'cb100', 'cb50', 'pas100', 'pas50', 'gravlax', 'salmonfill', 'bacon', 'egg', 'wagyu',
  'cheddar', 'whitecheddar', 'arugula', 'caramelized', 'pickles', 'lettuce', 'redonion', 'sauerkraut', 'tomato',
  'aioli', 'creamcheese', 'dillsauce', 'japmayo', 'mustmayo', 'secret', 'ikura', 'tobiko'];
const SET = 'byo:stacks';

module.exports = async (req, res) => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(503).json({ error: 'Order counting is not set up yet.' });

  const redis = async cmds => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds)
    });
    if (!r.ok) throw new Error('redis ' + r.status);
    return r.json();
  };

  try {
    if (req.method === 'GET') {
      const n = Math.min(12, Math.max(1, parseInt(req.query.top, 10) || 8));
      const [{ result = [] }] = await redis([['ZREVRANGE', SET, 0, n - 1, 'WITHSCORES']]);
      const stacks = [];
      for (let i = 0; i < result.length; i += 2) {
        const [bread, items = ''] = String(result[i]).split('|');
        stacks.push({ bread, items: items ? items.split(',') : [], count: Number(result[i + 1]) || 0 });
      }
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ stacks });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      const bread = body && body.bread, items = body && body.items;
      if (!BREADS.includes(bread) || !Array.isArray(items) || items.length > 20 || !items.every(id => ITEMS.includes(id)))
        return res.status(400).json({ error: 'Not a stack we know.' });
      const key = bread + '|' + [...new Set(items)].sort().join(',');
      // the same visitor ordering the same stack again within 10 minutes counts once
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const seen = 'byo:seen:' + crypto.createHash('sha256').update(ip + '|' + key).digest('hex').slice(0, 32);
      const [lock] = await redis([['SET', seen, '1', 'EX', 600, 'NX']]);
      if (lock.result === 'OK') await redis([['ZINCRBY', SET, 1, key]]);
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the order counter.' });
  }
};
