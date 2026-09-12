// /api/watch — a watchlist that follows the wallet, not the browser.
//
//   GET  /api/watch?addr=0x…                 → { tickers:[…], at }
//   POST /api/watch  { addr, tickers, ts, sig } → saves after checking the signature
//
// The wallet signs a plain message (see message() below); we recover the signer with ethers and only accept the
// write if it matches `addr` and the timestamp is fresh. No contract, no gas — one signature per save.
//
// Storage is Upstash Redis over REST. On Vercel: Storage → Create → Upstash Redis (or the KV marketplace
// integration); it drops KV_REST_API_URL / KV_REST_API_TOKEN into the project env. Without them this endpoint
// answers 501 and the page keeps the watchlist per wallet in the browser instead.

const { verifyMessage } = require('ethers');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX = 95;

function message(addr, tickers, ts) {
  return `Gap watchlist\n${addr.toLowerCase()}\n${tickers.join(',')}\n${ts}`;
}
async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('kv ' + r.status);
  return (await r.json()).result;
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); req.on('error', rej); });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!URL_ || !TOKEN) return res.status(501).json({ error: 'no store configured', hint: 'add Upstash Redis to the Vercel project (KV_REST_API_URL / KV_REST_API_TOKEN)' });
  try {
    if (req.method === 'GET') {
      const addr = String(req.query.addr || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: 'bad addr' });
      const raw = await redis(['GET', `gap:watch:${addr}`]);
      const v = raw ? JSON.parse(raw) : { tickers: [], at: 0 };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(v);
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      const addr = String(b.addr || '').toLowerCase();
      const tickers = Array.isArray(b.tickers) ? [...new Set(b.tickers.map(t => String(t).toUpperCase().replace(/[^A-Z0-9.\-]/g, '')).filter(Boolean))].slice(0, MAX) : null;
      const ts = Number(b.ts);
      if (!/^0x[0-9a-f]{40}$/.test(addr) || !tickers || !isFinite(ts) || typeof b.sig !== 'string') return res.status(400).json({ error: 'bad request' });
      if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return res.status(400).json({ error: 'stale signature' });
      let signer;
      try { signer = verifyMessage(message(addr, tickers, ts), b.sig).toLowerCase(); } catch (e) { return res.status(400).json({ error: 'bad signature' }); }
      if (signer !== addr) return res.status(403).json({ error: 'signature does not match address' });
      const v = { tickers, at: Date.now() };
      await redis(['SET', `gap:watch:${addr}`, JSON.stringify(v)]);
      return res.status(200).json(v);
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
