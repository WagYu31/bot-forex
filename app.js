/* ============================================
   BOT FOREX WAGYU — XAU/USD Signal Dashboard
   Core Application Logic
   With MetaAPI MT4/MT5 Integration
   ============================================ */

// ==========================================
// Configuration & State
// ==========================================
const CONFIG = {
    pair: 'XAU/USD',
    symbol: 'XAUUSD',
    updateInterval: 5000,
    historyMax: 50,
    alertsMax: 30,
    basePrice: 5170,
    contractSize: 100, // 1 lot = 100 oz for gold
    metaApiBaseUrl: 'https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai',
    decimals: 2,
};

const MARKETS = {
    'XAUUSD': {
        pair: 'XAU/USD', symbol: 'XAUUSD', basePrice: 5170,
        icon: '🥇', label: 'Gold Spot', contractSize: 100,
        tvSymbol: 'OANDA:XAUUSD', decimals: 2,
        yahooSymbol: 'XAUUSD=X'
    },
    'BTCUSD': {
        pair: 'BTC/USD', symbol: 'BTCUSD', basePrice: 84000,
        icon: '₿', label: 'Bitcoin', contractSize: 1,
        tvSymbol: 'BINANCE:BTCUSDT', decimals: 2,
        yahooSymbol: 'BTC-USD'
    }
};

let state = {
    capital: 1000,
    riskPercent: 2,
    targetProfit: 5,
    currentPrice: 0,
    previousPrice: 0,
    priceHistory: [],
    signals: [],
    alerts: [],
    todayProfit: 0,
    totalTrades: 0,
    winTrades: 0,
    currentTF: '15',
    scalpingTF: '1',
    isConnected: false,
    lastSignal: null,
    currentMarket: 'XAUUSD',
    // MT4/MT5 Connection
    dataSource: 'simulation', // 'simulation' | 'metaapi'
    metaApiToken: '',
    mt4AccountId: '',
    mt4Deployed: false,
    autoTradeEnabled: false, // Toggle for auto-trade
    mt4PositionId: null, // Current real MT4 position ID
    autoTradeLot: 0.01, // Default lot size for demo
};

// ==========================================
// MetaAPI MT4/MT5 Connection Manager
// ==========================================
class MetaApiManager {
    constructor() {
        this.token = '';
        this.accountId = '';
        this.baseUrl = CONFIG.metaApiBaseUrl;
        this.connected = false;
        this.ws = null;
    }

    setCredentials(token, accountId) {
        this.token = token;
        this.accountId = accountId;
    }

    getHeaders() {
        return {
            'auth-token': this.token,
            'Content-Type': 'application/json'
        };
    }

