// /api/gap — one cached JSON for the whole terminal.
//
// On-chain side : GeckoTerminal (no key) — price, 24h volume, liquidity, buys/sells for every stock token's top pool.
// Market side   : Finnhub if FINNHUB_KEY is set (60 req/min free) — otherwise Yahoo's chart endpoint (no key).
//                 Quotes are refreshed in slices so we never exceed the free limits; the market is shut ~70% of the
//                 week anyway and closes don't move.
//
// Deploys with zero config on Vercel (Node runtime). Set FINNHUB_KEY in the project's environment variables for the
// most reliable quotes. Response is cached at the edge for 45s and in the function's memory between calls.

const TOKENS = require('./tokens.json');
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';

const state = globalThis.__gapState || (globalThis.__gapState = { chain: {}, chainAt: 0, quotes: {}, cursor: 0, quotesAt: 0 });

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: Object.assign({ accept: 'application/json', 'user-agent': 'gap-terminal/1.0' }, headers || {}) });
  if (!r.ok) throw new Error(url.split('?')[0] + ' -> ' + r.status);
  return r.json();
}

// ---------------------------------------------------------------- on-chain (GeckoTerminal, 30 tokens per call)
async function refreshChain() {
  if (Date.now() - state.chainAt < 40000) return;
  const addrs = TOKENS.map(t => t.addr.toLowerCase());
  const next = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const slice = addrs.slice(i, i + 30);
    try {
      const j = await getJSON(`${GT}/tokens/multi/${slice.join(',')}?include=top_pools`);
      const pools = {};
      (j.included || []).forEach(p => { pools[p.id] = p.attributes; });
      (j.data || []).forEach(t => {
        const a = t.attributes || {};
        const poolId = (((t.relationships || {}).top_pools || {}).data || [])[0];
        const pool = poolId ? pools[poolId.id] : null;
        next[a.address.toLowerCase()] = {
          img: a.image_url && !/missing/.test(a.image_url) ? a.image_url : null,
          price: num(a.price_usd), vol24: num(a.volume_usd && a.volume_usd.h24), liq: num(a.total_reserve_in_usd),
          pool: poolId ? poolId.id.replace('robinhood_', '') : null,
          poolName: pool ? pool.name : null,
          chg: pool && pool.price_change_percentage ? { h1: num(pool.price_change_percentage.h1), h24: num(pool.price_change_percentage.h24) } : null,
          tx: pool && pool.transactions && pool.transactions.h24 ? { buys: pool.transactions.h24.buys, sells: pool.transactions.h24.sells, buyers: pool.transactions.h24.buyers, sellers: pool.transactions.h24.sellers } : null
        };
      });
    } catch (e) { console.warn('gecko slice failed', e.message); }
  }
  if (Object.keys(next).length) { state.chain = Object.assign({}, state.chain, next); state.chainAt = Date.now(); }
}

// ---------------------------------------------------------------- market quotes
async function quoteFinnhub(sym, key) {
  const j = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  if (!j || !j.c) throw new Error('no quote');
  return { last: j.c, prevClose: j.pc, open: j.o, high: j.h, low: j.l, at: (j.t || 0) * 1000, src: 'finnhub' };
}
async function quoteYahoo(sym) {
  const j = await getJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`);
  const m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || !m.regularMarketPrice) throw new Error('no quote');
  return { last: m.regularMarketPrice, prevClose: m.chartPreviousClose || m.previousClose, at: (m.regularMarketTime || 0) * 1000, src: 'yahoo' };
}
async function refreshQuotes() {
  const key = process.env.FINNHUB_KEY;
  const marketOpen = isMarketOpen(new Date());
  // closed market: closes don't change — one pass per 20 min is plenty. open: a slice every call.
  const minGap = marketOpen ? 20000 : 20 * 60000;
  if (Date.now() - state.quotesAt < minGap && Object.keys(state.quotes).length >= TOKENS.length) return;
  const cold = Object.keys(state.quotes).length === 0;
  const per = cold ? (key ? 55 : TOKENS.length) : (key ? 45 : 24); // cold start: fill the table; after that stay well under 60/min on Finnhub, polite to Yahoo
  const syms = TOKENS.map(t => t.sym);
  const batch = [];
  for (let k = 0; k < per && k < syms.length; k++) batch.push(syms[(state.cursor + k) % syms.length]);
  state.cursor = (state.cursor + per) % syms.length;
  await Promise.all(batch.map(async sym => {
    try { state.quotes[sym] = await (key ? quoteFinnhub(sym, key) : quoteYahoo(sym)); }
    catch (e) { /* keep the previous quote */ }
  }));
  state.quotesAt = Date.now();
}

// ---------------------------------------------------------------- NYSE hours (America/New_York), 2026 holidays
const HOLIDAYS = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'];
function nyParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; f.formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { wd: p.weekday, ymd: `${p.year}-${p.month}-${p.day}`, mins: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}
function isMarketOpen(d) {
  const p = nyParts(d);
  if (p.wd === 'Sat' || p.wd === 'Sun' || HOLIDAYS.includes(p.ymd)) return false;
  return p.mins >= 9 * 60 + 30 && p.mins < 16 * 60;
}
function num(x) { const n = Number(x); return isFinite(n) ? n : null; }

module.exports = async (req, res) => {
  try {
    await Promise.all([refreshChain(), refreshQuotes()]);
    const now = new Date();
    const rows = TOKENS.map(t => {
      const c = state.chain[t.addr.toLowerCase()] || {};
      const q = state.quotes[t.sym] || null;
      const gap = c.price && q && q.last ? (c.price / q.last - 1) * 100 : null;
      return { sym: t.sym, name: t.name, etf: !!t.etf, addr: t.addr, img: c.img || null, onchain: c.price ?? null, market: q ? q.last : null, prevClose: q ? q.prevClose : null, quotedAt: q ? q.at : null, quoteSrc: q ? q.src : null, gap, vol24: c.vol24 ?? null, liq: c.liq ?? null, chg: c.chg || null, tx: c.tx || null, pool: c.pool || null };
    });
    res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ at: now.toISOString(), marketOpen: isMarketOpen(now), chainAt: state.chainAt, quotesAt: state.quotesAt, quoteSource: process.env.FINNHUB_KEY ? 'finnhub' : 'yahoo', rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
