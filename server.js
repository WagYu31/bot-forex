// Bypass SSL verification (ISP intercepts SSL certificates)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3030;

// Custom fetch with SSL bypass
function fetchUrl(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timeout'));
        }, timeout);

        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            rejectUnauthorized: false,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Parse error: ${data.substring(0, 100)}`));
                }
            });
        });
        req.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}

// Serve static files
app.use(express.static(__dirname));

// ==========================================
// Market Configurations
// ==========================================
const MARKET_CONFIG = {
    'XAUUSD': {
        label: 'XAU/USD (Gold)',
        priceApis: [
            {
                name: 'Yahoo Finance (XAU/USD Spot)',
                url: 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 1000) ? price : null;
                }
            },
            {
                name: 'Yahoo Finance v2 (XAU/USD)',
                url: 'https://query2.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 1000) ? price : null;
                }
            },
            {
                name: 'Yahoo Finance (Gold Futures)',
                url: 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 1000) ? price : null;
                }
            },
            {
                name: 'Metals.live',
                url: 'https://api.metals.live/v1/spot',
                parse: (data) => {
                    const gold = data.find(m => m.gold !== undefined);
                    return gold ? gold.gold : null;
                }
            }
        ],
        candleSymbols: [
            { sym: 'XAUUSD=X', name: 'XAU/USD Spot' },
            { sym: 'GC=F', name: 'Gold Futures' }
        ],
        minPrice: 1000
    },
    'BTCUSD': {
        label: 'BTC/USD (Bitcoin)',
        priceApis: [
            {
                name: 'Yahoo Finance (BTC-USD)',
                url: 'https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 100) ? price : null;
                }
            },
            {
                name: 'Yahoo Finance v2 (BTC-USD)',
                url: 'https://query2.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 100) ? price : null;
                }
            },
            {
                name: 'CoinGecko (Bitcoin)',
                url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
                parse: (data) => {
                    return data?.bitcoin?.usd || null;
                }
            }
        ],
        candleSymbols: [
            { sym: 'BTC-USD', name: 'BTC/USD (Yahoo)' }
        ],
        minPrice: 100
    },
    'DXY': {
        label: 'DXY (US Dollar Index)',
        priceApis: [
            {
                name: 'Yahoo Finance (DX-Y.NYB)',
                url: 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 80) ? price : null;
                }
            },
            {
                name: 'Yahoo Finance v2 (DX-Y.NYB)',
                url: 'https://query2.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1m&range=1d',
                parse: (data) => {
                    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                    return (price && price > 80) ? price : null;
                }
            }
        ],
        candleSymbols: [
            { sym: 'DX-Y.NYB', name: 'DXY (Dollar Index)' }
        ],
        minPrice: 80
    }
};

// ==========================================
// Multi-Market Price API
// ==========================================
async function fetchMarketPrice(market, res) {
    const config = MARKET_CONFIG[market];
    if (!config) {
        return res.json({ success: false, error: `Unknown market: ${market}` });
    }

    for (const api of config.priceApis) {
        try {
            const data = await fetchUrl(api.url, 8000);
            const price = api.parse(data);

            if (price && price > config.minPrice) {
                console.log(`✅ [${market}] ${api.name}: $${price.toFixed(2)}`);
                return res.json({
                    success: true,
                    price: price,
                    market: market,
                    source: api.name,
                    timestamp: Date.now()
                });
            } else {
                console.warn(`⚠️  [${market}] ${api.name}: no valid price`);
            }
        } catch (e) {
            console.warn(`⚠️  [${market}] ${api.name} gagal: ${e.message}`);
        }
    }

    res.json({ success: false, error: `All ${market} APIs failed` });
}

async function fetchMarketCandles(market, tf, range, res) {
    const config = MARKET_CONFIG[market];
    if (!config) {
        return res.json({ success: false, error: `Unknown market: ${market}` });
    }

    const interval = tf + 'm';

    for (const { sym, name } of config.candleSymbols) {
        try {
            const data = await fetchUrl(
                `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`,
                10000
            );
            const result = data?.chart?.result?.[0];

            if (result && result.timestamp) {
                const quotes = result.indicators.quote[0];
                const candles = result.timestamp.map((t, i) => ({
                    time: t * 1000,
                    open: quotes.open[i] || null,
                    high: quotes.high[i] || null,
                    low: quotes.low[i] || null,
                    close: quotes.close[i] || null,
                    volume: quotes.volume[i] || 0
                })).filter(c => c.open && c.high && c.low && c.close);

                console.log(`📊 [${market}] ${name}: ${candles.length} candles (${interval})`);
                return res.json({ success: true, candles, market, source: name });
            }
        } catch (e) {
            console.warn(`⚠️  [${market}] ${name} candles gagal: ${e.message}`);
        }
    }

    res.json({ success: false, error: `Failed to fetch ${market} candles` });
}

// New multi-market endpoints
app.get('/api/price', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const market = (req.query.market || 'XAUUSD').toUpperCase();
    await fetchMarketPrice(market, res);
});

// DXY dedicated endpoint (fast)
app.get('/api/dxy', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    await fetchMarketPrice('DXY', res);
});

app.get('/api/candles', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const market = (req.query.market || 'XAUUSD').toUpperCase();
    const tf = req.query.tf || '15';
    const range = req.query.range || '2d';
    await fetchMarketCandles(market, tf, range, res);
});

// Backward-compatible aliases
app.get('/api/gold-price', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    await fetchMarketPrice('XAUUSD', res);
});

app.get('/api/gold-candles', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    const tf = req.query.tf || '15';
    const range = req.query.range || '2d';
    const market = req.query.market || 'XAUUSD';
    await fetchMarketCandles(market, tf, range, res);
});

// ==========================================
// Signal API for EA (Expert Advisor)
// ==========================================
let currentSignal = {
    direction: 'NEUTRAL',
    entry: 0,
    tp1: 0,
    tp2: 0,
    sl: 0,
    confidence: 0,
    lot: 0.01,
    timestamp: 0,
    executed: false
};

app.use(express.json());

// EA polls this to get current signal
app.get('/api/signal', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(currentSignal);
});

// Frontend pushes signal updates here
app.post('/api/signal', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { direction, entry, tp1, tp2, sl, confidence, lot } = req.body;
    if (direction) {
        currentSignal = {
            direction,
            entry: entry || 0,
            tp1: tp1 || 0,
            tp2: tp2 || 0,
            sl: sl || 0,
            confidence: confidence || 0,
            lot: lot || 0.01,
            timestamp: Date.now(),
            executed: false
        };
        console.log(`📡 Signal updated: ${direction} @ ${entry?.toFixed(2)} | TP: ${tp1?.toFixed(2)} | SL: ${sl?.toFixed(2)}`);
    }
    res.json({ success: true });
});

// EA reports trade execution
app.post('/api/signal/executed', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    currentSignal.executed = true;
    console.log(`✅ EA executed: ${currentSignal.direction}`);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║       BOT FOREX WAGYU — Local Server         ║
║       SSL Bypass: ENABLED                    ║
╠══════════════════════════════════════════════╣
║  Dashboard: http://localhost:${PORT}            ║
║  Gold API:  http://localhost:${PORT}/api/gold-price  ║
║  Candles:   http://localhost:${PORT}/api/gold-candles ║
╚══════════════════════════════════════════════╝
    `);
});