    // Deploy the MT4/MT5 account (make it ready)
    async deployAccount() {
        try {
            const resp = await fetch(
                `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${this.accountId}/deploy`,
                { method: 'POST', headers: this.getHeaders() }
            );
            if (resp.ok || resp.status === 204) {
                state.mt4Deployed = true;
                return true;
            }
            // Already deployed is fine
            if (resp.status === 409) {
                state.mt4Deployed = true;
                return true;
            }
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.message || `Deploy failed: ${resp.status}`);
        } catch (e) {
            console.error('Deploy error:', e);
            throw e;
        }
    }

    // Get account info
    async getAccountInfo() {
        const resp = await fetch(
            `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${this.accountId}`,
            { headers: this.getHeaders() }
        );
        if (!resp.ok) throw new Error(`Account info failed: ${resp.status}`);
        return resp.json();
    }

    // Wait for account to be ready (DEPLOYED state)
    async waitForConnection(maxWait = 60000) {
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            try {
                const info = await this.getAccountInfo();
                if (info.state === 'DEPLOYED' && info.connectionStatus === 'CONNECTED') {
                    return true;
                }
                if (info.state === 'DEPLOYED') {
                    // Account deployed but not yet connected, wait a bit
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
            } catch (e) {
                // Server might return error while deploying
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        // If we reach here, could still work for price queries
        return true;
    }

    // Get current price tick from MT4/MT5
    async getCurrentPrice() {
        try {
            const resp = await fetch(
                `${this.baseUrl}/users/current/accounts/${this.accountId}/symbols/${CONFIG.symbol}/current-price`,
                { headers: this.getHeaders() }
            );
            if (!resp.ok) throw new Error(`Price fetch failed: ${resp.status}`);
            const data = await resp.json();
            return {
                bid: data.bid,
                ask: data.ask,
                price: (data.bid + data.ask) / 2,
                spread: data.ask - data.bid,
                time: data.time || new Date().toISOString()
            };
        } catch (e) {
            console.error('Price fetch error:', e);
            return null;
        }
    }

    // Get historical candles from MT4/MT5
    async getCandles(timeframe = '15m', limit = 100) {
        try {
            const startTime = new Date(Date.now() - limit * this.tfToMs(timeframe)).toISOString();
            const resp = await fetch(
                `${this.baseUrl}/users/current/accounts/${this.accountId}/historical-market-data/symbols/${CONFIG.symbol}/timeframes/${timeframe}/candles?startTime=${startTime}&limit=${limit}`,
                { headers: this.getHeaders() }
            );
            if (!resp.ok) throw new Error(`Candles fetch failed: ${resp.status}`);
            const data = await resp.json();
            return data.map(c => ({
                time: new Date(c.time).getTime(),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.tickVolume || c.volume || 0
            }));
        } catch (e) {
            console.error('Candles fetch error:', e);
            return null;
        }
    }

    tfToMs(tf) {
        const map = {
            '1m': 60000, '5m': 300000, '15m': 900000,
            '30m': 1800000, '1h': 3600000, '4h': 14400000,
            '1d': 86400000
        };
        return map[tf] || 900000;
    }

    // Get account positions (open trades)
    async getPositions() {
        try {
            const resp = await fetch(
                `${this.baseUrl}/users/current/accounts/${this.accountId}/positions`,
                { headers: this.getHeaders() }
            );
            if (!resp.ok) return [];
            return resp.json();
        } catch (e) {
            return [];
        }
    }

    // Start real-time streaming via WebSocket
    startStreaming(onPrice) {
        if (this.ws) this.ws.close();

        const wsUrl = `wss://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/ws`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            // Subscribe to price updates
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                accountId: this.accountId,
                symbol: CONFIG.symbol,
                authToken: this.token
            }));
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'prices' || data.type === 'price') {
                    onPrice(data);
                }
            } catch (e) { }
        };

        this.ws.onerror = (e) => {
            console.log('WebSocket error, falling back to polling');
        };

        this.ws.onclose = () => {
            console.log('WebSocket closed');
        };
    }

    // ── Auto-Trade Methods ──

    // Open a real trade on MT4/MT5
    async openTrade(type, volume, sl, tp) {
        try {
            const actionType = type === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
            const body = {
                actionType: actionType,
                symbol: CONFIG.symbol,
                volume: volume || 0.01,
            };
            // Only add SL/TP if valid
            if (sl && sl > 0) body.stopLoss = parseFloat(sl.toFixed(2));
            if (tp && tp > 0) body.takeProfit = parseFloat(tp.toFixed(2));

            console.log(`🔥 [TRADE] Opening ${type} ${body.volume} lot | SL: ${sl?.toFixed(2)} | TP: ${tp?.toFixed(2)}`);

            const resp = await fetch(
                `${this.baseUrl}/users/current/accounts/${this.accountId}/trade`,
                {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                }
            );

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.message || `Trade failed: ${resp.status}`);
            }

            const result = await resp.json();
            console.log('✅ [TRADE] Position opened:', result);
            return result;
        } catch (e) {
            console.error('❌ [TRADE] Open error:', e);
            return null;
        }
    }

    // Close a specific position
    async closeTrade(positionId) {
        try {
            console.log(`🔄 [TRADE] Closing position ${positionId}`);
            const body = {
                actionType: 'POSITION_CLOSE_ID',
                positionId: positionId
            };

            const resp = await fetch(
                `${this.baseUrl}/users/current/accounts/${this.accountId}/trade`,
                {
                    method: 'POST',
                    headers: this.getHeaders(),
                    body: JSON.stringify(body)
                }
            );

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.message || `Close failed: ${resp.status}`);
            }

            const result = await resp.json();
            console.log('✅ [TRADE] Position closed:', result);
            return result;
        } catch (e) {
            console.error('❌ [TRADE] Close error:', e);
            return null;
        }
    }

    // Emergency: close ALL positions
    async closeAllTrades() {
        try {
            const positions = await this.getPositions();
            if (!positions || positions.length === 0) return true;

            console.log(`⚠️ [TRADE] Closing all ${positions.length} positions`);
            for (const pos of positions) {
                await this.closeTrade(pos.id);
            }
            return true;
        } catch (e) {
            console.error('❌ [TRADE] Close all error:', e);
            return false;
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
}

// ==========================================
// Real-Time Price Feed (Multiple API Sources)
// ==========================================
class RealTimePriceFeed {
    constructor() {
        this.lastRealPrice = null;
        this.isLocal = true; // Always use server API proxy (works on localhost and hosted)
        this.apiSources = [];
        this.buildSources();
    }

    buildSources() {
        this.apiSources = [];
        const market = state.currentMarket || 'XAUUSD';

        // Local proxy (no CORS issues) — only when running via server.js
        if (this.isLocal) {
            this.apiSources.push({
                name: 'Local Proxy',
                fetch: async () => {
                    const resp = await this.fetchWithTimeout(`/api/price?market=${market}`, 5000);
                    const data = await resp.json();
                    if (data.success && data.price > 0) {
                        console.log(`   ↳ Sumber: ${data.source}`);
                        return data.price;
                    }
                    throw new Error('Proxy failed');
                }
            });
        }

        // Direct external APIs (may fail due to CORS on file://)
        const yahooSym = MARKETS[market]?.yahooSymbol || 'XAUUSD=X';
        this.apiSources.push({
            name: 'Yahoo Finance',
            fetch: async () => {
                const resp = await this.fetchWithTimeout(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1m&range=1d`,
                    5000
                );
                const data = await resp.json();
                const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
                if (price && price > 0) return price;
                throw new Error('No Yahoo data');
            }
        });
    }

    fetchWithTimeout(url, timeout = 5000) {
        return Promise.race([
            fetch(url),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), timeout)
            )
        ]);
    }

    async fetchRealPrice() {
        for (const source of this.apiSources) {
            try {
                const price = await source.fetch();
                if (price && price > 0) {
                    this.lastRealPrice = price;
                    console.log(`✅ Harga real dari ${source.name}: $${price}`);
                    return price;
                }
            } catch (e) {
                console.warn(`⚠️ ${source.name} gagal:`, e.message);
            }
        }
        console.warn('❌ Semua API gagal, menggunakan simulasi');
        return null;
    }

    async fetchRealCandles(tf = '15') {
        if (!this.isLocal) return null;
        const market = state.currentMarket || 'XAUUSD';
        try {
            const resp = await this.fetchWithTimeout(`/api/candles?market=${market}&tf=${tf}&range=2d`, 10000);
            const data = await resp.json();
            if (data.success && data.candles && data.candles.length > 10) {
                console.log(`📊 Loaded ${data.candles.length} candles nyata dari ${data.source}`);
                return data.candles;
            }
        } catch (e) {
            console.warn('⚠️ Gagal load candle history:', e.message);
        }
        return null;
    }
}


// ==========================================
// Price Engine (Simulation Fallback)
// ==========================================
class PriceEngine {
    constructor() {
        this.basePrice = CONFIG.basePrice;
        this.trend = 0;
        this.volatility = 0.5;
        this.momentum = 0;
        this.cycle = 0;
        this.realFeed = new RealTimePriceFeed();
        this.useRealData = false;
        this.lastFetchTime = 0;
        this.fetchInterval = 10000; // fetch every 10s
    }

    async syncWithRealPrice() {
        const realPrice = await this.realFeed.fetchRealPrice();
        if (realPrice) {
            this.basePrice = realPrice;
            CONFIG.basePrice = realPrice;
            this.useRealData = true;
            state.dataSource = 'realapi';
            return realPrice;
        }
        return null;
    }

    async getPrice() {
        const now = Date.now();
        if (now - this.lastFetchTime > this.fetchInterval) {
            this.lastFetchTime = now;
            const realPrice = await this.realFeed.fetchRealPrice();
            if (realPrice) {
                this.useRealData = true;
                state.dataSource = 'realapi';
                // Small variance around real price for micro-movements
                const microMove = (Math.random() - 0.5) * 0.8;
                this.basePrice = realPrice;
                return Math.round((realPrice + microMove) * 100) / 100;
            }
        }
        // Fallback: simulation from last known price
        return this.generateRealisticPrice();
    }

    generateRealisticPrice() {
        this.cycle += 0.02;
        if (Math.random() < 0.01) {
            this.trend = (Math.random() - 0.5) * 3.5;
        }
        this.momentum = this.momentum * 0.98 + this.trend * 0.02;
        const cyclical = Math.sin(this.cycle) * 5 + Math.sin(this.cycle * 2.7) * 2.5;
        const noise = (Math.random() - 0.5) * this.volatility * 3.5;
        const reversion = (CONFIG.basePrice - this.basePrice) * 0.001;
        this.basePrice += this.momentum + noise + reversion;
        return Math.round((this.basePrice + cyclical) * 100) / 100;
    }

    generateHistoricalData(periods = 100) {
        const data = [];
        let tempPrice = this.basePrice - 30 + (Math.random() * 60);
        let tempCycle = 0;
        for (let i = 0; i < periods; i++) {
            tempCycle += 0.05;
            const change = (Math.random() - 0.5) * 2.5 + Math.sin(tempCycle) * 0.5;
            tempPrice += change;
            data.push({
                time: Date.now() - (periods - i) * 60000 * 15,
                open: Math.round((tempPrice + (Math.random() - 0.5) * 1.5) * 100) / 100,
                high: Math.round((tempPrice + Math.random() * 3.5) * 100) / 100,
                low: Math.round((tempPrice - Math.random() * 3.5) * 100) / 100,
                close: Math.round((tempPrice + (Math.random() - 0.5) * 1.5) * 100) / 100,
                volume: Math.floor(Math.random() * 10000 + 5000)
            });
        }
        return data;
    }
}

// ==========================================
// Technical Indicators
// ==========================================
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    static EMA(data, period) {
        if (data.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }
        return ema;
    }

    static RSI(closes, period = 14) {
        if (closes.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = closes.length - period; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];
            if (change >= 0) gains += change;
            else losses += Math.abs(change);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    static MACD(closes, fast = 12, slow = 26, signal = 9) {
        if (closes.length < slow + signal) return null;
        const emaFast = this.EMA(closes, fast);
        const emaSlow = this.EMA(closes, slow);
        const macdLine = emaFast - emaSlow;
        const macdHistory = [];
        for (let i = slow; i <= closes.length; i++) {
            const ef = this.EMA(closes.slice(0, i), fast);
            const es = this.EMA(closes.slice(0, i), slow);
            if (ef !== null && es !== null) macdHistory.push(ef - es);
        }
        const signalLine = macdHistory.length >= signal ?
            this.EMA(macdHistory, signal) : macdLine;
        return {
            macd: Math.round(macdLine * 100) / 100,
            signal: Math.round(signalLine * 100) / 100,
            histogram: Math.round((macdLine - signalLine) * 100) / 100
        };
    }

    static BollingerBands(closes, period = 20, stdDev = 2) {
        if (closes.length < period) return null;
        const sma = this.SMA(closes, period);
        const slice = closes.slice(-period);
        const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
        const sd = Math.sqrt(variance);
        return {
            upper: Math.round((sma + stdDev * sd) * 100) / 100,
            middle: Math.round(sma * 100) / 100,
            lower: Math.round((sma - stdDev * sd) * 100) / 100,
            bandwidth: Math.round((2 * stdDev * sd / sma) * 10000) / 100
        };
    }

    static Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
        if (closes.length < kPeriod) return null;
        const recentHighs = highs.slice(-kPeriod);
        const recentLows = lows.slice(-kPeriod);
        const highestHigh = Math.max(...recentHighs);
        const lowestLow = Math.min(...recentLows);
        const currentClose = closes[closes.length - 1];
        const k = ((currentClose - lowestLow) / (highestHigh - lowestLow || 1)) * 100;
        const kValues = [];
        for (let i = Math.max(0, closes.length - dPeriod * 2); i < closes.length; i++) {
            const h = highs.slice(Math.max(0, i - kPeriod + 1), i + 1);
            const l = lows.slice(Math.max(0, i - kPeriod + 1), i + 1);
            const hh = Math.max(...h);
            const ll = Math.min(...l);
            kValues.push(((closes[i] - ll) / (hh - ll || 1)) * 100);
        }
        const d = kValues.length >= dPeriod ?
            kValues.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod : k;
        return { k: Math.round(k * 100) / 100, d: Math.round(d * 100) / 100 };
    }

    static ATR(highs, lows, closes, period = 14) {
        if (closes.length < period + 1) return null;
        let atr = 0;
        const start = closes.length - period;
        for (let i = start; i < closes.length; i++) {
            atr += Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
        }
        return Math.round((atr / period) * 100) / 100;
    }

    static PivotPoints(high, low, close) {
        const pivot = (high + low + close) / 3;
        return {
            r2: Math.round((pivot + (high - low)) * 100) / 100,
            r1: Math.round((2 * pivot - low) * 100) / 100,
            pivot: Math.round(pivot * 100) / 100,
            s1: Math.round((2 * pivot - high) * 100) / 100,
            s2: Math.round((pivot - (high - low)) * 100) / 100,
        };
    }

    // ====== ADVANCED TECHNIQUES ======

    // ADX — Average Directional Index (Trend Following)
    static ADX(highs, lows, closes, period = 14) {
        if (closes.length < period * 2 + 1) return null;
        const plusDM = [], minusDM = [], tr = [];
        for (let i = 1; i < closes.length; i++) {
            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
        }
        // Smooth with EMA
        const smoothPlusDM = this._smooth(plusDM, period);
        const smoothMinusDM = this._smooth(minusDM, period);
        const smoothTR = this._smooth(tr, period);
        if (!smoothPlusDM || !smoothTR || smoothTR === 0) return null;
        const plusDI = (smoothPlusDM / smoothTR) * 100;
        const minusDI = (smoothMinusDM / smoothTR) * 100;
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
        // ADX is smoothed DX — simplified as recent DX average
        const dxArr = [];
        for (let i = period; i < tr.length; i++) {
            const sp = this._smooth(plusDM.slice(0, i + 1), period);
            const sm = this._smooth(minusDM.slice(0, i + 1), period);
            const st = this._smooth(tr.slice(0, i + 1), period);
            if (st > 0) {
                const pdi = (sp / st) * 100;
                const mdi = (sm / st) * 100;
                dxArr.push(Math.abs(pdi - mdi) / (pdi + mdi || 1) * 100);
            }
        }
        const adx = dxArr.length >= period ? dxArr.slice(-period).reduce((s, v) => s + v, 0) / period : dx;
        return {
            adx: Math.round(adx * 100) / 100,
            plusDI: Math.round(plusDI * 100) / 100,
            minusDI: Math.round(minusDI * 100) / 100,
            trend: adx > 25 ? (plusDI > minusDI ? 'UPTREND' : 'DOWNTREND') : 'SIDEWAYS'
        };
    }

    static _smooth(data, period) {
        if (data.length < period) return null;
        let sum = data.slice(0, period).reduce((s, v) => s + v, 0);
        for (let i = period; i < data.length; i++) {
            sum = sum - sum / period + data[i];
        }
        return sum / period;
    }

    // Price Action — Candlestick Pattern Recognition
    static CandlestickPatterns(candles) {
        if (candles.length < 3) return { patterns: [], signal: 'NEUTRAL' };
        const patterns = [];
        const n = candles.length;
        const c = candles[n - 1]; // current candle
        const p = candles[n - 2]; // previous candle
        const pp = candles[n - 3]; // 2 candles ago
        const bodySize = Math.abs(c.close - c.open);
        const candleRange = c.high - c.low;
        const upperShadow = c.high - Math.max(c.open, c.close);
        const lowerShadow = Math.min(c.open, c.close) - c.low;
        const isBullish = c.close > c.open;
        const isBearish = c.close < c.open;
        const pBodySize = Math.abs(p.close - p.open);
        const pIsBullish = p.close > p.open;
        const pIsBearish = p.close < p.open;

        // Doji — indecision
        if (bodySize < candleRange * 0.1 && candleRange > 0) {
            patterns.push({ name: 'Doji', type: 'reversal', signal: 'NEUTRAL', emoji: '✖️' });
        }

        // Hammer (bullish reversal) — small body at top, long lower shadow
        if (lowerShadow > bodySize * 2 && upperShadow < bodySize * 0.5 && bodySize > 0) {
            patterns.push({ name: 'Hammer', type: 'bullish', signal: 'BUY', emoji: '🔨' });
        }

        // Shooting Star (bearish reversal) — small body at bottom, long upper shadow
        if (upperShadow > bodySize * 2 && lowerShadow < bodySize * 0.5 && bodySize > 0) {
            patterns.push({ name: 'Shooting Star', type: 'bearish', signal: 'SELL', emoji: '🌠' });
        }

        // Bullish Engulfing
        if (isBullish && pIsBearish && c.open <= p.close && c.close >= p.open && bodySize > pBodySize) {
            patterns.push({ name: 'Bullish Engulfing', type: 'bullish', signal: 'BUY', emoji: '🟢' });
        }

        // Bearish Engulfing
        if (isBearish && pIsBullish && c.open >= p.close && c.close <= p.open && bodySize > pBodySize) {
            patterns.push({ name: 'Bearish Engulfing', type: 'bearish', signal: 'SELL', emoji: '🔴' });
        }

        // Morning Star (3-candle bullish reversal)
        const ppIsBearish = pp.close < pp.open;
        const ppBodySize = Math.abs(pp.close - pp.open);
        if (ppIsBearish && ppBodySize > candleRange * 0.3 &&
            pBodySize < ppBodySize * 0.3 &&
            isBullish && bodySize > ppBodySize * 0.5) {
            patterns.push({ name: 'Morning Star', type: 'bullish', signal: 'BUY', emoji: '⭐' });
        }

        // Evening Star (3-candle bearish reversal)
        const ppIsBullish2 = pp.close > pp.open;
        if (ppIsBullish2 && ppBodySize > candleRange * 0.3 &&
            pBodySize < ppBodySize * 0.3 &&
            isBearish && bodySize > ppBodySize * 0.5) {
            patterns.push({ name: 'Evening Star', type: 'bearish', signal: 'SELL', emoji: '🌙' });
        }

        // Pin Bar (long wick rejection)
        if (candleRange > 0 && (lowerShadow > candleRange * 0.6 || upperShadow > candleRange * 0.6)) {
            if (lowerShadow > upperShadow) {
                patterns.push({ name: 'Pin Bar (Bull)', type: 'bullish', signal: 'BUY', emoji: '📌' });
            } else {
                patterns.push({ name: 'Pin Bar (Bear)', type: 'bearish', signal: 'SELL', emoji: '📌' });
            }
        }

        // Overall signal from patterns
        let bullCount = 0, bearCount = 0;
        patterns.forEach(p => {
            if (p.signal === 'BUY') bullCount++;
            if (p.signal === 'SELL') bearCount++;
        });
        const signal = bullCount > bearCount ? 'BUY' : bearCount > bullCount ? 'SELL' : 'NEUTRAL';

        return { patterns, signal, bullCount, bearCount };
    }

    // Breakout Detection — price breaking through S/R levels
    static BreakoutDetection(candles, period = 20) {
        if (candles.length < period + 1) return null;
        const recent = candles.slice(-(period + 1));
        const lookback = recent.slice(0, -1);
        const current = recent[recent.length - 1];

        const resistanceLevel = Math.max(...lookback.map(c => c.high));
        const supportLevel = Math.min(...lookback.map(c => c.low));
        const range = resistanceLevel - supportLevel;

        let breakout = 'NONE';
        let strength = 0;

        // Bullish breakout — close above resistance
        if (current.close > resistanceLevel) {
            breakout = 'BULLISH_BREAKOUT';
            strength = ((current.close - resistanceLevel) / range) * 100;
        }
        // Bearish breakout — close below support
        else if (current.close < supportLevel) {
            breakout = 'BEARISH_BREAKOUT';
            strength = ((supportLevel - current.close) / range) * 100;
        }
        // Near resistance — potential rejection or breakout
        else if (current.high > resistanceLevel * 0.998) {
            breakout = 'TESTING_RESISTANCE';
            strength = 30;
        }
        // Near support
        else if (current.low < supportLevel * 1.002) {
            breakout = 'TESTING_SUPPORT';
            strength = 30;
        }

        return {
            breakout,
            strength: Math.min(100, Math.round(strength * 100) / 100),
            resistance: Math.round(resistanceLevel * 100) / 100,
            support: Math.round(supportLevel * 100) / 100,
            range: Math.round(range * 100) / 100
        };
    }

    // Fibonacci Retracement Levels
    static FibonacciLevels(candles, period = 50) {
        if (candles.length < period) return null;
        const recent = candles.slice(-period);
        const high = Math.max(...recent.map(c => c.high));
        const low = Math.min(...recent.map(c => c.low));
        const diff = high - low;
        return {
            level_0: Math.round(high * 100) / 100,
            level_236: Math.round((high - diff * 0.236) * 100) / 100,
            level_382: Math.round((high - diff * 0.382) * 100) / 100,
            level_500: Math.round((high - diff * 0.500) * 100) / 100,
            level_618: Math.round((high - diff * 0.618) * 100) / 100,
            level_786: Math.round((high - diff * 0.786) * 100) / 100,
            level_1: Math.round(low * 100) / 100
        };
    }
}

// ==========================================
// Scalping Engine — Fast Entry/Exit Signals
// ==========================================
class ScalpingEngine {
    constructor() {
        this.position = null; // { type: 'BUY'|'SELL', entry, tp1, tp2, sl, openTime }
        this.history = [];
        this.prevSignal = 'WAIT';
        this.cooldownUntil = 0; // timestamp — prevent signal spam
        this.prevPrices = [];   // Track last N prices for momentum spike detection
        this.lastReversalAlert = 0;
        this.reversalState = null; // { type: 'UP'|'DOWN', strength, against }
    }

    analyze(priceData) {
        if (!priceData || priceData.length < 25) return null;

        const closes = priceData.map(d => d.close);
        const highs = priceData.map(d => d.high);
        const lows = priceData.map(d => d.low);
        const currentPrice = closes[closes.length - 1];
        const now = Date.now();

        // Fast-period indicators for scalping
        const result = {
            indicators: {},
            signal: 'WAIT',
            action: 'MENUNGGU',
            subText: 'Analisis pasar...',
            confidence: 0,
            entry: null,
            tp1: null,
            tp2: null,
            sl: null,
            rrRatio: null,
            pipsTP: null,
            pipsSL: null,
            timestamp: new Date()
        };

        let buyScore = 0, sellScore = 0;

        // 1. RSI — Adaptive period based on timeframe
        const rsiPeriod = (state.currentTF === '1' || state.currentTF === '5') ? 9 : 14;
        const rsiVal = TechnicalIndicators.RSI(closes, rsiPeriod);
        if (rsiVal !== null) {
            result.indicators.rsi = { value: Math.round(rsiVal * 100) / 100, period: rsiPeriod };
            if (rsiVal < 20) { result.indicators.rsi.signal = 'BUY'; buyScore += 3; }
            else if (rsiVal < 30) { result.indicators.rsi.signal = 'BUY'; buyScore += 2; }
            else if (rsiVal > 80) { result.indicators.rsi.signal = 'SELL'; sellScore += 3; }
            else if (rsiVal > 70) { result.indicators.rsi.signal = 'SELL'; sellScore += 2; }
            else if (rsiVal < 40) { result.indicators.rsi.signal = 'BUY'; buyScore += 1; }
            else if (rsiVal > 60) { result.indicators.rsi.signal = 'SELL'; sellScore += 1; }
            else { result.indicators.rsi.signal = 'NEUTRAL'; }
        }

        // 2. Stochastic (5, 3) — Fast Stochastic
        const stoch = TechnicalIndicators.Stochastic(highs, lows, closes, 5, 3);
        if (stoch !== null) {
            result.indicators.stoch = { value: Math.round(stoch.k * 100) / 100 };
            const kAboveD = stoch.k > stoch.d;
            if (stoch.k < 20 && kAboveD) { result.indicators.stoch.signal = 'BUY'; buyScore += 3; }
            else if (stoch.k < 30) { result.indicators.stoch.signal = 'BUY'; buyScore += 1; }
            else if (stoch.k > 80 && !kAboveD) { result.indicators.stoch.signal = 'SELL'; sellScore += 3; }
            else if (stoch.k > 70) { result.indicators.stoch.signal = 'SELL'; sellScore += 1; }
            else { result.indicators.stoch.signal = 'NEUTRAL'; }
        }

        // 3. EMA 9/21 Crossover — the bread and butter of scalping
        const ema9 = TechnicalIndicators.EMA(closes, 9);
        const ema21 = TechnicalIndicators.EMA(closes, 21);
        if (ema9 !== null && ema21 !== null) {
            const spread = ema9 - ema21;
            const spreadAbs = Math.abs(spread);

            // Also check previous candle EMA for crossover detection
            const prevCloses = closes.slice(0, -1);
            const prevEma9 = TechnicalIndicators.EMA(prevCloses, 9);
            const prevEma21 = TechnicalIndicators.EMA(prevCloses, 21);

            result.indicators.ema = { value: spread > 0 ? 'Bullish' : 'Bearish' };

            if (prevEma9 !== null && prevEma21 !== null) {
                const prevSpread = prevEma9 - prevEma21;
                // Fresh crossover — strong signal
                if (prevSpread <= 0 && spread > 0) {
                    result.indicators.ema.signal = 'BUY';
                    result.indicators.ema.value = '↗ Cross Up';
                    buyScore += 3;
                } else if (prevSpread >= 0 && spread < 0) {
                    result.indicators.ema.signal = 'SELL';
                    result.indicators.ema.value = '↘ Cross Down';
                    sellScore += 3;
                } else if (spread > 0 && currentPrice > ema9) {
                    result.indicators.ema.signal = 'BUY';
                    buyScore += 1;
                } else if (spread < 0 && currentPrice < ema9) {
                    result.indicators.ema.signal = 'SELL';
                    sellScore += 1;
                } else {
                    result.indicators.ema.signal = 'NEUTRAL';
                }
            } else {
                result.indicators.ema.signal = spread > 0 ? 'BUY' : 'SELL';
                if (spread > 0) buyScore += 1; else sellScore += 1;
            }
        }

        // 4. Bollinger Band Touch/Breakout — mean reversion scalping
        const bb = TechnicalIndicators.BollingerBands(closes, 20, 2);
        if (bb !== null) {
            const bbRange = bb.upper - bb.lower;
            const position = bbRange > 0 ? (currentPrice - bb.lower) / bbRange : 0.5;
            result.indicators.bb = { value: (position * 100).toFixed(0) + '%' };

            if (currentPrice <= bb.lower * 1.001) {
                result.indicators.bb.signal = 'BUY';
                result.indicators.bb.value = 'Touch ↓';
                buyScore += 2;
            } else if (currentPrice >= bb.upper * 0.999) {
                result.indicators.bb.signal = 'SELL';
                result.indicators.bb.value = 'Touch ↑';
                sellScore += 2;
            } else if (position < 0.25) {
                result.indicators.bb.signal = 'BUY';
                buyScore += 1;
            } else if (position > 0.75) {
                result.indicators.bb.signal = 'SELL';
                sellScore += 1;
            } else {
                result.indicators.bb.signal = 'NEUTRAL';
                result.indicators.bb.value = 'Tengah';
            }
        }

        // 5. ATR for spread estimation & volatility
        const atr = TechnicalIndicators.ATR(highs, lows, closes, 7);
        const avgPrice = TechnicalIndicators.SMA(closes, 7) || currentPrice;
        const estimatedSpread = atr ? (atr * 0.1) : 0.5;
        result.indicators.spread = {
            value: estimatedSpread.toFixed(1),
            signal: estimatedSpread < 2.0 ? 'BUY' : estimatedSpread < 5.0 ? 'NEUTRAL' : 'SELL'
        };

        // ====== DETERMINE SCALPING SIGNAL ======
        const totalScore = buyScore + sellScore;
        const netScore = buyScore - sellScore;
        const minConfluence = 3; // Need at least 3 points to signal

        // Check cooldown
        if (now < this.cooldownUntil) {
            result.signal = 'WAIT';
            result.action = 'COOLDOWN';
            result.subText = 'Menunggu konfirmasi...';
            result.confidence = 0;
            return result;
        }

        // Calculate TP/SL based on ATR
        const atrVal = atr || 5;
        const tpPips1 = Math.round(atrVal * 0.5 * 10) / 10; // TP1 = 0.5x ATR
        const tpPips2 = Math.round(atrVal * 1.0 * 10) / 10; // TP2 = 1.0x ATR
        const slPips = Math.round(atrVal * 0.7 * 10) / 10;   // SL = 0.7x ATR

        if (this.position) {
            // ===== IN POSITION — Check for CLOSE signal =====
            const entryPrice = this.position.entry;
            const posType = this.position.type;
            const pnlPips = posType === 'BUY'
                ? (currentPrice - entryPrice)
                : (entryPrice - currentPrice);

            // Close conditions:
            // 1. Hit TP1 or TP2
            // 2. Hit SL
            // 3. Signal reversal (opposite signal strength >= 4)
            // 4. RSI extreme on opposite side
            const hitTP1 = pnlPips >= tpPips1;
            const hitTP2 = pnlPips >= tpPips2;
            const hitSL = pnlPips <= -slPips;
            const signalReverse = (posType === 'BUY' && sellScore >= 4) ||
                (posType === 'SELL' && buyScore >= 4);
            const rsiExtreme = rsi7 !== null && (
                (posType === 'BUY' && rsi7 > 75) || (posType === 'SELL' && rsi7 < 25)
            );

            if (hitSL) {
                result.signal = 'CLOSE';
                result.action = 'TUTUP POSISI';
                result.subText = `⚠️ Stop Loss tercapai (${pnlPips.toFixed(1)} pips)`;
                result.confidence = 95;
            } else if (hitTP2) {
                result.signal = 'CLOSE';
                result.action = 'TUTUP POSISI';
                result.subText = `🎯 TP2 tercapai! (${pnlPips.toFixed(1)} pips)`;
                result.confidence = 90;
            } else if (hitTP1 && (signalReverse || rsiExtreme)) {
                result.signal = 'CLOSE';
                result.action = 'TUTUP POSISI';
                result.subText = `✅ TP1 + sinyal balik (${pnlPips.toFixed(1)} pips)`;
                result.confidence = 85;
            } else if (signalReverse) {
                result.signal = 'CLOSE';
                result.action = 'TUTUP POSISI';
                result.subText = `🔄 Sinyal reversal kuat terdeteksi`;
                result.confidence = 75;
            } else {
                // Stay in position
                result.signal = 'HOLD';
                result.action = 'TAHAN POSISI';
                result.subText = `📊 P/L: ${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips`;
                result.confidence = 60;
            }

            // Pass through position levels
            result.entry = entryPrice;
            result.tp1 = this.position.tp1;
            result.tp2 = this.position.tp2;
            result.sl = this.position.sl;
            result.pipsTP = tpPips1;
            result.pipsSL = slPips;
            result.rrRatio = (tpPips1 / slPips).toFixed(1);

        } else {
            // ===== NO POSITION — Check for OPEN signal =====
            if (buyScore >= minConfluence && netScore >= 2) {
                result.signal = 'OPEN_BUY';
                result.action = 'OPEN BUY';
                result.subText = `📈 ${buyScore} indikator bullish confluent`;
                result.confidence = Math.min(95, 40 + buyScore * 10);
                result.entry = currentPrice;
                result.tp1 = Math.round((currentPrice + tpPips1) * 100) / 100;
                result.tp2 = Math.round((currentPrice + tpPips2) * 100) / 100;
                result.sl = Math.round((currentPrice - slPips) * 100) / 100;
                result.pipsTP = tpPips1;
                result.pipsSL = slPips;
                result.rrRatio = (tpPips1 / slPips).toFixed(1);
            } else if (sellScore >= minConfluence && netScore <= -2) {
                result.signal = 'OPEN_SELL';
                result.action = 'OPEN SELL';
                result.subText = `📉 ${sellScore} indikator bearish confluent`;
                result.confidence = Math.min(95, 40 + sellScore * 10);
                result.entry = currentPrice;
                result.tp1 = Math.round((currentPrice - tpPips1) * 100) / 100;
                result.tp2 = Math.round((currentPrice - tpPips2) * 100) / 100;
                result.sl = Math.round((currentPrice + slPips) * 100) / 100;
                result.pipsTP = tpPips1;
                result.pipsSL = slPips;
                result.rrRatio = (tpPips1 / slPips).toFixed(1);
            } else {
                result.signal = 'WAIT';
                result.action = 'MENUNGGU';
                if (buyScore > sellScore) {
                    result.subText = `Bias BUY (${buyScore}), butuh ${minConfluence} konfirmasi`;
                } else if (sellScore > buyScore) {
                    result.subText = `Bias SELL (${sellScore}), butuh ${minConfluence} konfirmasi`;
                } else {
                    result.subText = 'Menunggu confluent indikator...';
                }
                result.confidence = Math.round((Math.max(buyScore, sellScore) / minConfluence) * 30);
                // Show hypothetical levels even when waiting
                result.entry = currentPrice;
                result.tp1 = Math.round((currentPrice + tpPips1) * 100) / 100;
                result.tp2 = Math.round((currentPrice + tpPips2) * 100) / 100;
                result.sl = Math.round((currentPrice - slPips) * 100) / 100;
                result.pipsTP = tpPips1;
                result.pipsSL = slPips;
                result.rrRatio = (tpPips1 / slPips).toFixed(1);
            }
        }

        // ===== REVERSAL DETECTION =====
        // Track momentum to detect sudden price spikes against signal/position
        this.prevPrices.push(currentPrice);
        if (this.prevPrices.length > 10) this.prevPrices.shift();

        this.reversalState = null;
        if (this.prevPrices.length >= 3) {
            const len = this.prevPrices.length;
            const priceNow = this.prevPrices[len - 1];
            const price3ago = this.prevPrices[Math.max(0, len - 3)];
            const price5ago = this.prevPrices[Math.max(0, len - 5)];
            const momentum3 = priceNow - price3ago;   // 3-tick momentum
            const momentum5 = len >= 5 ? (priceNow - price5ago) : momentum3;
            const atrRef = atr || 5;
            const spikeThreshold = atrRef * 0.15; // 15% of ATR = significant move

            // Detect reversal against current position
            if (this.position) {
                const posType = this.position.type;
                const againstPos = (posType === 'SELL' && momentum3 > spikeThreshold) ||
                    (posType === 'BUY' && momentum3 < -spikeThreshold);
                if (againstPos) {
                    const strength = Math.min(100, Math.round(Math.abs(momentum3) / atrRef * 200));
                    this.reversalState = {
                        type: posType === 'SELL' ? 'UP' : 'DOWN',
                        strength: strength,
                        against: posType,
                        momentum: momentum3,
                        warning: strength >= 60 ? 'KUAT' : 'SEDANG',
                        message: posType === 'SELL'
                            ? `⚠️ Harga naik cepat! Momentum ${momentum3.toFixed(2)} berlawanan SELL`
                            : `⚠️ Harga turun cepat! Momentum ${momentum3.toFixed(2)} berlawanan BUY`
                    };
                }
            }

            // Detect reversal against current WAIT/signal direction
            if (!this.position) {
                const mainBias = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : null;
                if (mainBias) {
                    const againstBias = (mainBias === 'SELL' && momentum3 > spikeThreshold) ||
                        (mainBias === 'BUY' && momentum3 < -spikeThreshold);
                    if (againstBias) {
                        const strength = Math.min(100, Math.round(Math.abs(momentum3) / atrRef * 200));
                        this.reversalState = {
                            type: mainBias === 'SELL' ? 'UP' : 'DOWN',
                            strength: strength,
                            against: mainBias + ' bias',
                            momentum: momentum3,
                            warning: strength >= 60 ? 'KUAT' : 'SEDANG',
                            message: mainBias === 'SELL'
                                ? `⚡ Harga tiba-tiba naik! Sinyal SELL mungkin berubah`
                                : `⚡ Harga tiba-tiba turun! Sinyal BUY mungkin berubah`
                        };
                    }
                }
            }
        }

        result.reversalState = this.reversalState;

        return result;
    }

    openPosition(type, entry, tp1, tp2, sl) {
        this.position = {
            type, entry, tp1, tp2, sl,
            openTime: new Date()
        };
        this.cooldownUntil = 0;
    }

    closePosition(currentPrice) {
        if (!this.position) return;
        const pnlPips = this.position.type === 'BUY'
            ? (currentPrice - this.position.entry)
            : (this.position.entry - currentPrice);

        this.history.unshift({
            type: this.position.type,
            entry: this.position.entry,
            exit: currentPrice,
            pnl: Math.round(pnlPips * 100) / 100,
            time: new Date(),
            result: pnlPips >= 0 ? 'WIN' : 'LOSS'
        });

        // Keep max 10 history items
        if (this.history.length > 10) this.history.pop();

        this.position = null;
        // 30 second cooldown after closing
        this.cooldownUntil = Date.now() + 30000;
    }

    getPosition() { return this.position; }
    getHistory() { return this.history; }
}

// ==========================================
// Signal Engine
// ==========================================
class SignalEngine {
    constructor() {
        this.indicators = {};
        this.votes = { buy: 0, sell: 0, neutral: 0 };
        this.techniques = {};
        this.prevRsi = null;
        this.prevMacdHist = null;
        this.prevCloses = [];
        // Signal Stability System
        this.signalHistory = [];      // Last N raw signals for smoothing
        this.confirmedDirection = 'NEUTRAL'; // Locked-in direction (requires confirmation to change)
        this.confirmCounter = 0;       // Ticks confirming a direction change
        this.trendStreak = 0;          // How long current trend has been active
        this.prevWeightedScore = 0;    // Previous tick's score for rate-of-change
    }

    analyze(priceData) {
        const closes = priceData.map(d => d.close);
        const highs = priceData.map(d => d.high);
        const lows = priceData.map(d => d.low);
        const volumes = priceData.map(d => d.volume || 0);
        if (closes.length < 30) return null;

        // Weighted scoring system: each indicator contributes a weighted score
        // Score range: -100 (strong sell) to +100 (strong buy)
        let weightedScores = [];
        this.votes = { buy: 0, sell: 0, neutral: 0 };
        this.indicators = {};
        this.techniques = {};
        const currentPrice = closes[closes.length - 1];
        const prevPrice = closes.length > 1 ? closes[closes.length - 2] : currentPrice;

        // ====== INDICATOR 1: RSI — Adaptive period (Weight: 2.0) ======
        const rsiPeriod = (state.currentTF === '1' || state.currentTF === '5') ? 9 : 14;
        const rsi = TechnicalIndicators.RSI(closes, rsiPeriod);
        if (rsi !== null) {
            this.indicators.rsi = { value: Math.round(rsi * 100) / 100, period: rsiPeriod };
            let rsiScore = 0;

            // Strong zones
            if (rsi < 20) { rsiScore = 90; this.indicators.rsi.signal = 'BUY'; this.votes.buy++; }
            else if (rsi < 30) { rsiScore = 70; this.indicators.rsi.signal = 'BUY'; this.votes.buy++; }
            else if (rsi < 40) { rsiScore = 30; this.indicators.rsi.signal = 'BUY'; this.votes.buy++; }
            else if (rsi > 80) { rsiScore = -90; this.indicators.rsi.signal = 'SELL'; this.votes.sell++; }
            else if (rsi > 70) { rsiScore = -70; this.indicators.rsi.signal = 'SELL'; this.votes.sell++; }
            else if (rsi > 60) { rsiScore = -30; this.indicators.rsi.signal = 'SELL'; this.votes.sell++; }
            else { rsiScore = 0; this.indicators.rsi.signal = 'NEUTRAL'; this.votes.neutral++; }

            // RSI Divergence detection (extra weight)
            if (this.prevRsi !== null && closes.length > 5) {
                const price5back = closes[closes.length - 6];
                // Bullish divergence: price lower but RSI higher
                if (currentPrice < price5back && rsi > this.prevRsi) {
                    rsiScore += 25;
                    this.indicators.rsi.divergence = 'BULLISH';
                }
                // Bearish divergence: price higher but RSI lower
                if (currentPrice > price5back && rsi < this.prevRsi) {
                    rsiScore -= 25;
                    this.indicators.rsi.divergence = 'BEARISH';
                }
            }
            this.prevRsi = rsi;
            weightedScores.push({ name: 'RSI', score: rsiScore, weight: 2.0 });
        }

        // ====== INDICATOR 2: MACD (Weight: 2.0) ======
        const macd = TechnicalIndicators.MACD(closes);
        if (macd !== null) {
            this.indicators.macd = { value: macd.macd, signal_line: macd.signal, histogram: macd.histogram };
            let macdScore = 0;

            // MACD line vs Signal line with histogram momentum
            if (macd.histogram > 0 && macd.macd > macd.signal) {
                macdScore = Math.min(80, Math.abs(macd.histogram) * 15);
                this.indicators.macd.signal = 'BUY'; this.votes.buy++;
            } else if (macd.histogram < 0 && macd.macd < macd.signal) {
                macdScore = -Math.min(80, Math.abs(macd.histogram) * 15);
                this.indicators.macd.signal = 'SELL'; this.votes.sell++;
            } else {
                macdScore = 0;
                this.indicators.macd.signal = 'NEUTRAL'; this.votes.neutral++;
            }

            // MACD crossover detection (momentum shift)
            if (this.prevMacdHist !== null) {
                if (this.prevMacdHist < 0 && macd.histogram > 0) {
                    macdScore += 30; // Bullish crossover
                    this.indicators.macd.crossover = 'BULLISH';
                } else if (this.prevMacdHist > 0 && macd.histogram < 0) {
                    macdScore -= 30; // Bearish crossover
                    this.indicators.macd.crossover = 'BEARISH';
                }
            }
            this.prevMacdHist = macd.histogram;
            weightedScores.push({ name: 'MACD', score: macdScore, weight: 2.0 });
        }

        // ====== INDICATOR 3: Moving Averages (Weight: 1.5) ======
        const sma20 = TechnicalIndicators.SMA(closes, 20);
        const ema50 = TechnicalIndicators.EMA(closes, 50);
        const sma9 = TechnicalIndicators.SMA(closes, 9);
        if (sma20 !== null && ema50 !== null) {
            this.indicators.ma = { sma20: Math.round(sma20 * 100) / 100, ema50: Math.round(ema50 * 100) / 100 };
            let maScore = 0;

            // Price position relative to MAs
            const aboveSma20 = currentPrice > sma20;
            const aboveEma50 = currentPrice > ema50;
            const smaAboveEma = sma20 > ema50;

            if (aboveSma20 && aboveEma50 && smaAboveEma) {
                maScore = 70; // Full bullish alignment
                this.indicators.ma.signal = 'BUY'; this.indicators.ma.value = 'Bullish'; this.votes.buy++;
            } else if (!aboveSma20 && !aboveEma50 && !smaAboveEma) {
                maScore = -70; // Full bearish alignment
                this.indicators.ma.signal = 'SELL'; this.indicators.ma.value = 'Bearish'; this.votes.sell++;
            } else if (aboveSma20 && smaAboveEma) {
                maScore = 35; // Partial bullish
                this.indicators.ma.signal = 'BUY'; this.indicators.ma.value = 'Bullish Bias'; this.votes.buy++;
            } else if (!aboveSma20 && !smaAboveEma) {
                maScore = -35; // Partial bearish
                this.indicators.ma.signal = 'SELL'; this.indicators.ma.value = 'Bearish Bias'; this.votes.sell++;
            } else {
                maScore = 0;
                this.indicators.ma.signal = 'NEUTRAL'; this.indicators.ma.value = 'Mixed'; this.votes.neutral++;
            }

            // Golden/Death cross detection
            if (sma9 !== null) {
                const prevCloses9 = closes.slice(0, -1);
                const prevSma9 = TechnicalIndicators.SMA(prevCloses9, 9);
                if (prevSma9 !== null) {
                    if (prevSma9 < sma20 && sma9 > sma20) {
                        maScore += 20; // Golden cross (SMA9 crosses above SMA20)
                        this.indicators.ma.cross = 'GOLDEN';
                    } else if (prevSma9 > sma20 && sma9 < sma20) {
                        maScore -= 20; // Death cross
                        this.indicators.ma.cross = 'DEATH';
                    }
                }
            }

            weightedScores.push({ name: 'MA', score: maScore, weight: 1.5 });
        }

        // ====== INDICATOR 4: Bollinger Bands (Weight: 1.5) ======
        const bb = TechnicalIndicators.BollingerBands(closes);
        if (bb !== null) {
            this.indicators.bb = { upper: bb.upper, lower: bb.lower, bandwidth: bb.bandwidth };
            let bbScore = 0;
            const bbMid = (bb.upper + bb.lower) / 2;
            const bbRange = bb.upper - bb.lower;
            const pricePosition = bbRange > 0 ? (currentPrice - bb.lower) / bbRange : 0.5;

            if (currentPrice <= bb.lower) {
                bbScore = 80; // Strong oversold — mean reversion buy
                this.indicators.bb.signal = 'BUY'; this.indicators.bb.value = 'Oversold'; this.votes.buy++;
            } else if (currentPrice >= bb.upper) {
                bbScore = -80; // Strong overbought — mean reversion sell
                this.indicators.bb.signal = 'SELL'; this.indicators.bb.value = 'Overbought'; this.votes.sell++;
            } else if (pricePosition < 0.3) {
                bbScore = 40; // Lower zone
                this.indicators.bb.signal = 'BUY'; this.indicators.bb.value = 'Lower Zone'; this.votes.buy++;
            } else if (pricePosition > 0.7) {
                bbScore = -40; // Upper zone
                this.indicators.bb.signal = 'SELL'; this.indicators.bb.value = 'Upper Zone'; this.votes.sell++;
            } else {
                // NEUTRAL zone (30%-70%) — no forced vote
                bbScore = 0;
                this.indicators.bb.signal = 'NEUTRAL'; this.indicators.bb.value = 'Neutral Zone'; this.votes.neutral++;
            }

            // Bollinger squeeze detection (low bandwidth = upcoming breakout)
            if (bb.bandwidth < 1.0) {
                this.indicators.bb.squeeze = true;
            }

            weightedScores.push({ name: 'BB', score: bbScore, weight: 1.5 });
        }

        // ====== INDICATOR 5: Stochastic (Weight: 1.5) ======
        const stoch = TechnicalIndicators.Stochastic(highs, lows, closes);
        if (stoch !== null) {
            this.indicators.stoch = { value: stoch.k, d: stoch.d };
            let stochScore = 0;

            // Stochastic with K/D crossover confirmation
            const kCrossAboveD = stoch.k > stoch.d;

            if (stoch.k < 20) {
                stochScore = kCrossAboveD ? 85 : 50; // Oversold + bullish crossover = strongest
                this.indicators.stoch.signal = 'BUY'; this.votes.buy++;
            } else if (stoch.k > 80) {
                stochScore = !kCrossAboveD ? -85 : -50; // Overbought + bearish crossover
                this.indicators.stoch.signal = 'SELL'; this.votes.sell++;
            } else if (stoch.k < 35 && kCrossAboveD) {
                stochScore = 35;
                this.indicators.stoch.signal = 'BUY'; this.votes.buy++;
            } else if (stoch.k > 65 && !kCrossAboveD) {
                stochScore = -35;
                this.indicators.stoch.signal = 'SELL'; this.votes.sell++;
            } else {
                stochScore = 0;
                this.indicators.stoch.signal = 'NEUTRAL'; this.votes.neutral++;
            }

            weightedScores.push({ name: 'Stoch', score: stochScore, weight: 1.5 });
        }

        // ====== INDICATOR 6: ATR (Weight: 0.5 — informational, used as modifier) ======
        const atr = TechnicalIndicators.ATR(highs, lows, closes);
        if (atr !== null) {
            this.indicators.atr = { value: atr };
            const avgPrice = TechnicalIndicators.SMA(closes, 14) || currentPrice;
            const atrPct = (atr / avgPrice) * 100;
            if (atrPct > 1.5) { this.indicators.atr.signal = 'HIGH'; this.indicators.atr.vol = 'Tinggi'; }
            else if (atrPct > 0.8) { this.indicators.atr.signal = 'MEDIUM'; this.indicators.atr.vol = 'Sedang'; }
            else { this.indicators.atr.signal = 'LOW'; this.indicators.atr.vol = 'Rendah'; }
        }

        // ====== INDICATOR 7: Pivot Points ======
        const lastCandle = priceData[priceData.length - 1];
        this.indicators.pivots = TechnicalIndicators.PivotPoints(lastCandle.high, lastCandle.low, lastCandle.close);

        // ====== ADVANCED TECHNIQUE 8: TREND FOLLOWING — ADX (Weight: 2.5) ======
        const adx = TechnicalIndicators.ADX(highs, lows, closes);
        if (adx) {
            this.techniques.trendFollowing = {
                name: 'Trend Following',
                adx: adx.adx,
                plusDI: adx.plusDI,
                minusDI: adx.minusDI,
                trend: adx.trend,
                description: adx.adx > 25
                    ? `Tren kuat (ADX: ${adx.adx}) — ${adx.trend === 'UPTREND' ? '📈 Uptrend' : '📉 Downtrend'}`
                    : `Pasar sideways (ADX: ${adx.adx}) — Tidak ada tren jelas`
            };
            let adxScore = 0;
            if (adx.adx > 40) {
                // Very strong trend
                adxScore = adx.trend === 'UPTREND' ? 90 : -90;
                this.techniques.trendFollowing.signal = adx.trend === 'UPTREND' ? 'BUY' : 'SELL';
                if (adx.trend === 'UPTREND') this.votes.buy++; else this.votes.sell++;
            } else if (adx.adx > 25) {
                // Moderate trend
                adxScore = adx.trend === 'UPTREND' ? 60 : -60;
                this.techniques.trendFollowing.signal = adx.trend === 'UPTREND' ? 'BUY' : 'SELL';
                if (adx.trend === 'UPTREND') this.votes.buy++; else this.votes.sell++;
            } else {
                adxScore = 0;
                this.techniques.trendFollowing.signal = 'NEUTRAL';
                this.votes.neutral++;
            }

            // DI spread strength
            const diSpread = Math.abs(adx.plusDI - adx.minusDI);
            if (diSpread > 15 && adx.adx > 20) {
                adxScore += adx.plusDI > adx.minusDI ? 15 : -15;
            }

            weightedScores.push({ name: 'ADX', score: adxScore, weight: 2.5 });
        }

        // ====== TECHNIQUE 9: PRICE ACTION (Weight: 1.5) ======
        const pa = TechnicalIndicators.CandlestickPatterns(priceData);
        if (pa) {
            this.techniques.priceAction = {
                name: 'Price Action',
                patterns: pa.patterns,
                patternNames: pa.patterns.map(p => `${p.emoji} ${p.name}`).join(', ') || 'Tidak ada pola',
                description: pa.patterns.length > 0
                    ? `Terdeteksi: ${pa.patterns.map(p => p.name).join(', ')}`
                    : 'Menunggu pola candlestick...'
            };
            let paScore = 0;
            if (pa.signal === 'BUY') {
                paScore = 30 + pa.bullCount * 15;
                this.techniques.priceAction.signal = 'BUY'; this.votes.buy++;
            } else if (pa.signal === 'SELL') {
                paScore = -(30 + pa.bearCount * 15);
                this.techniques.priceAction.signal = 'SELL'; this.votes.sell++;
            } else {
                this.techniques.priceAction.signal = 'NEUTRAL'; this.votes.neutral++;
            }
            weightedScores.push({ name: 'PA', score: paScore, weight: 1.5 });
        }

        // ====== TECHNIQUE 10: BREAKOUT (Weight: 2.0) ======
        const breakout = TechnicalIndicators.BreakoutDetection(priceData);
        if (breakout) {
            const bDesc = {
                'BULLISH_BREAKOUT': '🚀 Breakout BULLISH! Harga menembus resistance',
                'BEARISH_BREAKOUT': '💥 Breakout BEARISH! Harga menembus support',
                'TESTING_RESISTANCE': '⚡ Menguji resistance — potensi breakout/rejection',
                'TESTING_SUPPORT': '⚡ Menguji support — potensi bounce/breakdown',
                'NONE': '📊 Harga dalam range — menunggu breakout'
            };
            this.techniques.breakout = {
                name: 'Breakout Trading',
                type: breakout.breakout,
                strength: breakout.strength,
                resistance: breakout.resistance,
                support: breakout.support,
                range: breakout.range,
                description: bDesc[breakout.breakout] || 'Menunggu breakout'
            };
            let boScore = 0;
            if (breakout.breakout === 'BULLISH_BREAKOUT') {
                boScore = 50 + Math.min(40, breakout.strength);
                this.techniques.breakout.signal = 'BUY'; this.votes.buy++;
            } else if (breakout.breakout === 'BEARISH_BREAKOUT') {
                boScore = -(50 + Math.min(40, breakout.strength));
                this.techniques.breakout.signal = 'SELL'; this.votes.sell++;
            } else if (breakout.breakout === 'TESTING_SUPPORT') {
                boScore = 25;
                this.techniques.breakout.signal = 'BUY'; this.votes.buy++;
            } else if (breakout.breakout === 'TESTING_RESISTANCE') {
                boScore = -25;
                this.techniques.breakout.signal = 'SELL'; this.votes.sell++;
            } else {
                this.techniques.breakout.signal = 'NEUTRAL'; this.votes.neutral++;
            }
            weightedScores.push({ name: 'Breakout', score: boScore, weight: 2.0 });
        }

        // Fibonacci Levels (informational — no vote)
        const fib = TechnicalIndicators.FibonacciLevels(priceData);
        if (fib) this.techniques.fibonacci = fib;

        // ====== TRADING STYLE RECOMMENDATION ======
        const atrVal = atr || 15;
        const avgPriceForStyle = TechnicalIndicators.SMA(closes, 14) || currentPrice;
        const atrPctVal = (atrVal / avgPriceForStyle) * 100;
        const adxVal = adx ? adx.adx : 20;

        let style = 'Day Trading';
        let styleDesc = '';
        let styleEmoji = '📅';

        if (atrPctVal < 0.5 && adxVal < 20) {
            style = 'Scalping';
            styleDesc = 'Volatilitas rendah + tren lemah → Ambil profit kecil & cepat (5-15 pips)';
            styleEmoji = '⚡';
        } else if (adxVal > 30 && (adx && adx.trend !== 'SIDEWAYS')) {
            style = 'Swing Trading';
            styleDesc = 'Tren kuat terdeteksi → Tahan posisi lebih lama untuk profit maksimal';
            styleEmoji = '🏄';
        } else {
            style = 'Day Trading';
            styleDesc = 'Kondisi normal → Buka & tutup posisi dalam hari yang sama';
            styleEmoji = '📅';
        }
        this.techniques.tradingStyle = { style, description: styleDesc, emoji: styleEmoji };

        // ====== WEIGHTED CONFIDENCE CALCULATION ======
        const totalWeight = weightedScores.reduce((sum, s) => sum + s.weight, 0);
        const weightedSum = weightedScores.reduce((sum, s) => sum + (s.score * s.weight), 0);
        const normalizedScore = totalWeight > 0 ? weightedSum / totalWeight : 0; // Range: -100 to +100

        // ====== SIDEWAYS MARKET DETECTION ======
        // Detect ranging/sideways conditions using multiple factors
        let sidewaysScore = 0;
        let sidewaysReasons = [];

        // Factor 1: ADX — low ADX = no clear trend
        const adxValue = adx ? adx.adx : 20;
        if (adxValue < 15) {
            sidewaysScore += 3; // Very low ADX = strong sideways
            sidewaysReasons.push('ADX sangat rendah (' + adxValue.toFixed(1) + ')');
        } else if (adxValue < 20) {
            sidewaysScore += 2;
            sidewaysReasons.push('ADX rendah (' + adxValue.toFixed(1) + ')');
        } else if (adxValue < 25) {
            sidewaysScore += 1;
            sidewaysReasons.push('ADX sedang (' + adxValue.toFixed(1) + ')');
        }

        // Factor 2: Bollinger Band squeeze — narrow bands = consolidation
        if (this.indicators.bb) {
            const bbWidth = this.indicators.bb.upper - this.indicators.bb.lower;
            const bbPct = (bbWidth / currentPrice) * 100;
            if (bbPct < 0.3) {
                sidewaysScore += 2;
                sidewaysReasons.push('BB squeeze (width ' + bbPct.toFixed(2) + '%)');
            } else if (bbPct < 0.6) {
                sidewaysScore += 1;
                sidewaysReasons.push('BB sempit');
            }
        }

        // Factor 3: Vote fragmentation — no clear majority
        const maxDirectionalVote = Math.max(this.votes.buy, this.votes.sell);
        const minDirectionalVote = Math.min(this.votes.buy, this.votes.sell);
        if (maxDirectionalVote <= 2 && this.votes.neutral >= 3) {
            sidewaysScore += 2;
            sidewaysReasons.push('Indikator tidak sepakat (WAIT dominan)');
        } else if (maxDirectionalVote - minDirectionalVote <= 1 && maxDirectionalVote <= 3) {
            sidewaysScore += 1;
            sidewaysReasons.push('Indikator terpecah (BUY≈SELL)');
        }

        // Factor 4: Score weakness — very low normalized score
        if (Math.abs(normalizedScore) < 8) {
            sidewaysScore += 2;
            sidewaysReasons.push('Skor sangat lemah (' + normalizedScore.toFixed(1) + ')');
        } else if (Math.abs(normalizedScore) < 15) {
            sidewaysScore += 1;
            sidewaysReasons.push('Skor lemah');
        }

        // Factor 5: RSI near middle — no momentum
        if (rsi !== null && rsi > 40 && rsi < 60) {
            sidewaysScore += 1;
            sidewaysReasons.push('RSI netral (' + rsi.toFixed(0) + ')');
        }

        // Determine if market is sideways
        const isSideways = sidewaysScore >= 4;
        const isMildSideways = sidewaysScore >= 3 && sidewaysScore < 4;

        // ====== SIGNAL STABILITY SYSTEM ======
        // 1. Track raw scores for smoothing (3-tick window for fast response)
        this.signalHistory.push(normalizedScore);
        if (this.signalHistory.length > 3) this.signalHistory.shift();

        // 2. Smoothed score = weighted average (more weight to latest)
        let smoothedScore;
        if (this.signalHistory.length === 3) {
            smoothedScore = this.signalHistory[0] * 0.2 + this.signalHistory[1] * 0.3 + this.signalHistory[2] * 0.5;
        } else {
            smoothedScore = this.signalHistory.reduce((a, b) => a + b, 0) / this.signalHistory.length;
        }

        // 3. Hysteresis thresholds — raised when sideways detected
        const ENTER_THRESHOLD = isMildSideways ? 15 : 10;
        const EXIT_THRESHOLD = 4;
        const CONFIRM_TICKS = 2;
        const STRONG_BYPASS = isSideways ? 50 : 30; // Much harder to bypass in sideways

        // 4. Determine raw direction from smoothed score
        let rawDirection;
        if (isSideways) {
            // Sideways override — force NEUTRAL unless score is extremely strong
            if (Math.abs(smoothedScore) > 40) {
                rawDirection = smoothedScore > 0 ? 'BUY' : 'SELL';
            } else {
                rawDirection = 'NEUTRAL';
            }
        } else {
            if (smoothedScore > ENTER_THRESHOLD) rawDirection = 'BUY';
            else if (smoothedScore < -ENTER_THRESHOLD) rawDirection = 'SELL';
            else rawDirection = 'NEUTRAL';
        }

        // 4b. Strong momentum bypass — very clear signals skip confirmation
        const isStrongMomentum = Math.abs(smoothedScore) > STRONG_BYPASS;

        // 5. Direction change confirmation (prevents single-tick flips)
        let direction;
        if (rawDirection === this.confirmedDirection) {
            // Same direction → keep it, reset counter
            direction = this.confirmedDirection;
            this.confirmCounter = 0;
            this.trendStreak++;
        } else if (rawDirection === 'NEUTRAL') {
            // Score dropped to neutral zone — check if we should stay or exit
            const stayInTrend = this.confirmedDirection !== 'NEUTRAL' &&
                Math.abs(smoothedScore) > EXIT_THRESHOLD && !isSideways;
            if (stayInTrend) {
                direction = this.confirmedDirection; // Still above exit threshold → stay
                this.trendStreak++;
            } else {
                this.confirmCounter++;
                const exitTicks = isSideways ? 1 : 2; // Faster exit when sideways detected
                if (this.confirmCounter >= exitTicks) {
                    direction = 'NEUTRAL';
                    this.confirmedDirection = 'NEUTRAL';
                    this.trendStreak = 0;
                    this.confirmCounter = 0;
                } else {
                    direction = this.confirmedDirection;
                    this.trendStreak++;
                }
            }
        } else {
            // Direction changed (BUY↔SELL or NEUTRAL→BUY/SELL)
            this.confirmCounter++;
            if (isStrongMomentum) {
                // Very strong score → confirm immediately (no delay)
                direction = rawDirection;
                this.confirmedDirection = rawDirection;
                this.trendStreak = 0;
                this.confirmCounter = 0;
            } else if (this.confirmedDirection === 'NEUTRAL') {
                // From NEUTRAL → BUY/SELL: confirm after 1 tick (2 if mild sideways)
                const needTicks = isMildSideways ? 2 : 1;
                if (this.confirmCounter >= needTicks) {
                    direction = rawDirection;
                    this.confirmedDirection = rawDirection;
                    this.trendStreak = 0;
                    this.confirmCounter = 0;
                } else {
                    direction = 'NEUTRAL';
                }
            } else {
                // From BUY→SELL or SELL→BUY: need CONFIRM_TICKS
                if (this.confirmCounter >= CONFIRM_TICKS) {
                    direction = rawDirection;
                    this.confirmedDirection = rawDirection;
                    this.trendStreak = 0;
                    this.confirmCounter = 0;
                } else {
                    direction = this.confirmedDirection;
                }
            }
        }

        // 6. Confidence calculation (same as before but using smoothed score)
        const absScore = Math.abs(smoothedScore);
        const totalVotes = this.votes.buy + this.votes.sell + this.votes.neutral;
        const dominantVotes = Math.max(this.votes.buy, this.votes.sell, this.votes.neutral);
        const voteAgreement = totalVotes > 0 ? (dominantVotes / totalVotes) : 0;

        let confidence = Math.round(Math.min(98, Math.max(15, absScore * 1.0 + voteAgreement * 35)));

        // Sideways penalty — reduce confidence in sideways markets
        if (isSideways && direction !== 'NEUTRAL') {
            confidence = Math.max(15, confidence - 20);
        } else if (isMildSideways && direction !== 'NEUTRAL') {
            confidence = Math.max(15, confidence - 10);
        }

        // Trend-alignment boost
        if (adx && adx.adx > 25) {
            if ((direction === 'BUY' && adx.trend === 'UPTREND') ||
                (direction === 'SELL' && adx.trend === 'DOWNTREND')) {
                confidence = Math.min(98, confidence + 8);
            } else if ((direction === 'BUY' && adx.trend === 'DOWNTREND') ||
                (direction === 'SELL' && adx.trend === 'UPTREND')) {
                confidence = Math.max(20, confidence - 10);
            }
        }

        if (rsi !== null) {
            if ((direction === 'BUY' && rsi < 25) || (direction === 'SELL' && rsi > 75)) {
                confidence = Math.min(98, confidence + 5);
            }
        }

        if (this.votes.buy >= 7 || this.votes.sell >= 7) confidence = Math.min(98, confidence + 10);
        else if (this.votes.buy >= 6 || this.votes.sell >= 6) confidence = Math.min(95, confidence + 5);

        // 7. Graduated signal label (with SIDEWAYS awareness)
        let signalLabel;
        let marketCondition = isSideways ? 'SIDEWAYS' : (isMildSideways ? 'RANGING' : 'TRENDING');
        if (direction === 'NEUTRAL') {
            signalLabel = isSideways ? '⏸ SIDEWAYS' : (isMildSideways ? '↔ RANGING' : 'TUNGGU / HOLD');
        } else {
            let strength;
            if (confidence >= 70) strength = 'VERY STRONG';
            else if (confidence >= 45) strength = 'STRONG';
            else if (confidence >= 30) strength = 'MODERATE';
            else strength = 'WEAK';
            signalLabel = `${strength} ${direction}`;
        }

        // 8. Trend stability indicator
        let trendStability = 'BARU';
        if (this.trendStreak > 15) trendStability = 'MANTAP';
        else if (this.trendStreak > 5) trendStability = 'TERKONFIRMASI';

        // 9. Score momentum (rate of change)
        const scoreMomentum = smoothedScore - this.prevWeightedScore;
        this.prevWeightedScore = smoothedScore;

        // 10. Estimate where trend might change
        let estimatedReversal = null;
        if (direction !== 'NEUTRAL' && Math.abs(scoreMomentum) > 0.5) {
            // If score is declining, estimate ticks until reversal
            const isDecreasing = (direction === 'BUY' && scoreMomentum < -0.5) ||
                (direction === 'SELL' && scoreMomentum > 0.5);
            if (isDecreasing) {
                const ticksToZero = Math.abs(smoothedScore / scoreMomentum);
                estimatedReversal = {
                    warning: ticksToZero < 10 ? 'DEKAT' : 'JAUH',
                    ticksEstimate: Math.round(ticksToZero),
                    message: ticksToZero < 10
                        ? `⚠️ Tren ${direction} melemah — potensi berubah dalam ~${Math.round(ticksToZero)} tick`
                        : `Tren ${direction} stabil`
                };
            }
        }

        const activeIndicators = weightedScores.filter(s => Math.abs(s.score) > 5).length;

        return {
            direction, confidence,
            signalLabel,
            votes: { ...this.votes },
            indicators: { ...this.indicators },
            techniques: { ...this.techniques },
            price: currentPrice,
            timestamp: new Date(),
            weightedScore: Math.round(normalizedScore * 100) / 100,
            smoothedScore: Math.round(smoothedScore * 100) / 100,
            activeIndicators,
            totalIndicators: weightedScores.length,
            // Trend stability info
            trendStreak: this.trendStreak,
            trendStability,
            scoreMomentum: Math.round(scoreMomentum * 100) / 100,
            estimatedReversal,
            rawDirection, // Raw unconfirmed direction for debugging
            // Sideways detection info
            marketCondition,
            sidewaysScore,
            sidewaysReasons
        };
    }
}

// ==========================================
// Main Application
// ==========================================
const metaApi = new MetaApiManager();
const priceEngine = new PriceEngine();
const signalEngine = new SignalEngine();
const scalpingEngine = new ScalpingEngine();
let priceData = [];
let updateTimer = null;

// Scalping TF switcher
async function switchScalpTF(tf) {
    state.scalpingTF = tf;
    console.log(`⚡ Scalping TF switched to M${tf}`);

    // Update button states
    document.querySelectorAll('.scalp-tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });

    // Fetch candles for the selected scalping TF
    let scalpData = priceData; // fallback to current data
    try {
        const realCandles = await priceEngine.realFeed.fetchRealCandles(tf);
        if (realCandles && realCandles.length > 10) {
            scalpData = realCandles;
            console.log(`📊 Scalping: ${realCandles.length} candles M${tf} loaded`);
        }
    } catch (e) {
        console.warn('Scalp candle fetch error:', e);
    }

    // Rerun scalping analysis with new TF data
    try {
        const scalpResult = scalpingEngine.analyze(scalpData);
        if (scalpResult) updateScalpingUI(scalpResult);
    } catch (e) {
        console.warn('Scalp analysis error:', e);
    }

    addAlert('info', '⚡ Scalping TF', `Timeframe scalping diubah ke M${tf}`);
}

// Initialize
async function switchMarket(marketKey) {
    const market = MARKETS[marketKey];
    if (!market) return;

    console.log(`🔄 Switching to ${market.pair}...`);
    state.currentMarket = marketKey;

    // Update CONFIG
    CONFIG.pair = market.pair;
    CONFIG.symbol = market.symbol;
    CONFIG.basePrice = market.basePrice;
    CONFIG.contractSize = market.contractSize;
    CONFIG.decimals = market.decimals;

    // Update header UI
    const pairName = document.querySelector('.pair-name');
    const pairLabel = document.querySelector('.pair-label');
    const pairFlag = document.querySelector('.pair-flag');
    if (pairName) pairName.textContent = market.pair;
    if (pairLabel) pairLabel.textContent = market.label;
    if (pairFlag) pairFlag.textContent = market.icon;

    // Update market switcher buttons
    document.querySelectorAll('.market-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.market === marketKey);
    });

    // Rebuild price feed sources for new market
    priceEngine.realFeed.buildSources();

    // Reset price engine base price to new market
    priceEngine.basePrice = market.basePrice;
    priceEngine.momentum = 0;
    priceEngine.trend = 0;

    // Reset engines
    signalEngine.confirmedDirection = 'NEUTRAL';
    signalEngine.confirmCounter = 0;
    signalEngine.trendStreak = 0;
    signalEngine.indicators = {};
    scalpingEngine.position = null;
    scalpingEngine.cooldownUntil = 0;

    // Clear previous data & RSI sparkline history
    priceData = [];
    state.currentPrice = 0;
    state.previousPrice = 0;
    rsiHistory.length = 0;

    addAlert('info', '🔄 Market Switch', `Beralih ke ${market.icon} ${market.pair}`);

    // Fetch new price
    try {
        const realPrice = await priceEngine.syncWithRealPrice();
        if (realPrice) {
            priceEngine.basePrice = realPrice;
            addAlert('buy', '✅ Harga Real', `${market.pair}: $${realPrice.toFixed(market.decimals)}`);
        }
    } catch (e) { console.warn('Price sync error:', e); }

    // Fetch new candles
    try {
        const tf = state.currentTF === '1' ? '1' : state.currentTF === '5' ? '5' : state.currentTF || '15';
        const realCandles = await priceEngine.realFeed.fetchRealCandles(tf);
        if (realCandles && realCandles.length > 10) {
            priceData = realCandles;
            addAlert('buy', '📊 Data Real', `${realCandles.length} candles ${market.pair} loaded`);
        } else {
            priceData = priceEngine.generateHistoricalData(100);
        }
    } catch (e) {
        priceData = priceEngine.generateHistoricalData(100);
    }

    if (priceData.length > 0) {
        state.currentPrice = priceData[priceData.length - 1].close;
        state.previousPrice = priceData.length > 1 ? priceData[priceData.length - 2].close : state.currentPrice;
    }

    // Reinitialize TradingView widget with new symbol
    if (typeof initTradingViewWidget === 'function') {
        try {
            const tvContainer = document.getElementById('tradingview_widget');
            if (tvContainer) tvContainer.innerHTML = '';
            tvWidget = null;
            initTradingViewWidget(market.tvSymbol);
        } catch (e) { console.warn('TV reinit error:', e); }
    }

    // Rerun ALL analysis with new market data
    const analysis = signalEngine.analyze(priceData);
    if (analysis) {
        updateSignalUI(analysis);
        checkSignalChange(analysis);
    }

    // Rerun scalping analysis
    try {
        const scalpResult = scalpingEngine.analyze(priceData);
        if (scalpResult) updateScalpingUI(scalpResult);
    } catch (e) { console.warn('Scalp reanalysis error:', e); }

    updatePriceDisplay();
    drawChart();
    localStorage.setItem('botgold_market', marketKey);
    console.log(`✅ Switched to ${market.pair}`);
}

async function init() {
    console.log('🚀 [INIT] Starting...');
    try { loadSettings(); console.log('✅ [INIT] loadSettings done'); } catch (e) { console.error('❌ [INIT] loadSettings error:', e); }
    try { loadMT4Settings(); console.log('✅ [INIT] loadMT4Settings done'); } catch (e) { console.warn('⚠️ [INIT] loadMT4Settings error (ignored):', e); }

    // Try to sync with real gold price before generating data
    addAlert('info', '🔄 Sinkronisasi', 'Mencari harga XAU/USD real-time...');
    try {
        const realPrice = await priceEngine.syncWithRealPrice();
        if (realPrice) {
            addAlert('buy', '✅ Harga Real', `Terhubung ke API — Harga real: $${realPrice.toFixed(2)}`);
            updateDataSourceBadge('realapi');
            console.log('✅ [INIT] Real price synced:', realPrice);
        } else {
            addAlert('sell', '⚠️ Simulasi', `API tidak tersedia — menggunakan simulasi dari $${CONFIG.basePrice}`);
            updateDataSourceBadge('sim');
            console.warn('⚠️ [INIT] No real price, using simulation');
        }
    } catch (e) { console.error('❌ [INIT] syncWithRealPrice error:', e); }

    // Try to load real candle history
    try {
        const realCandles = await priceEngine.realFeed.fetchRealCandles(state.currentTF === 'M1' ? '1' : state.currentTF === 'M5' ? '5' : '15');
        if (realCandles && realCandles.length > 10) {
            priceData = realCandles;
            addAlert('buy', '📊 Data Real', `${realCandles.length} candles loaded dari Yahoo Finance`);
            console.log('✅ [INIT] Loaded', realCandles.length, 'candles');
        } else {
            priceData = priceEngine.generateHistoricalData(100);
            console.log('⚠️ [INIT] Using simulated candles');
        }
    } catch (e) {
        console.error('❌ [INIT] fetchRealCandles error:', e);
        priceData = priceEngine.generateHistoricalData(100);
    }

    try {
        state.currentPrice = priceData[priceData.length - 1].close;
        console.log('✅ [INIT] Current price set:', state.currentPrice);
    } catch (e) { console.error('❌ [INIT] set currentPrice error:', e); }

    try { initTradingViewChart(); console.log('✅ [INIT] initTradingViewChart done'); } catch (e) { console.error('❌ [INIT] initTradingViewChart error:', e); }

    try {
        await updatePrice();
        console.log('✅ [INIT] First updatePrice done');
    } catch (e) { console.error('❌ [INIT] updatePrice error:', e); }

    try { startUpdateLoop(); console.log('✅ [INIT] startUpdateLoop done'); } catch (e) { console.error('❌ [INIT] startUpdateLoop error:', e); }

    setTimeout(() => {
        state.isConnected = true;
        try { updateConnectionStatus(); } catch (e) { console.error('❌ updateConnectionStatus error:', e); }
        console.log('✅ [INIT] Connection status set to online');
    }, 1500);
    console.log('🎉 [INIT] Initialization complete');
}

function updateDataSourceBadge(source) {
    const badge = document.getElementById('dataSourceBadge');
    if (!badge) return;
    if (source === 'realapi') {
        badge.className = 'data-source-badge live';
        badge.innerHTML = '● Live (API)';
    } else if (source === 'metaapi') {
        badge.className = 'data-source-badge live';
        badge.innerHTML = '● Live (MT4)';
    } else {
        badge.className = 'data-source-badge sim';
        badge.innerHTML = '● Live (Sim)';
    }
}

function startUpdateLoop() {
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(updatePrice, CONFIG.updateInterval);
}

// ==========================================
// MT4/MT5 Connection
// ==========================================
async function connectMT4() {
    const token = document.getElementById('metaApiToken').value.trim();
    const accountId = document.getElementById('mt4AccountId').value.trim();

    if (!token || !accountId) {
        setMT4Status('error', '❌ Masukkan API Token dan Account ID');
        return;
    }

    const btnConnect = document.getElementById('btnConnect');
    btnConnect.disabled = true;
    btnConnect.innerHTML = '<span>⏳ Menghubungkan...</span>';
    setMT4Status('', '🔄 Menghubungkan ke akun MT4/MT5...');

    try {
        metaApi.setCredentials(token, accountId);

        // Step 1: Get account info to verify credentials
        setMT4Status('', '🔍 Memeriksa akun...');
        const accountInfo = await metaApi.getAccountInfo();

        setMT4Status('', `📡 Akun ditemukan: ${accountInfo.name || accountInfo.login} (${accountInfo.platform || 'MT4/MT5'}). Deploying...`);

        // Step 2: Deploy account
        await metaApi.deployAccount();
        setMT4Status('', '⏳ Menunggu koneksi ke server trading...');

        // Step 3: Wait for connection
        await metaApi.waitForConnection(30000);

        // Step 4: Try to get current price
        const priceData = await metaApi.getCurrentPrice();
        if (priceData) {
            state.dataSource = 'metaapi';
            state.currentPrice = priceData.price;
            metaApi.connected = true;

            setMT4Status('connected', `✅ Terhubung ke ${accountInfo.name || 'XM'} — ${accountInfo.platform || 'MT4/MT5'} | Harga: ${priceData.price.toFixed(2)}`);
            updateDataSourceBadge(true);

            // Save credentials
            localStorage.setItem('botgold_mt4', JSON.stringify({ token, accountId }));

            btnConnect.classList.add('hidden');
            document.getElementById('btnDisconnect').classList.remove('hidden');

            addAlert('info', '🔗 MT4/MT5 Terhubung', `Akun ${accountInfo.name || accountId} terhubung. Data real-time aktif.`);

            // Load historical candles from MT4
            await loadMT4Candles();
        } else {
            throw new Error('Tidak dapat mengambil harga. Coba lagi.');
        }
    } catch (error) {
        console.error('MT4 connection error:', error);
        setMT4Status('error', `❌ Gagal: ${error.message}`);
        state.dataSource = 'simulation';
        updateDataSourceBadge(false);
    } finally {
        btnConnect.disabled = false;
        btnConnect.innerHTML = '<span>🔌 Hubungkan</span>';
    }
}

function disconnectMT4() {
    metaApi.disconnect();
    state.dataSource = 'simulation';
    metaApi.connected = false;

    setMT4Status('', 'Terputus — menggunakan data simulasi');
    updateDataSourceBadge(false);

    document.getElementById('btnConnect').classList.remove('hidden');
    document.getElementById('btnDisconnect').classList.add('hidden');

    addAlert('info', '⛔ MT4/MT5 Terputus', 'Kembali menggunakan data simulasi.');

    // Reset to simulation
    priceData = priceEngine.generateHistoricalData(100);
    state.currentPrice = priceData[priceData.length - 1].close;
}

async function loadMT4Candles() {
    const tfMap = { '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', 'D': '1d' };
    const tf = tfMap[state.currentTF] || '15m';

    const candles = await metaApi.getCandles(tf, 100);
    if (candles && candles.length > 0) {
        priceData = candles;
        state.currentPrice = candles[candles.length - 1].close;

        const analysis = signalEngine.analyze(priceData);
        if (analysis) {
            updateSignalUI(analysis);
            checkSignalChange(analysis);
        }
        updatePriceDisplay();
    }
}

function setMT4Status(className, text) {
    const statusEl = document.getElementById('mt4Status');
    if (statusEl) statusEl.className = 'mt4-status ' + className;
    const textEl = document.getElementById('mt4StatusText');
    if (textEl) textEl.textContent = text;

    // Update badge
    const badge = document.getElementById('mt4StatusBadge');
    if (badge) {
        if (className === 'connected') {
            badge.style.background = 'rgba(34,197,94,0.15)';
            badge.style.color = '#22c55e';
            badge.textContent = '🟢 Terhubung';
        } else if (className === 'error') {
            badge.style.background = 'rgba(239,68,68,0.15)';
            badge.style.color = '#ef4444';
            badge.textContent = '🔴 Error';
        } else {
            badge.style.background = 'rgba(255,255,255,0.05)';
            badge.style.color = 'var(--text-muted)';
            badge.textContent = '⚪ Belum Terhubung';
        }
    }
}

function toggleAutoTrade(enabled) {
    const statusEl = document.getElementById('autoTradeStatus');
    const toggleEl = document.getElementById('autoTradeToggle');

    if (enabled && !metaApi.connected) {
        // Can't enable auto-trade without MetaAPI connection
        if (toggleEl) toggleEl.checked = false;
        if (statusEl) {
            statusEl.textContent = 'OFF';
            statusEl.style.color = '#ef4444';
        }
        addAlert('info', '⚠️ Auto-Trade', 'Hubungkan akun MT4/MT5 dulu sebelum mengaktifkan Auto-Trade!');
        setMT4Status('', '⚠️ Hubungkan akun MT4/MT5 dulu!');
        return;
    }

    state.autoTradeEnabled = enabled;

    if (statusEl) {
        if (enabled) {
            statusEl.textContent = 'ON';
            statusEl.style.color = '#22c55e';
            addAlert('info', '🤖 Auto-Trade ON', `Bot akan trading otomatis ${state.autoTradeLot} lot di akun demo`);
            setMT4Status('connected', `🤖 Auto-Trade AKTIF — ${state.autoTradeLot} lot per posisi`);
        } else {
            statusEl.textContent = 'OFF';
            statusEl.style.color = '#ef4444';
            addAlert('info', '⏹ Auto-Trade OFF', 'Bot tidak akan membuka posisi baru');
            setMT4Status('connected', '✅ Terhubung — Auto-Trade dimatikan');
        }
    }

    // Save setting
    localStorage.setItem('botgold_autotrade', JSON.stringify({
        enabled, lot: state.autoTradeLot
    }));
}

async function emergencyCloseAll() {
    if (!metaApi.connected) {
        addAlert('info', '⚠️', 'MetaAPI belum terhubung');
        return;
    }

    setMT4Status('', '🚨 Menutup semua posisi...');
    addAlert('sell', '🚨 EMERGENCY', 'Menutup semua posisi terbuka...');

    const result = await metaApi.closeAllTrades();
    if (result) {
        state.mt4PositionId = null;
        setMT4Status('connected', '✅ Semua posisi telah ditutup');
        addAlert('info', '✅ Semua Ditutup', 'Semua posisi berhasil ditutup');
    } else {
        setMT4Status('error', '❌ Gagal menutup beberapa posisi');
    }
}

function updateDataSourceBadge(isLive) {
    const badge = document.getElementById('dataSourceBadge');
    if (!badge) return;
    if (isLive) {
        badge.textContent = 'MT4/MT5 LIVE';
        badge.className = 'data-source-badge live';
    } else {
        badge.textContent = 'Simulasi';
        badge.className = 'data-source-badge';
    }
}

function loadMT4Settings() {
    const saved = localStorage.getItem('botgold_mt4');
    if (saved) {
        try {
            const s = JSON.parse(saved);
            document.getElementById('metaApiToken').value = s.token || '';
            document.getElementById('mt4AccountId').value = s.accountId || '';
        } catch (e) { }
    }
}

// ==========================================
// Price Update (MT4 or Real API or Simulation)
// ==========================================
let lastCandleRefresh = 0;
const CANDLE_REFRESH_INTERVAL = 30000; // Refresh full candle history every 30 seconds

async function updatePrice() {
    if (state.dataSource === 'metaapi' && metaApi.connected) {
        // Fetch real price from MT4/MT5
        const tick = await metaApi.getCurrentPrice();
        if (tick) {
            state.previousPrice = state.currentPrice;
            state.currentPrice = tick.price;

            // Add to price data as a new candle
            const lastCandle = priceData[priceData.length - 1];
            const newCandle = {
                time: Date.now(),
                open: lastCandle ? lastCandle.close : tick.price,
                high: Math.max(lastCandle ? lastCandle.close : tick.price, tick.price) + tick.spread,
                low: Math.min(lastCandle ? lastCandle.close : tick.price, tick.price) - tick.spread,
                close: tick.price,
                volume: Math.floor(Math.random() * 5000 + 1000)
            };
            priceData.push(newCandle);
            if (priceData.length > 200) priceData.shift();
        } else {
            return;
        }
    } else if (state.dataSource === 'realapi' && priceEngine.realFeed.isLocal) {
        // Real API mode — refresh candle history periodically
        const now = Date.now();

        if (now - lastCandleRefresh > CANDLE_REFRESH_INTERVAL) {
            // Full candle refresh from Yahoo Finance
            lastCandleRefresh = now;
            const tf = state.currentTF === '1' ? '1' : state.currentTF === '5' ? '5' : state.currentTF || '15';
            const realCandles = await priceEngine.realFeed.fetchRealCandles(tf);
            if (realCandles && realCandles.length > 10) {
                priceData = realCandles;
                state.currentPrice = realCandles[realCandles.length - 1].close;
                state.previousPrice = realCandles.length > 1 ? realCandles[realCandles.length - 2].close : state.currentPrice;
                console.log(`🔄 Candle data refreshed: ${realCandles.length} candles`);
            }
        }

        // Also update the latest price tick
        const newPrice = await priceEngine.getPrice();
        if (newPrice) {
            state.previousPrice = state.currentPrice;
            state.currentPrice = newPrice;

            // Update the LAST candle's close price with the latest tick
            if (priceData.length > 0) {
                const lastCandle = priceData[priceData.length - 1];
                lastCandle.close = newPrice;
                lastCandle.high = Math.max(lastCandle.high, newPrice);
                lastCandle.low = Math.min(lastCandle.low, newPrice);
            }
        }
    } else {
        // Pure simulation mode (no API connection)
        const newPrice = priceEngine.generateRealisticPrice();
        const prevPrice = state.currentPrice;
        const newCandle = {
            time: Date.now(),
            open: prevPrice,
            high: Math.max(prevPrice, newPrice) + Math.random() * 2.5,
            low: Math.min(prevPrice, newPrice) - Math.random() * 2.5,
            close: newPrice,
            volume: Math.floor(Math.random() * 10000 + 5000)
        };
        priceData.push(newCandle);
        if (priceData.length > 200) priceData.shift();
        state.previousPrice = prevPrice;
        state.currentPrice = newPrice;
    }

    updatePriceDisplay();
    const analysis = signalEngine.analyze(priceData);
    if (analysis) {
        updateSignalUI(analysis);
        checkSignalChange(analysis);
    }
    // Scalping analysis
    try {
        const scalpResult = scalpingEngine.analyze(priceData);
        if (scalpResult) {
            updateScalpingUI(scalpResult);
            // Auto-manage positions
            if (scalpResult.signal === 'OPEN_BUY') {
                scalpingEngine.openPosition('BUY', scalpResult.entry, scalpResult.tp1, scalpResult.tp2, scalpResult.sl);
                addAlert('buy', '⚡ SCALP BUY', `Entry: $${scalpResult.entry.toFixed(2)} | TP1: $${scalpResult.tp1.toFixed(2)} | SL: $${scalpResult.sl.toFixed(2)}`);
                // Push signal to server for EA
                pushSignalToServer('BUY', scalpResult.entry, scalpResult.tp1, scalpResult.tp2, scalpResult.sl, scalpResult.confidence);
                // Real trade via MetaAPI
                if (state.autoTradeEnabled && metaApi.connected) {
                    metaApi.openTrade('BUY', state.autoTradeLot, scalpResult.sl, scalpResult.tp1).then(result => {
                        if (result) {
                            state.mt4PositionId = result.positionId || result.orderId || null;
                            addAlert('buy', '🔥 REAL TRADE', `BUY ${state.autoTradeLot} lot berhasil di MT4! ID: ${state.mt4PositionId || 'OK'}`);
                            setMT4Status('connected', `🟢 Posisi BUY terbuka — ${state.autoTradeLot} lot`);
                        } else {
                            addAlert('info', '⚠️ TRADE GAGAL', 'Posisi BUY gagal di MT4, tetap simulasi');
                        }
                    });
                }
            } else if (scalpResult.signal === 'OPEN_SELL') {
                scalpingEngine.openPosition('SELL', scalpResult.entry, scalpResult.tp1, scalpResult.tp2, scalpResult.sl);
                addAlert('sell', '⚡ SCALP SELL', `Entry: $${scalpResult.entry.toFixed(2)} | TP1: $${scalpResult.tp1.toFixed(2)} | SL: $${scalpResult.sl.toFixed(2)}`);
                // Push signal to server for EA
                pushSignalToServer('SELL', scalpResult.entry, scalpResult.tp1, scalpResult.tp2, scalpResult.sl, scalpResult.confidence);
                // Real trade via MetaAPI
                if (state.autoTradeEnabled && metaApi.connected) {
                    metaApi.openTrade('SELL', state.autoTradeLot, scalpResult.sl, scalpResult.tp1).then(result => {
                        if (result) {
                            state.mt4PositionId = result.positionId || result.orderId || null;
                            addAlert('sell', '🔥 REAL TRADE', `SELL ${state.autoTradeLot} lot berhasil di MT4! ID: ${state.mt4PositionId || 'OK'}`);
                            setMT4Status('connected', `🔴 Posisi SELL terbuka — ${state.autoTradeLot} lot`);
                        } else {
                            addAlert('info', '⚠️ TRADE GAGAL', 'Posisi SELL gagal di MT4, tetap simulasi');
                        }
                    });
                }
            } else if (scalpResult.signal === 'CLOSE' && scalpingEngine.getPosition()) {
                scalpingEngine.closePosition(state.currentPrice);
                addAlert('info', '✖ SCALP TUTUP', scalpResult.subText);
                updateScalpingHistory();
                // Push close signal for EA
                pushSignalToServer('CLOSE', state.currentPrice, 0, 0, 0, 0);
                // Close real trade via MetaAPI
                if (state.autoTradeEnabled && metaApi.connected && state.mt4PositionId) {
                    metaApi.closeTrade(state.mt4PositionId).then(result => {
                        if (result) {
                            addAlert('info', '✅ REAL CLOSE', `Posisi MT4 ${state.mt4PositionId} ditutup`);
                            state.mt4PositionId = null;
                            setMT4Status('connected', '✅ Posisi ditutup — menunggu sinyal baru');
                        }
                    });
                }
            }
        }
    } catch (e) { console.warn('Scalping error:', e); }
    updateLastUpdate();
    drawChart(); // Redraw canvas chart with new candle
}

// Push signal to server for EA to pick up
function pushSignalToServer(direction, entry, tp1, tp2, sl, confidence) {
    if (!window.location.hostname.match(/localhost|127\.0\.0\.1/)) return;
    fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            direction, entry, tp1, tp2, sl,
            confidence, lot: state.autoTradeLot
        })
    }).catch(() => {});
}

// ==========================================
// UI Update Functions
// ==========================================
function loadSettings() {
    const saved = localStorage.getItem('botgold_settings');
    if (saved) {
        const s = JSON.parse(saved);
        state.capital = s.capital || 1000;
        state.riskPercent = s.riskPercent || 2;
        state.targetProfit = s.targetProfit || 5;
        document.getElementById('capitalInput').value = state.capital;
        document.getElementById('riskPercent').value = state.riskPercent;
        document.getElementById('targetProfit').value = state.targetProfit;
    }
    updateCapitalSummary();
}

function applyCapitalSettings() {
    state.capital = Math.max(10, parseFloat(document.getElementById('capitalInput').value) || 1000);
    state.riskPercent = Math.max(0.1, Math.min(10, parseFloat(document.getElementById('riskPercent').value) || 2));
    state.targetProfit = Math.max(0.5, Math.min(100, parseFloat(document.getElementById('targetProfit').value) || 5));

    localStorage.setItem('botgold_settings', JSON.stringify({
        capital: state.capital, riskPercent: state.riskPercent, targetProfit: state.targetProfit
    }));

    updateCapitalSummary();
    addAlert('info', '💰 Modal Diperbarui',
        `Modal: $${state.capital.toLocaleString()} | Risiko: ${state.riskPercent}% | Target: ${state.targetProfit}%`);

    if (priceData.length > 0) {
        const analysis = signalEngine.analyze(priceData);
        if (analysis) updateSignalUI(analysis);
    }
}

function updateCapitalSummary() {
    const maxRisk = state.capital * (state.riskPercent / 100);
    const targetAmount = state.capital * (state.targetProfit / 100);
    const atr = signalEngine.indicators.atr?.value || 15;
    const slPips = atr * 1.5;
    const safeLot = Math.max(0.01, Math.floor((maxRisk / (slPips * 100)) * 100) / 100);

    document.getElementById('sumCapital').textContent = '$' + state.capital.toLocaleString();
    document.getElementById('sumRisk').textContent = '$' + maxRisk.toFixed(2);
    document.getElementById('sumTarget').textContent = '$' + targetAmount.toFixed(2);
    document.getElementById('sumLot').textContent = safeLot.toFixed(2);
    document.getElementById('profitBarTargetLabel').textContent = `Target: $${targetAmount.toFixed(0)}`;
}

function updatePriceDisplay() {
    document.getElementById('currentPrice').textContent = state.currentPrice.toFixed(2);
    const change = state.currentPrice - state.previousPrice;
    const changePct = state.previousPrice ? (change / state.previousPrice) * 100 : 0;
    const changeEl = document.getElementById('priceChange');
    if (change >= 0) {
        changeEl.textContent = `+${change.toFixed(2)} (+${changePct.toFixed(3)}%)`;
        changeEl.className = 'price-change up';
    } else {
        changeEl.textContent = `${change.toFixed(2)} (${changePct.toFixed(3)}%)`;
        changeEl.className = 'price-change down';
    }
}

function updateSignalUI(analysis) {
    const arrowEl = document.getElementById('signalArrow');
    const labelEl = document.getElementById('signalLabel');
    const cardEl = document.getElementById('signalCard');
    cardEl.classList.remove('buy-active', 'sell-active');

    if (analysis.direction === 'BUY') {
        arrowEl.textContent = '📈';
        labelEl.textContent = analysis.signalLabel || 'BUY';
        labelEl.className = 'signal-label buy';
        cardEl.classList.add('buy-active', 'signal-active');
    } else if (analysis.direction === 'SELL') {
        arrowEl.textContent = '📉';
        labelEl.textContent = analysis.signalLabel || 'SELL';
        labelEl.className = 'signal-label sell';
        cardEl.classList.add('sell-active', 'signal-active');
    } else {
        arrowEl.textContent = '⏸️';
        labelEl.textContent = analysis.signalLabel || 'TUNGGU / HOLD';
        labelEl.className = 'signal-label neutral';
        cardEl.classList.remove('signal-active');
    }

    document.getElementById('signalTime').textContent = new Date().toLocaleTimeString('id-ID');

    // Confidence Ring
    const circumference = 2 * Math.PI * 52;
    const ring = document.getElementById('ringFill');
    ring.style.strokeDashoffset = circumference - (analysis.confidence / 100) * circumference;
    ring.className = 'ring-fill ' + analysis.direction.toLowerCase();
    document.getElementById('confidenceValue').textContent = analysis.confidence;

    // Vote bars
    const total = analysis.votes.buy + analysis.votes.sell + analysis.votes.neutral;
    document.getElementById('buyVotes').style.width = (analysis.votes.buy / total * 100) + '%';
    document.getElementById('sellVotes').style.width = (analysis.votes.sell / total * 100) + '%';
    document.getElementById('neutralVotes').style.width = (analysis.votes.neutral / total * 100) + '%';
    document.getElementById('buyCount').textContent = analysis.votes.buy;
    document.getElementById('sellCount').textContent = analysis.votes.sell;
    document.getElementById('neutralCount').textContent = analysis.votes.neutral;

    // Vote breakdown — show which indicators are BUY / SELL / NEUTRAL
    const indNameMap = {
        rsi: 'RSI', macd: 'MACD', ma: 'Moving Avg',
        bb: 'Bollinger', stoch: 'Stochastic', atr: 'ATR'
    };
    const buyInds = [], sellInds = [], neutralInds = [];
    for (const [key, ind] of Object.entries(analysis.indicators || {})) {
        const name = indNameMap[key] || key.toUpperCase();
        if (!ind || !ind.signal) continue;
        if (ind.signal === 'BUY') buyInds.push(name);
        else if (ind.signal === 'SELL') sellInds.push(name);
        else if (ind.signal === 'NEUTRAL') neutralInds.push(name);
    }
    // Also check techniques for ADX/Breakout/Price Action
    if (analysis.techniques) {
        if (analysis.techniques.trendFollowing) {
            const tf = analysis.techniques.trendFollowing;
            if (tf.trend === 'UPTREND' && tf.adx > 20) buyInds.push('ADX/Trend');
            else if (tf.trend === 'DOWNTREND' && tf.adx > 20) sellInds.push('ADX/Trend');
            else neutralInds.push('ADX/Trend');
        }
        if (analysis.techniques.breakout) {
            const bo = analysis.techniques.breakout;
            if (bo.signal === 'BUY') buyInds.push('Breakout');
            else if (bo.signal === 'SELL') sellInds.push('Breakout');
            else neutralInds.push('Breakout');
        }
        if (analysis.techniques.priceAction) {
            const pa = analysis.techniques.priceAction;
            if (pa.signal === 'BUY') buyInds.push('Price Action');
            else if (pa.signal === 'SELL') sellInds.push('Price Action');
            else neutralInds.push('Price Action');
        }
    }
    const makeTag = (name, cls) => `<span class="vb-tag ${cls}">${name}</span>`;
    const vbBuy = document.getElementById('vbBuyList');
    const vbSell = document.getElementById('vbSellList');
    const vbNeutral = document.getElementById('vbNeutralList');
    if (vbBuy) vbBuy.innerHTML = buyInds.length > 0 ? buyInds.map(n => makeTag(n, 'buy')).join('') : '<span style="color:var(--text-muted);font-size:10px">—</span>';
    if (vbSell) vbSell.innerHTML = sellInds.length > 0 ? sellInds.map(n => makeTag(n, 'sell')).join('') : '<span style="color:var(--text-muted);font-size:10px">—</span>';
    if (vbNeutral) vbNeutral.innerHTML = neutralInds.length > 0 ? neutralInds.map(n => makeTag(n, 'neutral')).join('') : '<span style="color:var(--text-muted);font-size:10px">—</span>';

    // Trend Stability Bar
    const tsBar = document.getElementById('trendStabilityBar');
    if (tsBar && analysis.direction !== 'NEUTRAL') {
        tsBar.style.display = 'flex';
        const tsBadge = document.getElementById('tsBadge');
        const tsStreak = document.getElementById('tsStreak');
        const tsReversal = document.getElementById('tsReversal');
        if (tsBadge) {
            tsBadge.textContent = analysis.trendStability || 'BARU';
            tsBadge.className = 'ts-badge ' + (analysis.trendStability || 'baru').toLowerCase();
        }
        if (tsStreak) tsStreak.textContent = (analysis.trendStreak || 0) + ' tick';
        if (tsReversal && analysis.estimatedReversal) {
            tsReversal.style.display = 'inline';
            tsReversal.textContent = analysis.estimatedReversal.message;
        } else if (tsReversal) {
            tsReversal.style.display = 'none';
        }
    } else if (tsBar) {
        tsBar.style.display = 'none';
    }

    updateIndicatorCards(analysis.indicators);
    updatePrediction(analysis);
    updateEntryRecommendation(analysis);
    if (analysis.techniques) updateTechniquesUI(analysis.techniques, analysis.votes);

    // === TP/SL Quick Info in Signal Card ===
    const tpInfo = document.getElementById('signalTpInfo');
    const opsStatus = document.getElementById('openPosStatus');

    if (analysis.direction !== 'NEUTRAL' && analysis.indicators?.pivots) {
        const atr = analysis.indicators.atr?.value || 15;
        const pivots = analysis.indicators.pivots;
        const price = analysis.price || state.currentPrice;
        let tp1, tp2, sl;

        if (analysis.direction === 'BUY') {
            sl = Math.max(pivots.s1 - 2, price - atr * 1.5);
            tp1 = pivots.r1; tp2 = pivots.r2;
        } else {
            sl = Math.min(pivots.r1 + 2, price + atr * 1.5);
            tp1 = pivots.s1; tp2 = pivots.s2;
        }

        const tp1Dist = Math.abs(tp1 - price);
        const slDist = Math.abs(price - sl);
        const rr = slDist > 0 ? (tp1Dist / slDist) : 0;

        // Populate TP/SL values
        if (tpInfo) {
            tpInfo.style.display = 'block';
            const sigTp1 = document.getElementById('sigTp1');
            const sigTp2 = document.getElementById('sigTp2');
            const sigSl = document.getElementById('sigSl');
            const sigRR = document.getElementById('sigRR');
            const sigTpDist = document.getElementById('sigTpDist');
            const sigSlDist = document.getElementById('sigSlDist');

            if (sigTp1) sigTp1.textContent = '$' + tp1.toFixed(2);
            if (sigTp2) sigTp2.textContent = '$' + tp2.toFixed(2);
            if (sigSl) sigSl.textContent = '$' + sl.toFixed(2);
            if (sigRR) sigRR.textContent = '1:' + rr.toFixed(1);
            if (sigTpDist) sigTpDist.textContent = 'TP1: +' + tp1Dist.toFixed(1) + ' pips';
            if (sigSlDist) sigSlDist.textContent = 'SL: -' + slDist.toFixed(1) + ' pips';
        }

        // === Open Position Decision ===
        if (opsStatus) {
            opsStatus.style.display = 'flex';
            const opsIcon = document.getElementById('opsIcon');
            const opsLabel = document.getElementById('opsLabel');
            const opsReason = document.getElementById('opsReason');

            // Score-based decision: 6 factors
            let openScore = 0;
            const reasons = [];

            // 1. Confidence threshold
            if (analysis.confidence >= 40) { openScore++; }
            else { reasons.push('Confidence rendah (' + analysis.confidence + '%)'); }

            // 2. Trend stability
            if (analysis.trendStability === 'TERKONFIRMASI' || analysis.trendStability === 'MANTAP') { openScore++; }
            else { reasons.push('Tren masih baru (belum terkonfirmasi)'); }

            // 3. Risk/Reward ratio
            if (rr >= 1.0) { openScore++; }
            else { reasons.push('R:R kurang baik (1:' + rr.toFixed(1) + ')'); }

            // 4. Dominant vote count
            const dominantVote = Math.max(analysis.votes.buy, analysis.votes.sell);
            if (dominantVote >= 3) { openScore++; }
            else { reasons.push('Indikator belum sepakat (' + dominantVote + '/8)'); }

            // 5. No reversal warning
            if (!analysis.estimatedReversal || analysis.estimatedReversal.warning !== 'DEKAT') { openScore++; }
            else { reasons.push('Potensi reversal terdeteksi'); }

            // 6. Not in sideways market
            if (analysis.marketCondition === 'TRENDING') { openScore++; }
            else { reasons.push('Pasar ' + (analysis.marketCondition || 'SIDEWAYS')); }

            // Determine status (now out of 6)
            opsStatus.className = 'open-position-status';
            if (openScore >= 5) {
                opsStatus.classList.add('ops-go');
                if (opsIcon) opsIcon.textContent = '✅';
                if (opsLabel) opsLabel.textContent = 'BOLEH OPEN ' + analysis.direction;
                if (opsReason) opsReason.textContent = 'TP1: $' + tp1.toFixed(2) + ' (+' + tp1Dist.toFixed(1) + ' pips) · R:R 1:' + rr.toFixed(1);
            } else if (openScore >= 4) {
                opsStatus.classList.add('ops-caution');
                if (opsIcon) opsIcon.textContent = '⚠️';
                if (opsLabel) opsLabel.textContent = 'HATI-HATI — Open Bisa';
                if (opsReason) opsReason.textContent = reasons.join(' · ');
            } else {
                opsStatus.classList.add('ops-stop');
                if (opsIcon) opsIcon.textContent = '🚫';
                if (opsLabel) opsLabel.textContent = 'JANGAN OPEN';
                if (opsReason) opsReason.textContent = reasons.join(' · ');
            }
        }
    } else {
        // NEUTRAL / SIDEWAYS — hide TP info
        if (tpInfo) tpInfo.style.display = 'none';
        if (opsStatus) {
            opsStatus.style.display = 'flex';
            opsStatus.className = 'open-position-status ops-stop';
            const opsIcon = document.getElementById('opsIcon');
            const opsLabel = document.getElementById('opsLabel');
            const opsReason = document.getElementById('opsReason');

            if (analysis.marketCondition === 'SIDEWAYS') {
                if (opsIcon) opsIcon.textContent = '↔️';
                if (opsLabel) opsLabel.textContent = 'SIDEWAYS — Jangan Open';
                if (opsReason) opsReason.textContent = (analysis.sidewaysReasons || []).slice(0, 3).join(' · ');
            } else if (analysis.marketCondition === 'RANGING') {
                if (opsIcon) opsIcon.textContent = '↔️';
                if (opsLabel) opsLabel.textContent = 'RANGING — Tunggu Breakout';
                if (opsReason) opsReason.textContent = (analysis.sidewaysReasons || []).slice(0, 3).join(' · ');
            } else {
                if (opsIcon) opsIcon.textContent = '⏸️';
                if (opsLabel) opsLabel.textContent = 'TUNGGU — Belum Ada Sinyal';
                if (opsReason) opsReason.textContent = 'Indikator belum menunjukkan arah yang jelas';
            }
        }
    }
}

// ==========================================
// Scalping UI Update
// ==========================================
function updateScalpingUI(result) {
    if (!result) return;
    try {
        // Update time
        const timeEl = document.getElementById('scalpTime');
        if (timeEl) timeEl.textContent = result.timestamp.toLocaleTimeString('id-ID');

        // Action box styling and content
        const actionBox = document.getElementById('scalpActionBox');
        const actionIcon = document.getElementById('scalpActionIcon');
        const actionText = document.getElementById('scalpActionText');
        const actionSub = document.getElementById('scalpActionSub');

        if (actionBox) {
            actionBox.className = 'scalp-action-box';
            if (result.signal === 'OPEN_BUY') {
                actionBox.classList.add('open-buy');
                if (actionIcon) actionIcon.textContent = '📈';
            } else if (result.signal === 'OPEN_SELL') {
                actionBox.classList.add('open-sell');
                if (actionIcon) actionIcon.textContent = '📉';
            } else if (result.signal === 'CLOSE') {
                actionBox.classList.add('close-pos');
                if (actionIcon) actionIcon.textContent = '✖';
            } else if (result.signal === 'HOLD') {
                actionBox.classList.add('open-buy'); // keep green for hold
                if (actionIcon) actionIcon.textContent = '📊';
            } else {
                if (actionIcon) actionIcon.textContent = '⏳';
            }
        }
        if (actionText) actionText.textContent = result.action;
        if (actionSub) actionSub.textContent = result.subText;

        // Confidence bar
        const confFill = document.getElementById('scalpConfFill');
        const confLabel = document.getElementById('scalpConfLabel');
        if (confFill) confFill.style.width = result.confidence + '%';
        if (confLabel) confLabel.textContent = `Kekuatan: ${result.confidence}%`;

        // Entry / TP / SL levels
        const fmt = v => v != null ? '$' + v.toFixed(2) : '—';
        const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

        setEl('scalpEntry', fmt(result.entry));
        setEl('scalpTP1', fmt(result.tp1));
        setEl('scalpTP2', fmt(result.tp2));
        setEl('scalpSL', fmt(result.sl));
        setEl('scalpRR', result.rrRatio || '—');
        setEl('scalpPipsTP', result.pipsTP != null ? result.pipsTP.toFixed(1) : '—');
        setEl('scalpPipsSL', result.pipsSL != null ? result.pipsSL.toFixed(1) : '—');

        // Fast indicators
        const indMap = {
            rsi: { valId: 'scalpRSI', sigId: 'scalpRSISig' },
            stoch: { valId: 'scalpStoch', sigId: 'scalpStochSig' },
            ema: { valId: 'scalpEMA', sigId: 'scalpEMASig' },
            bb: { valId: 'scalpBB', sigId: 'scalpBBSig' },
            spread: { valId: 'scalpSpread', sigId: 'scalpSpreadSig' }
        };

        for (const [key, ids] of Object.entries(indMap)) {
            const ind = result.indicators[key];
            const valEl = document.getElementById(ids.valId);
            const sigEl = document.getElementById(ids.sigId);
            if (ind) {
                if (valEl) valEl.textContent = typeof ind.value === 'number' ? ind.value.toFixed(2) : (ind.value || '—');
                if (sigEl) {
                    sigEl.textContent = ind.signal || '—';
                    sigEl.className = 'scalp-ind-sig ' + (ind.signal === 'BUY' ? 'buy' : ind.signal === 'SELL' ? 'sell' : 'neutral');
                }
            }
        }

        // Position management bar
        const posBar = document.getElementById('scalpPositionBar');
        const position = scalpingEngine.getPosition();
        if (posBar) {
            if (position) {
                posBar.style.display = 'flex';
                const posType = document.getElementById('scalpPosType');
                const posEntry = document.getElementById('scalpPosEntry');
                const posCurrent = document.getElementById('scalpPosCurrent');
                const posPnL = document.getElementById('scalpPosPnL');
                const posPips = document.getElementById('scalpPosPips');

                if (posType) {
                    posType.textContent = position.type;
                    posType.className = 'scalp-pos-type ' + (position.type === 'BUY' ? 'buy-pos' : 'sell-pos');
                }
                if (posEntry) posEntry.textContent = '$' + position.entry.toFixed(2);
                if (posCurrent) posCurrent.textContent = '$' + state.currentPrice.toFixed(2);

                const pnlPips = position.type === 'BUY'
                    ? (state.currentPrice - position.entry)
                    : (position.entry - state.currentPrice);
                const pnlDollar = pnlPips * 100 * 0.01; // rough estimate

                if (posPnL) {
                    posPnL.textContent = (pnlPips >= 0 ? '+' : '') + pnlPips.toFixed(2);
                    posPnL.className = 'scalp-pnl-value ' + (pnlPips >= 0 ? 'profit' : 'loss');
                }
                if (posPips) posPips.textContent = `(${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips)`;
            } else {
                posBar.style.display = 'none';
            }
        }
        // Reversal Warning UI
        const reversalBox = document.getElementById('scalpReversalAlert');
        if (reversalBox) {
            if (result.reversalState) {
                const rv = result.reversalState;
                reversalBox.style.display = 'flex';
                document.getElementById('reversalIcon').textContent = rv.strength >= 60 ? '🚨' : '⚠️';
                document.getElementById('reversalTitle').textContent =
                    rv.strength >= 60 ? '🔴 REVERSAL KUAT!' : '⚡ PERINGATAN REVERSAL';
                document.getElementById('reversalMsg').textContent = rv.message;
                document.getElementById('reversalMeterFill').style.width = rv.strength + '%';
                document.getElementById('reversalStrength').textContent = rv.strength + '%';
            } else {
                reversalBox.style.display = 'none';
            }
        }

        // Draw candle signal chart
        drawScalpCandleChart();
    } catch (e) {
        console.warn('updateScalpingUI error:', e);
    }
}

function updateScalpingHistory() {
    const histList = document.getElementById('scalpHistList');
    if (!histList) return;
    const history = scalpingEngine.getHistory();

    if (history.length === 0) {
        histList.innerHTML = '<div class="scalp-hist-empty">Belum ada posisi...</div>';
        return;
    }

    histList.innerHTML = history.map(h => `
        <div class="scalp-hist-item">
            <span class="hist-time">${h.time.toLocaleTimeString('id-ID')}</span>
            <span class="hist-type ${h.type.toLowerCase()}">${h.type}</span>
            <span class="hist-entry">$${h.entry.toFixed(2)} → $${h.exit.toFixed(2)}</span>
            <span class="hist-pnl ${h.pnl >= 0 ? 'profit' : 'loss'}">${h.pnl >= 0 ? '+' : ''}${h.pnl.toFixed(2)}</span>
            <span class="hist-result ${h.result === 'WIN' ? 'win' : 'lose'}">${h.result}</span>
        </div>
    `).join('');
}

// ==========================================
// Scalping Candle Signal Chart
// ==========================================
const scalpSignalLog = []; // Track signals per candle for drawing arrows

function drawScalpCandleChart() {
    const canvas = document.getElementById('scalpCandleCanvas');
    if (!canvas || priceData.length < 25) return;

    // High DPI support
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const padding = { top: 30, bottom: 25, left: 55, right: 20 };
    const chartW = W - padding.left - padding.right;
    const chartH = H - padding.top - padding.bottom;

    ctx.clearRect(0, 0, W, H);

    // Show last 30 candles
    const candleCount = Math.min(30, priceData.length);
    const candles = priceData.slice(-candleCount);
    const startIdx = priceData.length - candleCount;

    // Find price range
    let minPrice = Infinity, maxPrice = -Infinity;
    candles.forEach(c => {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    });
    const priceRange = maxPrice - minPrice || 1;
    minPrice -= priceRange * 0.12;
    maxPrice += priceRange * 0.18;
    const totalRange = maxPrice - minPrice;

    const candleWidth = chartW / candleCount;
    const bodyWidth = Math.max(3, candleWidth * 0.55);
    const priceToY = (p) => padding.top + chartH - ((p - minPrice) / totalRange * chartH);

    // ── Grid ──
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
        const y = padding.top + (chartH / 5) * i;
        ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(W - padding.right, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.fillText((maxPrice - (totalRange / 5) * i).toFixed(1), padding.left - 5, y + 3);
    }

    // ── Pre-compute indicators for each candle ──
    const signals = [];
    const ema9Vals = [], ema21Vals = [], bbUpperVals = [], bbLowerVals = [];

    for (let i = 0; i < candleCount; i++) {
        const dataSlice = priceData.slice(0, startIdx + i + 1);
        const candle = candles[i];
        const isUp = candle.close >= candle.open;
        let buyPts = 0, sellPts = 0;
        let sig = 'NONE';

        if (dataSlice.length >= 25) {
            const closes = dataSlice.map(d => d.close);
            const highs = dataSlice.map(d => d.high);
            const lows = dataSlice.map(d => d.low);

            // 1. RSI(7)
            const rsi7 = TechnicalIndicators.RSI(closes, 7);
            if (rsi7 !== null) {
                if (rsi7 < 25) buyPts += 2;
                else if (rsi7 < 40) buyPts += 1;
                else if (rsi7 > 75) sellPts += 2;
                else if (rsi7 > 60) sellPts += 1;
            }

            // 2. Stochastic(5,3)
            const stoch = TechnicalIndicators.Stochastic(highs, lows, closes, 5, 3);
            if (stoch !== null) {
                const kAboveD = stoch.k > stoch.d;
                if (stoch.k < 20 && kAboveD) buyPts += 2;
                else if (stoch.k < 30) buyPts += 1;
                else if (stoch.k > 80 && !kAboveD) sellPts += 2;
                else if (stoch.k > 70) sellPts += 1;
            }

            // 3. EMA 9/21 crossover
            const ema9 = TechnicalIndicators.EMA(closes, 9);
            const ema21 = TechnicalIndicators.EMA(closes, 21);
            ema9Vals.push(ema9);
            ema21Vals.push(ema21);
            if (ema9 !== null && ema21 !== null) {
                if (closes.length >= 2) {
                    const prevCloses = closes.slice(0, -1);
                    const prevEma9 = TechnicalIndicators.EMA(prevCloses, 9);
                    const prevEma21 = TechnicalIndicators.EMA(prevCloses, 21);
                    if (prevEma9 !== null && prevEma21 !== null) {
                        const prevSpread = prevEma9 - prevEma21;
                        const spread = ema9 - ema21;
                        if (prevSpread <= 0 && spread > 0) buyPts += 3; // Fresh cross up
                        else if (prevSpread >= 0 && spread < 0) sellPts += 3; // Fresh cross down
                        else if (spread > 0) buyPts += 1;
                        else sellPts += 1;
                    }
                }
            } else {
                ema9Vals.push(null);
                ema21Vals.push(null);
            }

            // 4. Bollinger Bands position
            const bb = TechnicalIndicators.BollingerBands(closes, 20, 2);
            if (bb !== null) {
                bbUpperVals.push(bb.upper);
                bbLowerVals.push(bb.lower);
                const pos = (bb.upper - bb.lower) > 0
                    ? (candle.close - bb.lower) / (bb.upper - bb.lower) : 0.5;
                if (pos <= 0.05) buyPts += 2;       // Touching lower band
                else if (pos < 0.25) buyPts += 1;   // Near lower
                else if (pos >= 0.95) sellPts += 2;  // Touching upper band
                else if (pos > 0.75) sellPts += 1;   // Near upper
            } else {
                bbUpperVals.push(null);
                bbLowerVals.push(null);
            }

            // 5. Candlestick patterns
            const bodySize = Math.abs(candle.close - candle.open);
            const upperWick = candle.high - Math.max(candle.open, candle.close);
            const lowerWick = Math.min(candle.open, candle.close) - candle.low;
            const totalSize = candle.high - candle.low;

            // Bullish engulfing
            if (i > 0) {
                const prev = candles[i - 1];
                const prevDown = prev.close < prev.open;
                if (prevDown && isUp && candle.close > prev.open && candle.open < prev.close) {
                    buyPts += 2; // Bullish engulfing
                }
                const prevUp = prev.close >= prev.open;
                if (prevUp && !isUp && candle.close < prev.open && candle.open > prev.close) {
                    sellPts += 2; // Bearish engulfing
                }
            }
            // Hammer (long lower wick, small body, bullish)
            if (totalSize > 0 && lowerWick / totalSize > 0.6 && bodySize / totalSize < 0.3) {
                buyPts += 1;
            }
            // Shooting star (long upper wick, small body, bearish)
            if (totalSize > 0 && upperWick / totalSize > 0.6 && bodySize / totalSize < 0.3) {
                sellPts += 1;
            }

            // Determine signal — need 4+ points for high accuracy
            if (buyPts >= 4 && buyPts > sellPts + 1) sig = 'BUY';
            else if (sellPts >= 4 && sellPts > buyPts + 1) sig = 'SELL';
        } else {
            ema9Vals.push(null);
            ema21Vals.push(null);
            bbUpperVals.push(null);
            bbLowerVals.push(null);
        }

        signals.push({ sig, buyPts, sellPts });
    }

    // ── Draw zone backgrounds ──
    // Find clusters of same-direction signals and shade the zone
    for (let i = 0; i < candleCount; i++) {
        const s = signals[i];
        if (s.sig === 'BUY' || s.sig === 'SELL') {
            const x = padding.left + i * candleWidth;
            const c = candles[i];
            const zoneTop = priceToY(c.high);
            const zoneBot = priceToY(c.low);

            ctx.fillStyle = s.sig === 'BUY'
                ? 'rgba(34, 197, 94, 0.08)'
                : 'rgba(239, 68, 68, 0.08)';
            ctx.fillRect(x, zoneTop - 10, candleWidth, (zoneBot - zoneTop) + 20);

            // Zone border line at close
            ctx.strokeStyle = s.sig === 'BUY'
                ? 'rgba(34, 197, 94, 0.3)'
                : 'rgba(239, 68, 68, 0.3)';
            ctx.lineWidth = 0.5;
            ctx.setLineDash([2, 2]);
            const closeY = priceToY(c.close);
            ctx.beginPath(); ctx.moveTo(x, closeY); ctx.lineTo(x + candleWidth, closeY); ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    // ── Draw Signal Zones (Entry/TP/SL bands) ──
    signalZones.forEach(zone => {
        const localStart = zone.startIndex - startIdx;
        const localEnd = zone.endIndex ? zone.endIndex - startIdx : candleCount;

        if (localEnd < 0 || localStart >= candleCount) return;

        const dStart = Math.max(0, localStart);
        const dEnd = Math.min(candleCount, localEnd);
        const x1 = padding.left + dStart * candleWidth;
        const x2 = padding.left + (dEnd + 1) * candleWidth;
        const zW = x2 - x1;
        const isActive = !zone.endIndex;

        const entryY = priceToY(zone.entry);
        const tp1Y = priceToY(zone.tp1);
        const tp2Y = priceToY(zone.tp2);
        const slY = priceToY(zone.sl);

        // Profit band (Entry → TP1)
        ctx.fillStyle = zone.direction === 'BUY'
            ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(x1, Math.min(entryY, tp1Y), zW, Math.abs(tp1Y - entryY));

        // Risk band (Entry → SL)
        ctx.fillStyle = zone.direction === 'BUY'
            ? 'rgba(239, 68, 68, 0.1)' : 'rgba(34, 197, 94, 0.1)';
        ctx.fillRect(x1, Math.min(entryY, slY), zW, Math.abs(slY - entryY));

        // Entry/TP/SL dashed lines
        const alpha = isActive ? 0.8 : 0.3;
        ctx.setLineDash([3, 2]);

        ctx.strokeStyle = `rgba(59, 130, 246, ${alpha})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, entryY); ctx.lineTo(x2, entryY); ctx.stroke();

        ctx.strokeStyle = `rgba(34, 197, 94, ${alpha})`; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(x1, tp1Y); ctx.lineTo(x2, tp1Y); ctx.stroke();

        ctx.strokeStyle = `rgba(239, 68, 68, ${alpha})`; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(x1, slY); ctx.lineTo(x2, slY); ctx.stroke();

        ctx.setLineDash([]);

        // Labels on right edge
        if (isActive) {
            const rX = Math.min(x2 + 2, W - padding.right - 40);
            ctx.font = 'bold 7px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
            ctx.fillText('→ Entry', rX, entryY + 3);
            ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
            ctx.fillText('→ TP', rX, tp1Y + 3);
            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.fillText('→ SL', rX, slY + 3);
        }
    });

    // ── Draw Bollinger Band channel ──
    ctx.beginPath();
    let bbStarted = false;
    for (let i = 0; i < candleCount; i++) {
        if (bbUpperVals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            const y = priceToY(bbUpperVals[i]);
            if (!bbStarted) { ctx.moveTo(x, y); bbStarted = true; }
            else ctx.lineTo(x, y);
        }
    }
    for (let i = candleCount - 1; i >= 0; i--) {
        if (bbLowerVals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            ctx.lineTo(x, priceToY(bbLowerVals[i]));
        }
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(147, 130, 220, 0.06)';
    ctx.fill();

    // BB upper/lower lines
    ctx.strokeStyle = 'rgba(147, 130, 220, 0.2)';
    ctx.lineWidth = 0.7;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    bbStarted = false;
    for (let i = 0; i < candleCount; i++) {
        if (bbUpperVals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            if (!bbStarted) { ctx.moveTo(x, priceToY(bbUpperVals[i])); bbStarted = true; }
            else ctx.lineTo(x, priceToY(bbUpperVals[i]));
        }
    }
    ctx.stroke();
    ctx.beginPath();
    bbStarted = false;
    for (let i = 0; i < candleCount; i++) {
        if (bbLowerVals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            if (!bbStarted) { ctx.moveTo(x, priceToY(bbLowerVals[i])); bbStarted = true; }
            else ctx.lineTo(x, priceToY(bbLowerVals[i]));
        }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Draw EMA lines ──
    // EMA 9 (cyan)
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let emaStarted = false;
    for (let i = 0; i < candleCount; i++) {
        if (ema9Vals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            if (!emaStarted) { ctx.moveTo(x, priceToY(ema9Vals[i])); emaStarted = true; }
            else ctx.lineTo(x, priceToY(ema9Vals[i]));
        }
    }
    ctx.stroke();
    // EMA 21 (orange)
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.5)';
    ctx.beginPath();
    emaStarted = false;
    for (let i = 0; i < candleCount; i++) {
        if (ema21Vals[i] !== null) {
            const x = padding.left + i * candleWidth + candleWidth / 2;
            if (!emaStarted) { ctx.moveTo(x, priceToY(ema21Vals[i])); emaStarted = true; }
            else ctx.lineTo(x, priceToY(ema21Vals[i]));
        }
    }
    ctx.stroke();

    // ── Draw position lines ──
    const position = scalpingEngine.getPosition();
    if (position) {
        // Entry (blue)
        const entryY = priceToY(position.entry);
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(padding.left, entryY); ctx.lineTo(W - padding.right, entryY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#3b82f6'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText('Entry ' + position.entry.toFixed(1), padding.left + 2, entryY - 3);
        // TP1 (green)
        const tp1Y = priceToY(position.tp1);
        ctx.strokeStyle = '#22c55e'; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(padding.left, tp1Y); ctx.lineTo(W - padding.right, tp1Y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#22c55e';
        ctx.fillText('TP1 ' + position.tp1.toFixed(1), padding.left + 2, tp1Y - 3);
        // SL (orange)
        const slY = priceToY(position.sl);
        ctx.strokeStyle = '#f97316'; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(padding.left, slY); ctx.lineTo(W - padding.right, slY); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#f97316';
        ctx.fillText('SL ' + position.sl.toFixed(1), padding.left + 2, slY - 3);
    }

    // ── Draw candles + signals ──
    candles.forEach((candle, i) => {
        const x = padding.left + i * candleWidth + candleWidth / 2;
        const isUp = candle.close >= candle.open;
        const color = isUp ? '#22c55e' : '#ef4444';

        // Wick
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, priceToY(candle.high)); ctx.lineTo(x, priceToY(candle.low)); ctx.stroke();

        // Body
        const openY = priceToY(candle.open);
        const closeY = priceToY(candle.close);
        const bodyTop = Math.min(openY, closeY);
        const bodyH = Math.max(1, Math.abs(openY - closeY));
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyH);

        const s = signals[i];

        // ── BUY signal arrow + label ──
        if (s.sig === 'BUY') {
            const arrowY = priceToY(candle.low) + 14;
            // Glow effect
            ctx.shadowColor = '#22c55e';
            ctx.shadowBlur = 6;
            ctx.fillStyle = '#22c55e';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('▲', x, arrowY);
            ctx.shadowBlur = 0;

            // Label with close price
            ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
            ctx.font = 'bold 7px sans-serif';
            ctx.fillText('BUY', x, arrowY + 10);
            ctx.fillText(candle.close.toFixed(0), x, arrowY + 18);

            // Close confirmation dot
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(x, closeY, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // ── SELL signal arrow + label ──
        if (s.sig === 'SELL') {
            const arrowY = priceToY(candle.high) - 8;
            ctx.shadowColor = '#ef4444';
            ctx.shadowBlur = 6;
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('▼', x, arrowY);
            ctx.shadowBlur = 0;

            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.font = 'bold 7px sans-serif';
            ctx.fillText('SELL', x, arrowY - 7);
            ctx.fillText(candle.close.toFixed(0), x, arrowY - 15);

            // Close confirmation dot
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.arc(x, closeY, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    // ── Current price line ──
    const lastPrice = candles[candles.length - 1].close;
    const curY = priceToY(lastPrice);
    ctx.strokeStyle = 'rgba(247, 201, 72, 0.7)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(padding.left, curY); ctx.lineTo(W - padding.right, curY); ctx.stroke();
    ctx.setLineDash([]);
    // Price tag
    ctx.fillStyle = 'rgba(247, 201, 72, 1)';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('$' + lastPrice.toFixed(2), W - padding.right - 2, curY - 4);

    // ── Legend overlay ──
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.fillText('— EMA 9', padding.left + 2, padding.top - 14);
    ctx.fillStyle = 'rgba(251, 146, 60, 0.7)';
    ctx.fillText('— EMA 21', padding.left + 52, padding.top - 14);
    ctx.fillStyle = 'rgba(147, 130, 220, 0.5)';
    ctx.fillText('▓ BB(20,2)', padding.left + 108, padding.top - 14);
}

function closeScalpPosition() {
    if (scalpingEngine.getPosition()) {
        scalpingEngine.closePosition(state.currentPrice);
        addAlert('info', '✖ SCALP TUTUP', `Posisi ditutup manual di $${state.currentPrice.toFixed(2)}`);
        updateScalpingHistory();
    }
}

function updateTechniquesUI(tech, votes) {
    // Total votes badge
    const total = votes.buy + votes.sell + votes.neutral;
    document.getElementById('techTotalVotes').textContent = `${total} Indikator Aktif`;

    // Trading Style
    if (tech.tradingStyle) {
        const ts = tech.tradingStyle;
        document.getElementById('techStyleName').textContent = ts.emoji + ' ' + ts.style;
        document.getElementById('techStyleDesc').textContent = ts.description;
        const styleIcon = document.querySelector('.style-icon');
        if (styleIcon) styleIcon.textContent = ts.emoji;
    }

    // Trend Following (ADX)
    if (tech.trendFollowing) {
        const tf = tech.trendFollowing;
        document.getElementById('techTrendValue').textContent = `ADX: ${tf.adx} | Tren: ${tf.trend}`;
        setIndSignal('techTrendSignal', tf.signal);
        const maxDI = Math.max(tf.plusDI, tf.minusDI, 1);
        document.getElementById('plusDIBar').style.width = Math.min(100, (tf.plusDI / maxDI) * 100) + '%';
        document.getElementById('minusDIBar').style.width = Math.min(100, (tf.minusDI / maxDI) * 100) + '%';
        document.getElementById('plusDIValue').textContent = tf.plusDI.toFixed(1);
        document.getElementById('minusDIValue').textContent = tf.minusDI.toFixed(1);
    }

    // Price Action
    if (tech.priceAction) {
        const pa = tech.priceAction;
        document.getElementById('techPAPatterns').textContent = pa.patternNames || 'Tidak ada pola';
        setIndSignal('techPASignal', pa.signal);
        const listEl = document.getElementById('techPAList');
        if (pa.patterns && pa.patterns.length > 0) {
            listEl.innerHTML = pa.patterns.map(p =>
                `<span class="pattern-tag ${p.type}">${p.emoji} ${p.name}</span>`
            ).join('');
        } else {
            listEl.innerHTML = '';
        }
    }

    // Breakout
    if (tech.breakout) {
        const bo = tech.breakout;
        document.getElementById('techBreakoutDesc').textContent = bo.description || '—';
        setIndSignal('techBreakoutSignal', bo.signal);
        document.getElementById('techBreakoutR').textContent = bo.resistance != null ? bo.resistance.toFixed(2) : '—';
        document.getElementById('techBreakoutS').textContent = bo.support != null ? bo.support.toFixed(2) : '—';
        document.getElementById('techBreakoutRange').textContent = bo.range != null ? bo.range.toFixed(2) : '—';
    }

    // Fibonacci
    if (tech.fibonacci) {
        const f = tech.fibonacci;
        document.getElementById('fib0').textContent = f.level_0.toFixed(2);
        document.getElementById('fib236').textContent = f.level_236.toFixed(2);
        document.getElementById('fib382').textContent = f.level_382.toFixed(2);
        document.getElementById('fib500').textContent = f.level_500.toFixed(2);
        document.getElementById('fib618').textContent = f.level_618.toFixed(2);
        document.getElementById('fib786').textContent = f.level_786.toFixed(2);
        document.getElementById('fib100').textContent = f.level_1.toFixed(2);
    }
}

// RSI Sparkline History & Drawing
const rsiHistory = [];
const RSI_HISTORY_MAX = 60;

function drawRSISparkline(value) {
    const canvas = document.getElementById('rsi-sparkline');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Add to history
    rsiHistory.push(value);
    if (rsiHistory.length > RSI_HISTORY_MAX) rsiHistory.shift();
    
    // Resize canvas for sharp rendering
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    const W = rect.width, H = rect.height;
    
    // Clear
    ctx.clearRect(0, 0, W, H);
    
    // Draw zones (oversold green, overbought red)
    const y30 = H - (30 / 100) * H;
    const y70 = H - (70 / 100) * H;
    
    // Oversold zone (0-30) - green tint
    ctx.fillStyle = 'rgba(0, 200, 83, 0.08)';
    ctx.fillRect(0, y30, W, H - y30);
    
    // Overbought zone (70-100) - red tint  
    ctx.fillStyle = 'rgba(255, 68, 68, 0.08)';
    ctx.fillRect(0, 0, W, y70);
    
    // Draw threshold lines at 30 and 70
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 0.5;
    
    ctx.strokeStyle = 'rgba(0, 200, 83, 0.5)';
    ctx.beginPath();
    ctx.moveTo(0, y30);
    ctx.lineTo(W, y30);
    ctx.stroke();
    
    ctx.strokeStyle = 'rgba(255, 68, 68, 0.5)';
    ctx.beginPath();
    ctx.moveTo(0, y70);
    ctx.lineTo(W, y70);
    ctx.stroke();
    
    // 50 line (neutral)
    const y50 = H - (50 / 100) * H;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.beginPath();
    ctx.moveTo(0, y50);
    ctx.lineTo(W, y50);
    ctx.stroke();
    
    ctx.setLineDash([]);
    
    // Draw RSI line
    if (rsiHistory.length < 2) return;
    
    const stepX = W / (RSI_HISTORY_MAX - 1);
    const offsetX = (RSI_HISTORY_MAX - rsiHistory.length) * stepX;
    
    // Gradient line
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    
    // Draw line segments with color based on value
    for (let i = 1; i < rsiHistory.length; i++) {
        const x0 = offsetX + (i - 1) * stepX;
        const y0 = H - (rsiHistory[i - 1] / 100) * H;
        const x1 = offsetX + i * stepX;
        const y1 = H - (rsiHistory[i] / 100) * H;
        const val = rsiHistory[i];
        
        if (val < 30) ctx.strokeStyle = '#00c853';
        else if (val > 70) ctx.strokeStyle = '#ff4444';
        else ctx.strokeStyle = '#ffd700';
        
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }
    
    // Fill area under line
    ctx.beginPath();
    ctx.moveTo(offsetX, H);
    for (let i = 0; i < rsiHistory.length; i++) {
        const x = offsetX + i * stepX;
        const y = H - (rsiHistory[i] / 100) * H;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(offsetX + (rsiHistory.length - 1) * stepX, H);
    ctx.closePath();
    const lastVal = rsiHistory[rsiHistory.length - 1];
    const fillColor = lastVal < 30 ? 'rgba(0,200,83,0.1)' : lastVal > 70 ? 'rgba(255,68,68,0.1)' : 'rgba(255,215,0,0.07)';
    ctx.fillStyle = fillColor;
    ctx.fill();
    
    // Draw current value dot
    const lastX = offsetX + (rsiHistory.length - 1) * stepX;
    const lastY = H - (lastVal / 100) * H;
    const dotColor = lastVal < 30 ? '#00c853' : lastVal > 70 ? '#ff4444' : '#ffd700';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Labels
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'left';
    ctx.fillText('70', 2, y70 + 8);
    ctx.fillText('30', 2, y30 - 2);
    
    // Current value label
    ctx.textAlign = 'right';
    ctx.fillStyle = dotColor;
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText(lastVal.toFixed(1), W - 3, lastY - 5);
}

function updateIndicatorCards(ind) {
    if (ind.rsi) {
        document.getElementById('rsi-value').textContent = ind.rsi.value.toFixed(2);
        setIndSignal('rsi-signal', ind.rsi.signal);
        document.getElementById('rsi-needle').style.left = ind.rsi.value + '%';
        // Update RSI period label dynamically
        if (ind.rsi.period) {
            const rsiLabel = document.getElementById('rsi-label');
            if (rsiLabel) rsiLabel.textContent = `RSI (${ind.rsi.period})`;
            const scalpLabel = document.getElementById('scalpRSILabel');
            if (scalpLabel) scalpLabel.textContent = `RSI (${ind.rsi.period})`;
        }
        // RSI Sparkline Chart
        drawRSISparkline(ind.rsi.value);
    }
    if (ind.macd) {
        document.getElementById('macd-value').textContent = ind.macd.value.toFixed(2);
        setIndSignal('macd-signal', ind.macd.signal);
        document.getElementById('macd-signal-line').textContent = ind.macd.signal_line.toFixed(2);
        const histEl = document.getElementById('macd-histogram');
        histEl.textContent = ind.macd.histogram.toFixed(2);
        histEl.style.color = ind.macd.histogram >= 0 ? 'var(--green)' : 'var(--red)';
    }
    if (ind.ma) {
        document.getElementById('ma-value').textContent = ind.ma.value;
        setIndSignal('ma-signal', ind.ma.signal);
        document.getElementById('sma20-value').textContent = ind.ma.sma20.toFixed(2);
        document.getElementById('ema50-value').textContent = ind.ma.ema50.toFixed(2);
    }
    if (ind.bb) {
        document.getElementById('bb-value').textContent = ind.bb.value;
        setIndSignal('bb-signal', ind.bb.signal);
        document.getElementById('bb-upper').textContent = ind.bb.upper.toFixed(2);
        document.getElementById('bb-lower').textContent = ind.bb.lower.toFixed(2);
    }
    if (ind.stoch) {
        document.getElementById('stoch-value').textContent = ind.stoch.value.toFixed(2);
        setIndSignal('stoch-signal', ind.stoch.signal);
        document.getElementById('stoch-needle').style.left = Math.min(100, Math.max(0, ind.stoch.value)) + '%';
    }
    if (ind.atr) {
        document.getElementById('atr-value').textContent = ind.atr.value.toFixed(2);
        const atrSig = document.getElementById('atr-signal');
        atrSig.textContent = ind.atr.signal;
        atrSig.className = 'ind-signal ' + (ind.atr.signal === 'HIGH' ? 'sell' : ind.atr.signal === 'LOW' ? 'buy' : 'neutral');
        document.getElementById('atr-vol').textContent = ind.atr.vol;
    }
}

function setIndSignal(id, signal) {
    const el = document.getElementById(id);
    el.textContent = signal;
    el.className = 'ind-signal ' + signal.toLowerCase();
}

function updatePrediction(analysis) {
    const pivots = analysis.indicators.pivots;
    if (!pivots) return;
    document.getElementById('r2Price').textContent = pivots.r2.toFixed(2);
    document.getElementById('r1Price').textContent = pivots.r1.toFixed(2);
    document.getElementById('pivotPrice').textContent = pivots.pivot.toFixed(2);
    document.getElementById('s1Price').textContent = pivots.s1.toFixed(2);
    document.getElementById('s2Price').textContent = pivots.s2.toFixed(2);
    document.getElementById('resistancePrice').textContent = pivots.r2.toFixed(2);
    document.getElementById('supportPrice').textContent = pivots.s2.toFixed(2);
    document.getElementById('markerPrice').textContent = state.currentPrice.toFixed(2);

    const range = pivots.r2 - pivots.s2;
    if (range > 0) {
        const position = Math.max(5, Math.min(95, ((pivots.r2 - state.currentPrice) / range) * 100));
        document.getElementById('currentPriceMarker').style.top = position + '%';
    }
}

function updateEntryRecommendation(analysis) {
    const atr = analysis.indicators.atr?.value || 15;
    const pivots = analysis.indicators.pivots;
    if (!pivots) return;

    const maxRisk = state.capital * (state.riskPercent / 100);
    let entry = state.currentPrice, sl, tp1, tp2;

    if (analysis.direction === 'BUY') {
        sl = Math.max(pivots.s1 - 2, state.currentPrice - atr * 1.5);
        tp1 = pivots.r1; tp2 = pivots.r2;
    } else if (analysis.direction === 'SELL') {
        sl = Math.min(pivots.r1 + 2, state.currentPrice + atr * 1.5);
        tp1 = pivots.s1; tp2 = pivots.s2;
    } else {
        sl = state.currentPrice - atr;
        tp1 = state.currentPrice + atr; tp2 = state.currentPrice + atr * 2;
    }

    const slDist = Math.abs(entry - sl);
    const tp1Dist = Math.abs(tp1 - entry);
    const lotSize = Math.max(0.01, Math.floor((maxRisk / (slDist * CONFIG.contractSize)) * 100) / 100);
    const potProfit = tp1Dist * CONFIG.contractSize * lotSize;
    const potLoss = slDist * CONFIG.contractSize * lotSize;
    const rr = slDist > 0 ? (tp1Dist / slDist).toFixed(1) : '0.0';

    document.getElementById('entryPrice').textContent = entry.toFixed(2);
    document.getElementById('entrySL').textContent = sl.toFixed(2);
    document.getElementById('entryTP1').textContent = tp1.toFixed(2);
    document.getElementById('entryTP2').textContent = tp2.toFixed(2);
    document.getElementById('entryLot').textContent = lotSize.toFixed(2) + ' lot';
    document.getElementById('entryProfit').textContent = '+$' + potProfit.toFixed(2);
    document.getElementById('entryLoss').textContent = '-$' + potLoss.toFixed(2);
    document.getElementById('entryRR').textContent = '1:' + rr;
    document.getElementById('sumLot').textContent = lotSize.toFixed(2);

    // === Direction Badge ===
    const badge = document.getElementById('entryDirectionBadge');
    if (badge) {
        badge.className = 'entry-direction-badge';
        if (analysis.direction === 'BUY') {
            badge.textContent = '📈 BUY';
            badge.classList.add('buy');
        } else if (analysis.direction === 'SELL') {
            badge.textContent = '📉 SELL';
            badge.classList.add('sell');
        } else {
            badge.textContent = '⏸ WAIT';
        }
    }

    // === Indicator Breakdown Tags ===
    const tagsContainer = document.getElementById('entryIndTags');
    if (tagsContainer) {
        const indNameMap = {
            rsi: 'RSI', macd: 'MACD', ma: 'Moving Avg',
            bb: 'Bollinger', stoch: 'Stochastic', atr: 'ATR'
        };
        const supportInds = [];
        const oppositeInds = [];
        const neutralInds = [];

        for (const [key, ind] of Object.entries(analysis.indicators || {})) {
            const name = indNameMap[key] || key.toUpperCase();
            if (!ind || !ind.signal) continue;
            if (ind.signal === analysis.direction) {
                supportInds.push(name);
            } else if (ind.signal === 'NEUTRAL' || ind.signal === 'WAIT') {
                neutralInds.push(name);
            } else {
                oppositeInds.push(name);
            }
        }

        // Also check techniques
        if (analysis.techniques) {
            if (analysis.techniques.trendFollowing) {
                const tf = analysis.techniques.trendFollowing;
                const adxDir = tf.trend === 'UPTREND' ? 'BUY' : tf.trend === 'DOWNTREND' ? 'SELL' : 'NEUTRAL';
                if (tf.adx > 20) {
                    if (adxDir === analysis.direction) supportInds.push('ADX/Trend');
                    else if (adxDir === 'NEUTRAL') neutralInds.push('ADX/Trend');
                    else oppositeInds.push('ADX/Trend');
                } else {
                    neutralInds.push('ADX/Trend');
                }
            }
            if (analysis.techniques.priceAction) {
                const pa = analysis.techniques.priceAction;
                if (pa.signal === analysis.direction) supportInds.push('Price Action');
                else if (pa.signal === 'NEUTRAL') neutralInds.push('Price Action');
                else oppositeInds.push('Price Action');
            }
            if (analysis.techniques.breakout) {
                const bo = analysis.techniques.breakout;
                if (bo.signal === analysis.direction) supportInds.push('Breakout');
                else if (bo.signal === 'NEUTRAL') neutralInds.push('Breakout');
                else oppositeInds.push('Breakout');
            }
        }

        const makeTag = (name, cls) => `<span class="vb-tag ${cls}">${name}</span>`;
        let html = '';

        if (analysis.direction === 'BUY' || analysis.direction === 'SELL') {
            const dirLabel = analysis.direction === 'BUY' ? 'buy' : 'sell';
            if (supportInds.length > 0) {
                html += `<span class="entry-ind-group-label" style="font-size:0.6rem;color:var(--text-muted);width:100%;margin-bottom:2px;">✅ Mendukung ${analysis.direction}:</span>`;
                html += supportInds.map(n => makeTag(n, dirLabel)).join('');
            }
            if (oppositeInds.length > 0) {
                html += `<span class="entry-ind-group-label" style="font-size:0.6rem;color:var(--text-muted);width:100%;margin-top:4px;margin-bottom:2px;">⚠️ Berlawanan:</span>`;
                html += oppositeInds.map(n => makeTag(n, dirLabel === 'buy' ? 'sell' : 'buy')).join('');
            }
            if (neutralInds.length > 0) {
                html += `<span class="entry-ind-group-label" style="font-size:0.6rem;color:var(--text-muted);width:100%;margin-top:4px;margin-bottom:2px;">⏸ Netral:</span>`;
                html += neutralInds.map(n => makeTag(n, 'neutral')).join('');
            }
        } else {
            html = '<span class="vb-tag neutral" style="font-size:0.6rem;">Menunggu konfluensi indikator...</span>';
        }

        tagsContainer.innerHTML = html;
    }
}

function checkSignalChange(analysis) {
    if (!state.lastSignal || state.lastSignal.direction !== analysis.direction) {
        if (analysis.direction === 'BUY') {
            addAlert('buy', '🟢 SINYAL BUY',
                `Confidence ${analysis.confidence}% | Harga: ${analysis.price.toFixed(2)} | ${analysis.votes.buy} indikator setuju`);
            addSignalMarker('BUY', analysis.price, analysis.confidence, priceData.length - 1);
        } else if (analysis.direction === 'SELL') {
            addAlert('sell', '🔴 SINYAL SELL',
                `Confidence ${analysis.confidence}% | Harga: ${analysis.price.toFixed(2)} | ${analysis.votes.sell} indikator setuju`);
            addSignalMarker('SELL', analysis.price, analysis.confidence, priceData.length - 1);
        }

        // === Create Trading Zone ===
        if (analysis.direction === 'BUY' || analysis.direction === 'SELL') {
            // Close previous zone
            if (signalZones.length > 0) {
                const lastZone = signalZones[signalZones.length - 1];
                if (!lastZone.endIndex) lastZone.endIndex = priceData.length - 1;
            }

            // Calculate zone levels from ATR and pivots
            const atr = analysis.indicators.atr?.value || 15;
            const pivots = analysis.indicators.pivots;
            const entry = analysis.price;
            let sl, tp1, tp2;

            if (analysis.direction === 'BUY') {
                sl = pivots ? Math.max(pivots.s1 - 2, entry - atr * 1.5) : entry - atr * 1.5;
                tp1 = pivots ? pivots.r1 : entry + atr * 2;
                tp2 = pivots ? pivots.r2 : entry + atr * 3;
            } else {
                sl = pivots ? Math.min(pivots.r1 + 2, entry + atr * 1.5) : entry + atr * 1.5;
                tp1 = pivots ? pivots.s1 : entry - atr * 2;
                tp2 = pivots ? pivots.s2 : entry - atr * 3;
            }

            signalZones.push({
                startIndex: priceData.length - 1,
                direction: analysis.direction,
                entry, tp1, tp2, sl,
                confidence: analysis.confidence,
                time: Date.now(),
                endIndex: null // Still active
            });

            // Keep max 20 zones
            if (signalZones.length > 20) signalZones.shift();
        } else {
            // NEUTRAL — close any active zone
            if (signalZones.length > 0) {
                const lastZone = signalZones[signalZones.length - 1];
                if (!lastZone.endIndex) lastZone.endIndex = priceData.length - 1;
            }
        }

        addToHistory(analysis);
    }
    state.lastSignal = analysis;
}

// ==========================================
// Alert & History
// ==========================================
function addAlert(type, title, desc) {
    state.alerts.unshift({ type, title, desc, time: new Date().toLocaleTimeString('id-ID') });
    if (state.alerts.length > CONFIG.alertsMax) state.alerts.pop();
    renderAlerts();
}

function renderAlerts() {
    const list = document.getElementById('alertsList');
    if (state.alerts.length === 0) {
        list.innerHTML = '<div class="alert-empty"><span>⏳</span><p>Menunggu sinyal...</p></div>';
        return;
    }
    list.innerHTML = state.alerts.map(a => `
        <div class="alert-item ${a.type}">
            <div class="alert-content">
                <div class="alert-title">${a.title}</div>
                <div class="alert-desc">${a.desc}</div>
            </div>
            <span class="alert-time-stamp">${a.time}</span>
        </div>`).join('');
}

function clearAlerts() {
    state.alerts = [];
    renderAlerts();
}

function addToHistory(analysis) {
    state.signals.unshift({
        time: new Date().toLocaleTimeString('id-ID'),
        direction: analysis.direction,
        price: analysis.price.toFixed(2),
        confidence: analysis.confidence
    });
    if (state.signals.length > CONFIG.historyMax) state.signals.pop();
    renderHistory();
}

function renderHistory() {
    const tbody = document.getElementById('historyBody');
    if (state.signals.length === 0) {
        tbody.innerHTML = '<tr class="history-empty"><td colspan="4">Belum ada riwayat</td></tr>';
        return;
    }
    tbody.innerHTML = state.signals.slice(0, 20).map(s => `
        <tr>
            <td>${s.time}</td>
            <td><span class="history-signal ${s.direction.toLowerCase()}">${s.direction}</span></td>
            <td>${s.price}</td>
            <td>${s.confidence}%</td>
        </tr>`).join('');
}

// ==========================================
// Custom Canvas Chart with BUY/SELL Markers
// ==========================================
let signalHistory = []; // { index, direction, price, confidence }
let signalZones = []; // { startIndex, direction, entry, tp1, tp2, sl, confidence, time, endIndex }
let chartCanvas = null;
let chartCtx = null;
let chartAnimId = null;

function initTradingViewChart() {
    chartCanvas = document.getElementById('signalChart');
    if (!chartCanvas) return;
    chartCtx = chartCanvas.getContext('2d');

    // Handle resize
    const resizeChart = () => {
        const container = document.getElementById('chartContainer');
        const dpr = window.devicePixelRatio || 1;
        chartCanvas.width = container.clientWidth * dpr;
        chartCanvas.height = container.clientHeight * dpr;
        chartCtx.scale(dpr, dpr);
        chartCanvas.style.width = container.clientWidth + 'px';
        chartCanvas.style.height = container.clientHeight + 'px';
        drawChart();
    };

    window.addEventListener('resize', resizeChart);
    resizeChart();

    // Mouse crosshair
    chartCanvas.addEventListener('mousemove', (e) => {
        const rect = chartCanvas.getBoundingClientRect();
        drawChart(e.clientX - rect.left, e.clientY - rect.top);
    });
    chartCanvas.addEventListener('mouseleave', () => drawChart());
}

function addSignalMarker(direction, price, confidence, index) {
    signalHistory.push({ index, direction, price, confidence, time: Date.now() });
    // Keep last 200
    if (signalHistory.length > 200) signalHistory.shift();
}

function drawChart(mouseX, mouseY) {
    if (!chartCtx || !chartCanvas) return;

    const container = document.getElementById('chartContainer');
    const W = container.clientWidth;
    const H = container.clientHeight;

    const ctx = chartCtx;
    ctx.clearRect(0, 0, W, H);

    const visibleCandles = Math.min(priceData.length, 60);
    const data = priceData.slice(-visibleCandles);
    if (data.length < 3) return;

    // Layout
    const padLeft = 12;
    const padRight = 65;
    const padTop = 20;
    const padBottom = 25;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    // Price range
    let minPrice = Infinity, maxPrice = -Infinity;
    data.forEach(c => {
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
    });
    const priceRange = maxPrice - minPrice || 1;
    const pricePad = priceRange * 0.08;
    minPrice -= pricePad;
    maxPrice += pricePad;
    const totalRange = maxPrice - minPrice;

    const priceToY = (p) => padTop + chartH - ((p - minPrice) / totalRange) * chartH;
    const candleW = chartW / visibleCandles;
    const bodyW = Math.max(3, candleW * 0.6);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.04)';
    ctx.lineWidth = 1;
    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
        const py = padTop + (chartH / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, py);
        ctx.lineTo(W - padRight, py);
        ctx.stroke();

        // Price labels
        const priceLabel = (maxPrice - (totalRange / gridLines) * i).toFixed(2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(priceLabel, W - padRight + 6, py + 3);
    }

    // SMA20 line
    if (data.length >= 20) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(247, 201, 72, 0.5)';
        ctx.lineWidth = 1.5;
        let started = false;
        for (let i = 19; i < data.length; i++) {
            let sum = 0;
            for (let j = i - 19; j <= i; j++) sum += data[j].close;
            const sma = sum / 20;
            const x = padLeft + (i + 0.5) * candleW;
            const y = priceToY(sma);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // ── Trading Signal Zones ──
    const dataStartIndex = priceData.length - visibleCandles;
    signalZones.forEach(zone => {
        const localStart = zone.startIndex - dataStartIndex;
        const localEnd = zone.endIndex ? zone.endIndex - dataStartIndex : visibleCandles;

        // Skip if zone is completely out of view
        if (localEnd < 0 || localStart >= visibleCandles) return;

        const drawStart = Math.max(0, localStart);
        const drawEnd = Math.min(visibleCandles, localEnd);
        const x1 = padLeft + drawStart * candleW;
        const x2 = padLeft + (drawEnd + 1) * candleW;
        const zoneW = x2 - x1;

        const isActive = !zone.endIndex;

        // TP Zone (profit area — green shade)
        const entryY = priceToY(zone.entry);
        const tp1Y = priceToY(zone.tp1);
        const tp2Y = priceToY(zone.tp2);
        const slY = priceToY(zone.sl);

        // Profit zone (Entry → TP1)
        const profitTop = Math.min(entryY, tp1Y);
        const profitH = Math.abs(tp1Y - entryY);
        ctx.fillStyle = zone.direction === 'BUY'
            ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)';
        ctx.fillRect(x1, profitTop, zoneW, profitH);

        // Extended profit zone (TP1 → TP2) — lighter
        const extTop = Math.min(tp1Y, tp2Y);
        const extH = Math.abs(tp2Y - tp1Y);
        ctx.fillStyle = zone.direction === 'BUY'
            ? 'rgba(34, 197, 94, 0.04)' : 'rgba(239, 68, 68, 0.04)';
        ctx.fillRect(x1, extTop, zoneW, extH);

        // Risk zone (Entry → SL)
        const riskTop = Math.min(entryY, slY);
        const riskH = Math.abs(slY - entryY);
        ctx.fillStyle = zone.direction === 'BUY'
            ? 'rgba(239, 68, 68, 0.08)' : 'rgba(34, 197, 94, 0.08)';
        ctx.fillRect(x1, riskTop, zoneW, riskH);

        // Zone lines
        const lineAlpha = isActive ? 0.7 : 0.3;
        const dashPattern = [4, 3];

        // Entry line (blue/orange)
        ctx.strokeStyle = `rgba(59, 130, 246, ${lineAlpha})`;
        ctx.lineWidth = isActive ? 1.5 : 0.8;
        ctx.setLineDash(dashPattern);
        ctx.beginPath(); ctx.moveTo(x1, entryY); ctx.lineTo(x2, entryY); ctx.stroke();

        // TP1 line (green)
        ctx.strokeStyle = `rgba(34, 197, 94, ${lineAlpha})`;
        ctx.lineWidth = isActive ? 1.2 : 0.6;
        ctx.beginPath(); ctx.moveTo(x1, tp1Y); ctx.lineTo(x2, tp1Y); ctx.stroke();

        // TP2 line (green lighter)
        ctx.strokeStyle = `rgba(34, 197, 94, ${lineAlpha * 0.6})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(x1, tp2Y); ctx.lineTo(x2, tp2Y); ctx.stroke();

        // SL line (red)
        ctx.strokeStyle = `rgba(239, 68, 68, ${lineAlpha})`;
        ctx.lineWidth = isActive ? 1.2 : 0.6;
        ctx.beginPath(); ctx.moveTo(x1, slY); ctx.lineTo(x2, slY); ctx.stroke();

        ctx.setLineDash([]);

        // Zone labels (only for visible zones — on the left side)
        if (localStart >= 0 && isActive) {
            const labelX = x1 + 3;
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'left';

            // Direction badge
            const badgeY = Math.min(entryY, tp1Y, slY) - 6;
            ctx.fillStyle = zone.direction === 'BUY' ? '#22c55e' : '#ef4444';
            ctx.fillText(zone.direction + ' ZONE', labelX, badgeY);

            // Entry label
            ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
            ctx.font = '7px sans-serif';
            ctx.fillText('Entry ' + zone.entry.toFixed(1), labelX, entryY - 2);

            // TP1 label
            ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
            ctx.fillText('TP1 ' + zone.tp1.toFixed(1), labelX, tp1Y - 2);

            // TP2 label
            ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
            ctx.fillText('TP2 ' + zone.tp2.toFixed(1), labelX, tp2Y - 2);

            // SL label
            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.fillText('SL ' + zone.sl.toFixed(1), labelX, slY + 9);
        }
    });

    // Candlesticks
    data.forEach((candle, i) => {
        const x = padLeft + (i + 0.5) * candleW;
        const isBullish = candle.close >= candle.open;
        const openY = priceToY(candle.open);
        const closeY = priceToY(candle.close);
        const highY = priceToY(candle.high);
        const lowY = priceToY(candle.low);

        // Wick
        ctx.strokeStyle = isBullish ? '#22c55e' : '#ef4444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // Body
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1, Math.abs(closeY - openY));

        if (isBullish) {
            ctx.fillStyle = 'rgba(34, 197, 94, 0.85)';
            ctx.strokeStyle = '#22c55e';
        } else {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
            ctx.strokeStyle = '#ef4444';
        }
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);
        ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);
    });

    // BUY/SELL Signal Markers
    // (reuse dataStartIndex declared above for zones)
    signalHistory.forEach(sig => {
        const localIdx = sig.index - dataStartIndex;
        if (localIdx < 0 || localIdx >= visibleCandles) return;
        const candle = data[localIdx];
        if (!candle) return;

        const x = padLeft + (localIdx + 0.5) * candleW;

        if (sig.direction === 'BUY') {
            const y = priceToY(candle.low) + 16;
            // Arrow triangle pointing up
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.moveTo(x, y - 12);
            ctx.lineTo(x - 6, y);
            ctx.lineTo(x + 6, y);
            ctx.closePath();
            ctx.fill();
            // Label
            ctx.fillStyle = '#22c55e';
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('BUY', x, y + 10);
            // Confidence
            ctx.fillStyle = 'rgba(34,197,94,0.6)';
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.fillText(sig.confidence + '%', x, y + 19);
        } else if (sig.direction === 'SELL') {
            const y = priceToY(candle.high) - 16;
            // Arrow triangle pointing down
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(x, y + 12);
            ctx.lineTo(x - 6, y);
            ctx.lineTo(x + 6, y);
            ctx.closePath();
            ctx.fill();
            // Label
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 9px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('SELL', x, y - 4);
            // Confidence
            ctx.fillStyle = 'rgba(239,68,68,0.6)';
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.fillText(sig.confidence + '%', x, y - 13);
        }
    });

    // Crosshair
    if (mouseX !== undefined && mouseY !== undefined &&
        mouseX > padLeft && mouseX < W - padRight &&
        mouseY > padTop && mouseY < padTop + chartH) {

        // Vertical line
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(mouseX, padTop);
        ctx.lineTo(mouseX, padTop + chartH);
        ctx.stroke();

        // Horizontal line
        ctx.beginPath();
        ctx.moveTo(padLeft, mouseY);
        ctx.lineTo(W - padRight, mouseY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Price label at crosshair
        const hoverPrice = maxPrice - ((mouseY - padTop) / chartH) * totalRange;
        ctx.fillStyle = 'rgba(247, 201, 72, 0.9)';
        ctx.fillRect(W - padRight, mouseY - 9, padRight, 18);
        ctx.fillStyle = '#0a0a0f';
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(hoverPrice.toFixed(2), W - padRight + 4, mouseY + 4);

        // Candle info tooltip
        const candleIdx = Math.floor((mouseX - padLeft) / candleW);
        if (candleIdx >= 0 && candleIdx < data.length) {
            const c = data[candleIdx];
            const tooltipText = `O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`;
            ctx.fillStyle = 'rgba(10, 10, 15, 0.9)';
            ctx.fillRect(padLeft + 4, padTop + 2, ctx.measureText(tooltipText).width + 12, 18);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            ctx.fillText(tooltipText, padLeft + 10, padTop + 14);
        }
    }

    // Current price line
    if (data.length > 0) {
        const lastClose = data[data.length - 1].close;
        const cpY = priceToY(lastClose);
        ctx.strokeStyle = 'rgba(247, 201, 72, 0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(padLeft, cpY);
        ctx.lineTo(W - padRight, cpY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Price tag
        ctx.fillStyle = 'rgba(247, 201, 72, 0.9)';
        ctx.fillRect(W - padRight, cpY - 10, padRight, 20);
        ctx.fillStyle = '#0a0a0f';
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(lastClose.toFixed(2), W - padRight + 4, cpY + 4);
    }
}

function changeTF(tf) {
    state.currentTF = tf;
    document.querySelectorAll('#tfSelector .tf-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tf === tf));
    // Update RSI period labels based on timeframe
    const rsiP = (tf === '1' || tf === '5') ? 9 : 14;
    const rsiLabel = document.getElementById('rsi-label');
    const scalpLabel = document.getElementById('scalpRSILabel');
    if (rsiLabel) rsiLabel.textContent = `RSI (${rsiP})`;
    if (scalpLabel) scalpLabel.textContent = `RSI (${rsiP})`;
    // Reinit TradingView with selected interval
    if (typeof initTradingViewWidget === 'function' && chartMode === 'tradingview') {
        initTradingViewWidget(null, tf);
    }
    // If connected to MT4, reload candles for new TF
    if (state.dataSource === 'metaapi' && metaApi.connected) {
        loadMT4Candles();
    }
}

function updateConnectionStatus() {
    const badge = document.getElementById('connectionStatus');
    if (state.isConnected) {
        badge.className = 'status-badge online';
        const label = state.dataSource === 'metaapi' ? 'MT4 Live' :
            state.dataSource === 'realapi' ? 'Live (API)' : 'Live (Sim)';
        badge.querySelector('span:last-child').textContent = label;
    } else {
        badge.className = 'status-badge';
        badge.querySelector('span:last-child').textContent = 'Offline';
    }
}

function updateLastUpdate() {
    document.getElementById('lastUpdate').textContent = 'Update: ' + new Date().toLocaleTimeString('id-ID');
}

// ==========================================
// Init
// ==========================================
document.addEventListener('DOMContentLoaded', init);
