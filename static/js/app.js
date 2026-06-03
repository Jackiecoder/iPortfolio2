// Portfolio Tracker Frontend Application

// --- Access token: attached to every API request as a Bearer header. ---
// Stored in localStorage; shown as an in-page prompt on the first 401.
(function setupAuth() {
    const TOKEN_KEY = 'iportfolio_token';
    let promptVisible = false;

    window.getAccessToken = () => localStorage.getItem(TOKEN_KEY) || '';
    window.clearAccessToken = () => localStorage.removeItem(TOKEN_KEY);

    function normalizeToken(raw) {
        let token = (raw || '').trim();
        token = token.replace(/^API_TOKEN=/i, '').trim();
        token = token.replace(/^Bearer\s+/i, '').trim();
        token = token.replace(/^['"]|['"]$/g, '').trim();
        return token;
    }

    function showTokenPrompt(message = 'Enter the access token to load portfolio data.') {
        if (promptVisible) return;
        promptVisible = true;

        const existing = document.getElementById('accessTokenOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'accessTokenOverlay';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:99999',
            'background:rgba(15,23,42,.72)',
            'display:flex',
            'align-items:flex-start',
            'justify-content:center',
            'padding:72px 20px'
        ].join(';');

        overlay.innerHTML = `
            <div class="access-token-panel" style="width:min(560px,100%);background:#fff;border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.35);padding:22px;color:#111827;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                <h2 style="font-size:20px;margin:0 0 8px;">Access token required</h2>
                <p style="margin:0 0 16px;color:#4b5563;line-height:1.45;">${message}</p>
                <input id="accessTokenInput" type="password" autocomplete="off" spellcheck="false"
                    placeholder="Paste token, API_TOKEN=..., or Bearer ..."
                    style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;font-size:16px;">
                <div id="accessTokenHint" style="min-height:20px;margin-top:8px;font-size:13px;color:#64748b;"></div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">
                    <button id="accessTokenClear" type="button" style="border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:9px 14px;cursor:pointer;">Clear</button>
                    <button id="accessTokenSave" type="button" style="border:0;background:#0d6efd;color:#fff;border-radius:6px;padding:9px 16px;cursor:pointer;">Save & reload</button>
                </div>
            </div>
        `;

        const attach = () => {
            document.body.appendChild(overlay);
            const input = document.getElementById('accessTokenInput');
            const hint = document.getElementById('accessTokenHint');

            const updateHint = () => {
                const token = normalizeToken(input.value);
                hint.textContent = token ? `Token length: ${token.length}` : '';
                hint.style.color = token && token.length !== 48 ? '#b45309' : '#64748b';
            };

            const save = () => {
                const token = normalizeToken(input.value);
                if (!token) {
                    hint.textContent = 'Paste the 48-character token from Secret Manager.';
                    hint.style.color = '#dc2626';
                    return;
                }
                localStorage.setItem(TOKEN_KEY, token);
                location.reload();
            };

            input.addEventListener('input', updateHint);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') save();
            });
            document.getElementById('accessTokenSave').addEventListener('click', save);
            document.getElementById('accessTokenClear').addEventListener('click', () => {
                window.clearAccessToken();
                input.value = '';
                updateHint();
                input.focus();
            });
            input.focus();
        };

        if (document.body) {
            attach();
        } else {
            window.addEventListener('DOMContentLoaded', attach, { once: true });
        }
    }

    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const headers = new Headers(init.headers || {});
        const token = window.getAccessToken();
        if (token) headers.set('Authorization', 'Bearer ' + token);
        return origFetch(input, { ...init, headers }).then((resp) => {
            if (resp.status === 401) {
                window.clearAccessToken();
                showTokenPrompt('The saved token was missing or rejected. Paste the current token and reload.');
            }
            return resp;
        });
    };
})();

// Chart instances
let performanceChart = null;
let investmentChart = null;
let allocationChart = null;
let pnlChart = null;
let intradayChart = null;

// Portfolio chart view mode
let portfolioChartView = 'investment'; // 'value' or 'investment'
let currentPerformanceData = null; // Store performance data for chart switching
let portfolioPeriod = '1Y'; // Portfolio chart period (global for both value and investment views)

// Current intraday interval
let currentInterval = '1m';
// Current intraday date (null = today)
let currentIntradayDate = null;

// Anonymous mode
let anonymousMode = localStorage.getItem('anonymousMode') === 'true';

// Transaction detail cache (symbol -> array of transactions)
const transactionCache = {};

// Allocation view mode
let allocationView = 'assets'; // 'assets', 'category', or a specific category name
let selectedCategory = null; // When drilling into a specific category
let currentHoldingsForAllocation = null;

// Check if today is a US stock market trading day
function isMarketDay(date = new Date()) {
    const day = date.getDay();
    // Weekend check (0 = Sunday, 6 = Saturday)
    if (day === 0 || day === 6) {
        return false;
    }

    // Check for major US market holidays
    const month = date.getMonth(); // 0-indexed
    const dayOfMonth = date.getDate();
    const year = date.getFullYear();

    // New Year's Day (Jan 1, or observed on Monday if falls on Sunday)
    if (month === 0 && dayOfMonth === 1) return false;
    if (month === 0 && dayOfMonth === 2 && day === 1) return false; // Observed

    // Martin Luther King Jr. Day (3rd Monday of January)
    if (month === 0 && day === 1 && dayOfMonth >= 15 && dayOfMonth <= 21) return false;

    // Presidents' Day (3rd Monday of February)
    if (month === 1 && day === 1 && dayOfMonth >= 15 && dayOfMonth <= 21) return false;

    // Good Friday (varies - simplified check, not perfect)
    // Memorial Day (last Monday of May)
    if (month === 4 && day === 1 && dayOfMonth >= 25) return false;

    // Juneteenth (June 19, or observed)
    if (month === 5 && dayOfMonth === 19) return false;
    if (month === 5 && dayOfMonth === 20 && day === 1) return false; // Observed Monday
    if (month === 5 && dayOfMonth === 18 && day === 5) return false; // Observed Friday

    // Independence Day (July 4, or observed)
    if (month === 6 && dayOfMonth === 4) return false;
    if (month === 6 && dayOfMonth === 5 && day === 1) return false; // Observed Monday
    if (month === 6 && dayOfMonth === 3 && day === 5) return false; // Observed Friday

    // Labor Day (1st Monday of September)
    if (month === 8 && day === 1 && dayOfMonth <= 7) return false;

    // Thanksgiving Day (4th Thursday of November)
    if (month === 10 && day === 4 && dayOfMonth >= 22 && dayOfMonth <= 28) return false;

    // Christmas Day (Dec 25, or observed)
    if (month === 11 && dayOfMonth === 25) return false;
    if (month === 11 && dayOfMonth === 26 && day === 1) return false; // Observed Monday
    if (month === 11 && dayOfMonth === 24 && day === 5) return false; // Observed Friday

    return true;
}

// Sector mapping for common stocks/ETFs
// Custom category mapping for asset allocation
const symbolToCategory = {
    // Crypto - includes crypto assets and crypto-related stocks
    'BTC-USD': 'Crypto',
    'ETH-USD': 'Crypto',
    'ADA-USD': 'Crypto',
    'SOL-USD': 'Crypto',
    'DOGE-USD': 'Crypto',
    'XRP-USD': 'Crypto',
    'DOT-USD': 'Crypto',
    'AVAX-USD': 'Crypto',
    'MATIC-USD': 'Crypto',
    'LINK-USD': 'Crypto',
    'UNI-USD': 'Crypto',
    'ATOM-USD': 'Crypto',
    'LTC-USD': 'Crypto',
    'MSTR': 'Crypto',
    'CRCL': 'Crypto',
    'IBIT': 'Crypto',
    'RIOT': 'Crypto',
    'MARA': 'Crypto',
    'CLSK': 'Crypto',
    'COIN': 'Crypto',

    // Index - ETFs and index-like holdings
    'VOO': 'Index',
    'QQQM': 'Index',
    'QQQ': 'Index',
    'BRK-B': 'Index',
    'SPY': 'Index',
    'VTI': 'Index',
    'IWM': 'Index',
    'DIA': 'Index',
    'SCHD': 'Index',
    'VYM': 'Index',

    // Cash
    'CASH': 'Cash',
};

function getCategory(symbol) {
    // Check explicit mapping first
    if (symbolToCategory[symbol]) {
        return symbolToCategory[symbol];
    }
    // Auto-detect crypto by -USD suffix
    if (symbol.endsWith('-USD')) {
        return 'Crypto';
    }
    // Default to Individual Stocks
    return 'Individual Stocks';
}

// Current selected period
let currentPeriod = 'YTD';

// Holdings data and sort state
let holdingsData = [];
let holdingsSortColumn = 'market_value';
let holdingsSortDirection = 'desc';
let holdingsViewMode = 'category'; // 'flat' or 'category'

// Sold assets data and sort state
let soldData = null;
let soldSortColumn = 'pnl';
let soldSortDirection = 'desc';

// Target allocation data
let targetAllocations = {};

// Symbol groups that share a single target allocation
// Key = canonical name (used in targets.json), Value = array of symbols in the group
const targetGroups = {
    'QQQM': ['QQQM', 'QQQ'],
    'BTC-USD': ['BTC-USD', 'IBIT', 'MSTR'],
};

// Reverse lookup: symbol -> canonical group key
const symbolToGroup = {};
for (const [key, members] of Object.entries(targetGroups)) {
    for (const s of members) {
        symbolToGroup[s] = key;
    }
}

// Get the canonical target key for a symbol (itself or group key)
function getTargetKey(symbol) {
    return symbolToGroup[symbol] || symbol;
}

// Get target % for a symbol (checks group key)
function getTargetPct(symbol) {
    const key = getTargetKey(symbol);
    return targetAllocations[key];
}

// Get combined market value for a symbol's group from holdings array
function getGroupMarketValue(symbol, holdings) {
    const key = getTargetKey(symbol);
    const members = targetGroups[key];
    if (!members) return null; // not in a group
    return members.reduce((sum, s) => {
        const h = holdings.find(x => x.symbol === s);
        return sum + (h ? (h.market_value || 0) : 0);
    }, 0);
}

async function fetchTargets() {
    try {
        const response = await fetch('/api/targets');
        if (!response.ok) throw new Error('Failed to fetch targets');
        targetAllocations = await response.json();
    } catch (error) {
        console.error('Error fetching targets:', error);
        targetAllocations = {};
    }
}

async function saveTarget(symbol, pct) {
    try {
        const response = await fetch('/api/targets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, target_pct: pct || null })
        });
        if (!response.ok) throw new Error('Failed to save target');
        targetAllocations = await response.json();
        renderHoldingsTable(holdingsData);
    } catch (error) {
        console.error('Error saving target:', error);
        showToast('Error saving target allocation', 'error');
    }
}

// Auto-refresh settings
let autoRefreshInterval = 0; // 0 = off, otherwise seconds
let autoRefreshTimer = null;
let countdownTimer = null;
let countdownValue = 0;

// Cache for API responses
const apiCache = {
    data: {},
    ttl: 5 * 60 * 1000, // 5 minutes cache TTL

    get(key) {
        const cached = this.data[key];
        if (cached && Date.now() - cached.timestamp < this.ttl) {
            return cached.value;
        }
        return null;
    },

    set(key, value) {
        this.data[key] = {
            value: value,
            timestamp: Date.now()
        };
    },

    clear() {
        this.data = {};
    }
};

function getAssetIconHtml(symbol) {
    // Handle CASH - use Bootstrap icon
    if (symbol === 'CASH') {
        return '<i class="bi bi-cash-stack asset-icon-bi text-success"></i>';
    }

    // Check if it's a crypto symbol (ends with -USD)
    if (symbol.endsWith('-USD')) {
        // Extract the crypto symbol (e.g., ETH-USD -> eth)
        const cryptoSym = symbol.replace('-USD', '').toLowerCase();
        // Use cryptocurrency-icons from jsdelivr CDN (very reliable)
        return `<img src="https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${cryptoSym}.png"
                     alt="${symbol}" class="asset-icon"
                     onerror="this.style.display='none'">`;
    }

    // For stocks/ETFs, use Parqet's stock logo service
    return `<img src="https://assets.parqet.com/logos/symbol/${symbol}"
                 alt="${symbol}" class="asset-icon"
                 onerror="this.style.display='none'">`;
}

// Utility functions
function formatCurrency(value, forceShow = false) {
    if (value === null || value === undefined) return '--';
    if (anonymousMode && !forceShow) return '***';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

function formatCurrencyAlways(value) {
    if (value === null || value === undefined) return '--';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value);
}

const PRICE_4DP_SYMBOLS = new Set(['ADA-USD', 'NIGHT-USD', 'ADA', 'NIGHT']);
function formatPrice(symbol, value, alwaysShow = false) {
    if (value === null || value === undefined) return '--';
    if (anonymousMode && !alwaysShow) return '***';
    const dp = PRICE_4DP_SYMBOLS.has((symbol || '').toUpperCase()) ? 4 : 2;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: dp,
        maximumFractionDigits: dp
    }).format(value);
}

// Strip "-USD" suffix for display (BTC-USD → BTC)
function displaySymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.replace(/-USD$/i, '');
}

function formatNumber(value, decimals = 2) {
    if (value === null || value === undefined) return '--';
    // Use 2 decimal places for numbers >= 10, otherwise use specified decimals
    const effectiveDecimals = Math.abs(value) >= 10 ? 2 : decimals;
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: effectiveDecimals,
        maximumFractionDigits: effectiveDecimals
    }).format(value);
}

function formatPercent(value) {
    if (value === null || value === undefined) return '--';
    // Always show percentages even in anonymous mode
    const sign = value >= 0 ? '+' : '';
    return `${sign}${formatNumber(value)}%`;
}

function toggleAnonymousMode() {
    anonymousMode = !anonymousMode;
    localStorage.setItem('anonymousMode', anonymousMode);
    updateAnonymousButton();
    // Reload all data to apply the mode
    loadAllData();
}

function updateAnonymousButton() {
    const btn = document.getElementById('anonymousBtn');
    if (btn) {
        if (anonymousMode) {
            btn.innerHTML = '<i class="bi bi-eye-slash"></i>';
            btn.title = 'Show Values (Anonymous Mode On)';
            btn.classList.add('active');
        } else {
            btn.innerHTML = '<i class="bi bi-eye"></i>';
            btn.title = 'Hide Values (Anonymous Mode Off)';
            btn.classList.remove('active');
        }
    }
}

function showToast(message, type = 'info') {
    const toastEl = document.getElementById('toast');
    const toastBody = document.getElementById('toastBody');

    // Set message and style
    toastBody.textContent = message;
    toastEl.className = 'toast align-items-center border-0 text-white';
    if (type === 'success') {
        toastEl.classList.add('bg-success');
    } else if (type === 'error') {
        toastEl.classList.add('bg-danger');
    } else {
        toastEl.classList.add('bg-primary');
    }

    // Show toast using Bootstrap
    const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
}

// Custom tooltip
let tooltipElement = null;

function createTooltipElement() {
    if (!tooltipElement) {
        tooltipElement = document.createElement('div');
        tooltipElement.className = 'tooltip-custom';
        document.body.appendChild(tooltipElement);
    }
    return tooltipElement;
}

function setupTooltips() {
    const tooltip = createTooltipElement();

    document.querySelectorAll('.has-tooltip').forEach(el => {
        el.addEventListener('mouseenter', (e) => {
            const text = e.target.dataset.tooltip;
            if (text) {
                tooltip.textContent = text;
                tooltip.classList.add('visible');
            }
        });

        el.addEventListener('mousemove', (e) => {
            const x = e.clientX + 10;
            const y = e.clientY + 10;
            // Keep tooltip within viewport
            const rect = tooltip.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - 10;
            const maxY = window.innerHeight - rect.height - 10;
            tooltip.style.left = Math.min(x, maxX) + 'px';
            tooltip.style.top = Math.min(y, maxY) + 'px';
        });

        el.addEventListener('mouseleave', () => {
            tooltip.classList.remove('visible');
        });
    });
}

// API functions
async function fetchSummary(useCache = true) {
    const cacheKey = 'summary';
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const response = await fetch('/api/summary');
        if (!response.ok) throw new Error('Failed to fetch summary');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching summary:', error);
        showToast('Error loading portfolio data', 'error');
        return null;
    }
}

function getDateRangeForPeriod(period) {
    const today = new Date();
    let startDate = new Date();

    switch (period) {
        case '3D':
            startDate.setDate(today.getDate() - 3);
            break;
        case '1W':
            startDate.setDate(today.getDate() - 7);
            break;
        case '1M':
            startDate.setMonth(today.getMonth() - 1);
            break;
        case '3M':
            startDate.setMonth(today.getMonth() - 3);
            break;
        case '6M':
            startDate.setMonth(today.getMonth() - 6);
            break;
        case 'YTD':
            startDate = new Date(today.getFullYear(), 0, 1);
            break;
        case '1Y':
            startDate.setFullYear(today.getFullYear() - 1);
            break;
        case '3Y':
            startDate.setFullYear(today.getFullYear() - 3);
            break;
        case '5Y':
            startDate.setFullYear(today.getFullYear() - 5);
            break;
        case 'ALL':
            return { start_date: null, end_date: null };
        default:
            startDate.setFullYear(today.getFullYear() - 1);
    }

    const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
        start_date: formatDate(startDate),
        end_date: formatDate(today)
    };
}

async function fetchPerformance(period = '1Y', useCache = true) {
    const cacheKey = `performance_${period}`;
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const { start_date, end_date } = getDateRangeForPeriod(period);
        let url = '/api/performance';
        const params = new URLSearchParams();
        if (start_date) params.append('start_date', start_date);
        if (end_date) params.append('end_date', end_date);
        if (params.toString()) url += '?' + params.toString();

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch performance');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching performance:', error);
        return null;
    }
}

async function fetchDailyPnl(useCache = true) {
    const cacheKey = 'daily_pnl';
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }
    try {
        const response = await fetch('/api/daily-pnl');
        if (!response.ok) throw new Error('Failed to fetch daily P&L');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching daily P&L:', error);
        return null;
    }
}

async function fetchMonthlyPnlData(useCache = true) {
    const cacheKey = 'monthly_pnl_data';
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }
    try {
        const response = await fetch('/api/daily-pnl?num_days=400');
        if (!response.ok) throw new Error('Failed to fetch monthly P&L data');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching monthly P&L data:', error);
        return null;
    }
}

async function fetchDividends(useCache = true) {
    const cacheKey = 'dividends';
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const response = await fetch('/api/dividends');
        if (!response.ok) throw new Error('Failed to fetch dividends');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching dividends:', error);
        return null;
    }
}

async function fetchSoldAssets(useCache = true) {
    const cacheKey = 'sold';
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const response = await fetch('/api/sold');
        if (!response.ok) throw new Error('Failed to fetch sold assets');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching sold assets:', error);
        return null;
    }
}

async function fetchIntraday(interval = '5m', date = null, useCache = true) {
    const cacheKey = `intraday_${date || 'today'}_${interval}`;
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        let url = `/api/intraday?interval=${interval}`;
        if (date) url += `&date=${date}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch intraday data');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching intraday data:', error);
        return null;
    }
}

async function fetchIntradayMultiday(interval = '15m', days = 3, useCache = true) {
    const cacheKey = `intraday_multiday_${interval}_${days}`;
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const response = await fetch(`/api/intraday-multiday?interval=${interval}&days=${days}`);
        if (!response.ok) throw new Error('Failed to fetch multi-day intraday data');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching multi-day intraday data:', error);
        return null;
    }
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Upload failed');
        // Clear cache after upload
        apiCache.clear();
        return data;
    } catch (error) {
        console.error('Error uploading file:', error);
        throw error;
    }
}

async function reloadPortfolio() {
    try {
        const response = await fetch('/api/reload', { method: 'POST' });
        if (!response.ok) throw new Error('Failed to reload');
        // Clear cache after reload
        apiCache.clear();
        return await response.json();
    } catch (error) {
        console.error('Error reloading portfolio:', error);
        throw error;
    }
}

// UI Update functions
function updateSummaryCards(summary) {
    document.getElementById('totalValue').textContent = formatCurrency(summary.total_market_value);
    document.getElementById('costBasis').textContent = formatCurrency(summary.total_cost_basis);

    const pnlElement = document.getElementById('unrealizedPnl');
    pnlElement.textContent = formatCurrency(summary.total_unrealized_pnl);
    pnlElement.className = `card-text fs-4 fw-bold mb-0 has-tooltip ${summary.total_unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}`;
    const pnlTooltip = `Unrealized P&L = Investment Value - Cost Basis\n${formatCurrency(summary.investment_market_value)} - ${formatCurrency(summary.total_cost_basis)} = ${formatCurrency(summary.total_unrealized_pnl)}`;
    pnlElement.dataset.tooltip = pnlTooltip;

    // LT/ST breakdown of unrealized P&L (live)
    const unrealLtSt = document.getElementById('unrealizedLtSt');
    if (unrealLtSt) {
        if (summary.lt_unrealized_pnl != null && summary.st_unrealized_pnl != null) {
            const lt = summary.lt_unrealized_pnl;
            const st = summary.st_unrealized_pnl;
            const ltSign = lt >= 0 ? '+' : '';
            const stSign = st >= 0 ? '+' : '';
            const ltClass = lt >= 0 ? 'text-success' : 'text-danger';
            const stClass = st >= 0 ? 'text-success' : 'text-danger';
            unrealLtSt.innerHTML = `<span class="text-muted">LT </span><span class="${ltClass}">${ltSign}${formatCurrencyAlways(lt)}</span>`
                + `<span class="text-muted mx-1">|</span>`
                + `<span class="text-muted">ST </span><span class="${stClass}">${stSign}${formatCurrencyAlways(st)}</span>`;
        } else {
            unrealLtSt.textContent = '';
        }
    }

    const totalPnlElement = document.getElementById('totalPnl');
    totalPnlElement.textContent = formatCurrency(summary.total_pnl);
    totalPnlElement.className = `card-text fs-4 fw-bold mb-0 has-tooltip ${summary.total_pnl >= 0 ? 'text-success' : 'text-danger'}`;
    const totalPnlTooltip = `Total P&L = Realized + Unrealized\nRealized: ${formatCurrency(summary.total_realized_pnl)}\nUnrealized: ${formatCurrency(summary.total_unrealized_pnl)}\n= ${formatCurrency(summary.total_pnl)}`;
    totalPnlElement.dataset.tooltip = totalPnlTooltip;

    const returnElement = document.getElementById('totalReturn');
    returnElement.textContent = formatPercent(summary.total_pnl_percent);
    returnElement.className = `card-text fs-6 mb-0 has-tooltip ${summary.total_pnl_percent >= 0 ? 'text-success' : 'text-danger'}`;
    const returnTooltip = `Total Return = (Realized + Unrealized) / All-Time Cost\nRealized P&L: ${formatCurrency(summary.total_realized_pnl)}\nUnrealized P&L: ${formatCurrency(summary.total_unrealized_pnl)}\nTotal P&L: ${formatCurrency(summary.total_pnl)}\nAll-Time Cost: ${formatCurrency(summary.all_time_cost_basis)}\n= ${formatPercent(summary.total_pnl_percent)}`;
    returnElement.dataset.tooltip = returnTooltip;

    const ytdPnl = summary.ytd_pnl ?? 0;
    const ytdPct = summary.ytd_pnl_percent ?? 0;
    const ytdColor = ytdPnl >= 0 ? 'text-success' : 'text-danger';
    const ytdSign = ytdPnl >= 0 ? '+' : '';

    const ytdPnlEl = document.getElementById('ytdPnl');
    ytdPnlEl.textContent = `${ytdSign}${formatCurrencyAlways(ytdPnl)}`;
    ytdPnlEl.className = `card-text fs-4 fw-bold mb-0 ${ytdColor}`;

    const ytdPctEl = document.getElementById('ytdPnlPercent');
    ytdPctEl.textContent = `${ytdSign}${ytdPct.toFixed(2)}%`;
    ytdPctEl.className = `card-text fs-6 mb-0 ${ytdColor}`;

    const ltSt = document.getElementById('ytdLtSt');
    if (ltSt && summary.ytd_lt_pnl != null && summary.ytd_st_pnl != null) {
        const lt = summary.ytd_lt_pnl;
        const st = summary.ytd_st_pnl;
        const ltSign = lt >= 0 ? '+' : '';
        const stSign = st >= 0 ? '+' : '';
        const ltClass = lt >= 0 ? 'text-success' : 'text-danger';
        const stClass = st >= 0 ? 'text-success' : 'text-danger';
        ltSt.innerHTML = `<span class="text-muted">LT </span><span class="${ltClass}">${ltSign}${formatCurrencyAlways(lt)}</span>`
            + `<span class="text-muted mx-1">|</span>`
            + `<span class="text-muted">ST </span><span class="${stClass}">${stSign}${formatCurrencyAlways(st)}</span>`;
    }

    // Condensed strip (always visible, regardless of collapse state)
    function setStrip(id, val, fmt = formatCurrency) {
        const el = document.getElementById(id);
        if (!el) return;
        if (val == null) { el.textContent = '--'; el.className = ''; return; }
        el.textContent = fmt(val);
        el.className = val >= 0 ? 'text-success fw-semibold' : 'text-danger fw-semibold';
    }
    setStrip('stripUnrealizedPnl', summary.total_unrealized_pnl);
    setStrip('stripTotalPnl', summary.total_pnl);
    setStrip('stripYtdPnl', summary.ytd_pnl);
}

function sortHoldings(holdings, column, direction) {
    // Pre-compute total portfolio value for computed columns
    const totalInvValue = holdings
        .reduce((sum, h) => sum + (h.market_value || 0), 0);

    return [...holdings].sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];

        // Computed columns for target allocation
        if (column === 'alloc_pct') {
            aVal = totalInvValue > 0 ? ((a.market_value || 0) / totalInvValue * 100) : 0;
            bVal = totalInvValue > 0 ? ((b.market_value || 0) / totalInvValue * 100) : 0;
        } else if (column === 'target_pct') {
            aVal = getTargetPct(a.symbol) ?? -Infinity;
            bVal = getTargetPct(b.symbol) ?? -Infinity;
        } else if (column === 'delta_target') {
            const aTgt = getTargetPct(a.symbol);
            const bTgt = getTargetPct(b.symbol);
            const aMV = getGroupMarketValue(a.symbol, holdings) ?? (a.market_value || 0);
            const bMV = getGroupMarketValue(b.symbol, holdings) ?? (b.market_value || 0);
            aVal = aTgt != null ? (aTgt / 100 * totalInvValue - aMV) : -Infinity;
            bVal = bTgt != null ? (bTgt / 100 * totalInvValue - bMV) : -Infinity;
        }

        // Handle null/undefined values
        if (aVal === null || aVal === undefined) aVal = -Infinity;
        if (bVal === null || bVal === undefined) bVal = -Infinity;

        // String comparison for symbol
        if (column === 'symbol') {
            aVal = aVal.toString().toLowerCase();
            bVal = bVal.toString().toLowerCase();
            if (direction === 'asc') {
                return aVal.localeCompare(bVal);
            } else {
                return bVal.localeCompare(aVal);
            }
        }

        // Numeric comparison for other columns
        if (direction === 'asc') {
            return aVal - bVal;
        } else {
            return bVal - aVal;
        }
    });
}

function updateSortIndicators() {
    document.querySelectorAll('#holdingsTable th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === holdingsSortColumn) {
            th.classList.add(holdingsSortDirection);
        }
    });
}

function buildHoldingRowHtml(h, totalInvValue, holdings, categoryTargetSums) {
    const dailyChangePct = h.daily_change_percent;
    const dailyChangeAmt = h.daily_change_amount;
    const dailyChangePctHtml = dailyChangePct !== null && dailyChangePct !== undefined
        ? `<span class="${dailyChangePct >= 0 ? 'text-success' : 'text-danger'} daily-change">(${dailyChangePct >= 0 ? '+' : ''}${dailyChangePct.toFixed(2)}%)</span>`
        : '';
    const dailyChangeAmtClass = dailyChangeAmt !== null && dailyChangeAmt !== undefined
        ? (dailyChangeAmt >= 0 ? 'text-success' : 'text-danger')
        : '';
    const dailyChangeAmtText = dailyChangeAmt !== null && dailyChangeAmt !== undefined
        ? `${dailyChangeAmt >= 0 ? '+' : ''}${formatCurrencyAlways(dailyChangeAmt)}`
        : '--';

    const annualReturn = h.annualized_return;
    const holdingDays = h.holding_days;
    const pnlPercent = h.pnl_percent;
    const annualReturnClass = annualReturn !== null && annualReturn !== undefined
        ? (annualReturn >= 0 ? 'text-success' : 'text-danger') : '';
    const annualReturnText = annualReturn !== null && annualReturn !== undefined
        ? `${annualReturn >= 0 ? '+' : ''}${annualReturn.toFixed(2)}%` : '--';

    let annualTooltip = '';
    if (holdingDays !== null && holdingDays !== undefined && pnlPercent !== null) {
        const years = holdingDays / 365;
        const yearsForCalc = Math.max(years, 1);
        const pnlSign = pnlPercent >= 0 ? '+' : '';
        annualTooltip = `title="${pnlSign}${pnlPercent.toFixed(2)}% / ${yearsForCalc.toFixed(2)} yrs\n(${holdingDays} days${years < 1 ? ', min 1yr' : ''})"`;
    }

    const weightedAnnualReturn = h.weighted_annualized_return;
    const weightedAnnualReturnClass = weightedAnnualReturn !== null && weightedAnnualReturn !== undefined
        ? (weightedAnnualReturn >= 0 ? 'text-success' : 'text-danger') : '';
    const weightedAnnualReturnText = weightedAnnualReturn !== null && weightedAnnualReturn !== undefined
        ? `${weightedAnnualReturn >= 0 ? '+' : ''}${weightedAnnualReturn.toFixed(2)}%` : '--';
    const weightedAnnualTooltip = 'title="Per-lot cost-basis weighted CAGR"';

    // Allocation %, Target %, Δ Target (group-aware)
    const category = getCategory(h.symbol);
    const isCategoryLevelTarget = category === 'Individual Stocks'; // uses category-level target, not per-symbol
    const targetKey = getTargetKey(h.symbol);
    const isGrouped = !!targetGroups[targetKey];
    const groupMV = isGrouped ? getGroupMarketValue(h.symbol, holdings) : (h.market_value || 0);
    const allocPct = totalInvValue > 0 ? (h.market_value || 0) / totalInvValue * 100 : 0;
    const groupAllocPct = totalInvValue > 0 ? groupMV / totalInvValue * 100 : 0;
    const targetPct = isCategoryLevelTarget ? null : getTargetPct(h.symbol);
    const hasTarget = targetPct != null && targetPct > 0;
    const isCanonical = !isGrouped || targetKey === h.symbol;
    const deltaTarget = hasTarget && isCanonical ? (targetPct / 100 * totalInvValue - groupMV) : null;

    const groupAllocBadge = isGrouped ? ` <span class="cat-target-sum" title="${targetKey} group total">${groupAllocPct.toFixed(1)}%</span>` : '';
    const allocPctText = `${allocPct.toFixed(1)}%${groupAllocBadge}`;
    const allocTitle = isGrouped ? `title="${targetKey} group: ${groupAllocPct.toFixed(1)}%"` : '';
    const catTargetSum = categoryTargetSums[category];
    const catSumHtml = !isCategoryLevelTarget && catTargetSum != null ? `<span class="cat-target-sum" title="${category} target total">${catTargetSum.toFixed(1)}%</span>` : '';
    const targetPctText = hasTarget ? `${targetPct.toFixed(1)}%` : '--';
    // Individual Stocks: no per-symbol target; non-canonical grouped members: hide target and delta columns
    const targetCellContent = isCategoryLevelTarget
        ? '--'
        : (!isCanonical ? '' : `${targetPctText} ${catSumHtml}`);
    let deltaTargetHtml = '';
    if (deltaTarget !== null) {
        const targetAmt = targetPct / 100 * totalInvValue;
        const dtSign = deltaTarget >= 0 ? '+' : '';
        const dtClass = deltaTarget >= 0 ? 'delta-buy' : 'delta-sell';
        deltaTargetHtml = `<div class="delta-target-wrap"><span class="delta-target-amt">${formatCurrencyAlways(targetAmt)}</span><span class="${dtClass}">${dtSign}${formatCurrencyAlways(deltaTarget)}</span></div>`;
    } else if (!isCanonical || isCategoryLevelTarget) {
        deltaTargetHtml = '';
    } else {
        deltaTargetHtml = '<span class="text-muted">--</span>';
    }

    return `
    <tr class="holding-row" data-symbol="${h.symbol}" style="cursor:pointer;">
        <td data-col="0"><i class="bi bi-chevron-right holding-chevron me-1"></i>${getAssetIconHtml(h.symbol)}<strong>${displaySymbol(h.symbol)}</strong></td>
        <td data-col="1">${anonymousMode ? '***' : formatNumber(h.quantity, 4)}${!anonymousMode && h.long_term_quantity != null && h.quantity > 0 && h.symbol !== 'CASH' ? `<div class="text-muted" style="font-size:0.75em;line-height:1.3;">LT ${h.long_term_quantity === 0 ? '0' : formatNumber(h.long_term_quantity, 4)}</div><div class="text-muted" style="font-size:0.75em;line-height:1.3;">ST ${h.short_term_quantity === 0 ? '0' : formatNumber(h.short_term_quantity, 4)}</div>` : ''}</td>
        <td data-col="2">${formatPrice(h.symbol, h.avg_cost)}</td>
        <td data-col="3">${formatCurrency(h.cost_basis)}</td>
        <td data-col="4">${formatPrice(h.symbol, h.current_price, true)} ${dailyChangePctHtml}</td>
        <td data-col="5" class="${dailyChangeAmtClass}">${dailyChangeAmtText}</td>
        <td data-col="17" class="${(h.ytd_pnl || 0) >= 0 ? 'text-success' : 'text-danger'}">${h.ytd_pnl != null ? `${h.ytd_pnl >= 0 ? '+' : ''}${formatCurrencyAlways(h.ytd_pnl)}` : '--'}${buildLtStBreakdownHtml(h.lt_ytd_pnl, h.st_ytd_pnl)}</td>
        <td data-col="18" class="${(h.ytd_pnl_percent || 0) >= 0 ? 'text-success' : 'text-danger'}">${h.ytd_pnl_percent != null ? formatPercent(h.ytd_pnl_percent) : '--'}</td>
        <td data-col="6">${formatCurrency(h.market_value)}</td>
        <td data-col="7" ${allocTitle}>${allocPctText}</td>
        <td data-col="8" ${isCategoryLevelTarget ? '' : `class="target-pct-cell" data-symbol="${targetKey}"`}>${targetCellContent}</td>
        <td data-col="9">${deltaTargetHtml}</td>
        <td data-col="10" class="${h.unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(h.unrealized_pnl)}${buildLtStBreakdownHtml(h.lt_unrealized_pnl, h.st_unrealized_pnl)}</td>
        <td data-col="11" class="${h.pnl_percent >= 0 ? 'text-success' : 'text-danger'}">${formatPercent(h.pnl_percent)}</td>
        <td data-col="14" class="${(h.realized_pnl || 0) >= 0 ? 'text-success' : 'text-danger'}">${h.realized_pnl != null ? formatCurrency(h.realized_pnl) : '--'}${buildLtStBreakdownHtml(h.lt_realized_pnl, h.st_realized_pnl)}</td>
        <td data-col="15" class="${(h.total_pnl || 0) >= 0 ? 'text-success' : 'text-danger'}">${h.total_pnl != null ? formatCurrency(h.total_pnl) : '--'}</td>
        <td data-col="16" class="${(h.total_pnl_percent || 0) >= 0 ? 'text-success' : 'text-danger'}">${h.total_pnl_percent != null ? formatPercent(h.total_pnl_percent) : '--'}</td>
        <td data-col="12" class="${annualReturnClass}" ${annualTooltip}>${annualReturnText}</td>
        <td data-col="13" class="${weightedAnnualReturnClass}" ${weightedAnnualTooltip}>${weightedAnnualReturnText}</td>
    </tr>`;
}

// Helper: render LT/ST sub-line under a P&L cell.
// Returns empty string if both are null/0 or splits aren't meaningful.
function buildLtStBreakdownHtml(lt, st) {
    if (lt == null && st == null) return '';
    const ltVal = lt || 0;
    const stVal = st || 0;
    if (ltVal === 0 && stVal === 0) return '';
    const fmt = (v) => `${v >= 0 ? '+' : ''}${formatCurrencyAlways(v)}`;
    const ltCls = ltVal >= 0 ? 'text-success' : 'text-danger';
    const stCls = stVal >= 0 ? 'text-success' : 'text-danger';
    return `<div class="text-muted" style="font-size:0.75em;line-height:1.3;">LT <span class="${ltCls}">${fmt(ltVal)}</span></div>`
         + `<div class="text-muted" style="font-size:0.75em;line-height:1.3;">ST <span class="${stCls}">${fmt(stVal)}</span></div>`;
}

function buildTotalRowHtml(holdings, totalInvValue) {
    const totalMV = holdings.reduce((s, h) => s + (h.market_value || 0), 0);
    const totalCost = holdings.reduce((s, h) => s + (h.cost_basis || 0), 0);
    const totalPnl = holdings.reduce((s, h) => s + (h.unrealized_pnl || 0), 0);
    const totalLtUnreal = holdings.reduce((s, h) => s + (h.lt_unrealized_pnl || 0), 0);
    const totalStUnreal = holdings.reduce((s, h) => s + (h.st_unrealized_pnl || 0), 0);
    const totalRealized = holdings.reduce((s, h) => s + (h.realized_pnl || 0), 0);
    const totalLtReal = holdings.reduce((s, h) => s + (h.lt_realized_pnl || 0), 0);
    const totalStReal = holdings.reduce((s, h) => s + (h.st_realized_pnl || 0), 0);
    const totalTotalPnl = totalPnl + totalRealized;
    const totalDaily = holdings.reduce((s, h) => s + (h.daily_change_amount || 0), 0);
    const totalYtd = holdings.reduce((s, h) => s + (h.ytd_pnl || 0), 0);
    const totalLtYtd = holdings.reduce((s, h) => s + (h.lt_ytd_pnl || 0), 0);
    const totalStYtd = holdings.reduce((s, h) => s + (h.st_ytd_pnl || 0), 0);
    const totalYtdBaseline = holdings.reduce(
        (s, h) => s + ((h.market_value || 0) - (h.ytd_pnl || 0)), 0);
    const totalYtdPct = totalYtdBaseline > 0 ? (totalYtd / totalYtdBaseline * 100) : 0;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
    // Total % uses all-time invested cost (current + sold) for parity with Total P&L semantics
    // Approximation here: sum of per-symbol all-time cost ≈ totalCost + (sum cost of sales).
    // We don't have sold cost per holding row, so fall back to totalCost which is close enough
    // for a top-line %; users get exact numbers in the Daily P&L summary card.
    const totalTotalPnlPct = totalCost > 0 ? (totalTotalPnl / totalCost * 100) : 0;

    // Only count canonical target keys (skip orphaned non-canonical grouped symbols)
    const canonicalTargets = Object.entries(targetAllocations).filter(([key]) => {
        const group = symbolToGroup[key];
        return !group || group === key; // keep if not grouped, or if it IS the canonical key
    });
    const targetSum = canonicalTargets.reduce((s, [, v]) => s + v, 0);
    const targetSumText = targetSum > 0 ? `${targetSum.toFixed(1)}%` : '--';
    const targetWarn = targetSum > 0 && Math.abs(targetSum - 100) > 0.1
        ? `<span class="target-warn" title="Targets don't sum to 100%">&#9888;</span>` : '';

    const netDelta = canonicalTargets.reduce((s, [key, pct]) => {
        const members = targetGroups[key];
        const mv = members
            ? members.reduce((sum, m) => { const x = holdings.find(h => h.symbol === m); return sum + (x ? (x.market_value || 0) : 0); }, 0)
            : (holdings.find(h => h.symbol === key)?.market_value || 0);
        return s + (pct / 100 * totalInvValue - mv);
    }, 0);
    const hasAnyTarget = Object.keys(targetAllocations).length > 0;
    const netDeltaClass = netDelta >= 0 ? 'delta-buy' : 'delta-sell';
    const netDeltaSign = netDelta >= 0 ? '+' : '';
    const netDeltaHtml = hasAnyTarget
        ? `<span class="${netDeltaClass}">${netDeltaSign}${formatCurrencyAlways(netDelta)}</span>` : '--';

    const totalDailyClass = totalDaily >= 0 ? 'text-success' : 'text-danger';
    const totalDailySign = totalDaily >= 0 ? '+' : '';
    const totalYtdClass = totalYtd >= 0 ? 'text-success' : 'text-danger';
    const totalYtdSign = totalYtd >= 0 ? '+' : '';
    const totalPnlClass = totalPnl >= 0 ? 'text-success' : 'text-danger';
    const totalRealizedClass = totalRealized >= 0 ? 'text-success' : 'text-danger';
    const totalTotalPnlClass = totalTotalPnl >= 0 ? 'text-success' : 'text-danger';

    return `
        <tr class="total-row">
            <td data-col="0"><strong>TOTAL</strong></td>
            <td data-col="1"></td><td data-col="2"></td>
            <td data-col="3"><strong>${formatCurrency(totalCost)}</strong></td>
            <td data-col="4"></td>
            <td data-col="5" class="${totalDailyClass}"><strong>${totalDailySign}${formatCurrencyAlways(totalDaily)}</strong></td>
            <td data-col="17" class="${totalYtdClass}"><strong>${totalYtdSign}${formatCurrencyAlways(totalYtd)}</strong>${buildLtStBreakdownHtml(totalLtYtd, totalStYtd)}</td>
            <td data-col="18" class="${totalYtdClass}"><strong>${formatPercent(totalYtdPct)}</strong></td>
            <td data-col="6"><strong>${formatCurrency(totalMV)}</strong></td>
            <td data-col="7"><strong>100.0%</strong></td>
            <td data-col="8"><strong>${targetSumText}</strong>${targetWarn}</td>
            <td data-col="9">${netDeltaHtml}</td>
            <td data-col="10" class="${totalPnlClass}"><strong>${formatCurrency(totalPnl)}</strong>${buildLtStBreakdownHtml(totalLtUnreal, totalStUnreal)}</td>
            <td data-col="11" class="${totalPnlClass}"><strong>${formatPercent(totalPnlPct)}</strong></td>
            <td data-col="14" class="${totalRealizedClass}"><strong>${formatCurrency(totalRealized)}</strong>${buildLtStBreakdownHtml(totalLtReal, totalStReal)}</td>
            <td data-col="15" class="${totalTotalPnlClass}"><strong>${formatCurrency(totalTotalPnl)}</strong></td>
            <td data-col="16" class="${totalTotalPnlClass}"><strong>${formatPercent(totalTotalPnlPct)}</strong></td>
            <td data-col="12"></td><td data-col="13"></td>
        </tr>`;
}

function buildCategorySubtotalHtml(catName, catHoldings, totalInvValue, categoryTargetSums) {
    const catColors = { 'Crypto': '#f59e0b', 'Index': '#2563eb', 'Individual Stocks': '#8b5cf6', 'Cash': '#10b981' };
    const color = catColors[catName] || '#6b7280';
    const mv = catHoldings.reduce((s, h) => s + (h.market_value || 0), 0);
    const cost = catHoldings.reduce((s, h) => s + (h.cost_basis || 0), 0);
    const pnl = catHoldings.reduce((s, h) => s + (h.unrealized_pnl || 0), 0);
    const ltUnreal = catHoldings.reduce((s, h) => s + (h.lt_unrealized_pnl || 0), 0);
    const stUnreal = catHoldings.reduce((s, h) => s + (h.st_unrealized_pnl || 0), 0);
    const realized = catHoldings.reduce((s, h) => s + (h.realized_pnl || 0), 0);
    const ltReal = catHoldings.reduce((s, h) => s + (h.lt_realized_pnl || 0), 0);
    const stReal = catHoldings.reduce((s, h) => s + (h.st_realized_pnl || 0), 0);
    const totalCatPnl = pnl + realized;
    const daily = catHoldings.reduce((s, h) => s + (h.daily_change_amount || 0), 0);
    const ytd = catHoldings.reduce((s, h) => s + (h.ytd_pnl || 0), 0);
    const ltYtd = catHoldings.reduce((s, h) => s + (h.lt_ytd_pnl || 0), 0);
    const stYtd = catHoldings.reduce((s, h) => s + (h.st_ytd_pnl || 0), 0);
    const ytdBaseline = catHoldings.reduce(
        (s, h) => s + ((h.market_value || 0) - (h.ytd_pnl || 0)), 0);
    const ytdPct = ytdBaseline > 0 ? (ytd / ytdBaseline * 100) : 0;
    const pnlPct = cost > 0 ? (pnl / cost * 100) : 0;
    const totalCatPnlPct = cost > 0 ? (totalCatPnl / cost * 100) : 0;
    const allocPct = totalInvValue > 0 ? (mv / totalInvValue * 100) : 0;
    const catTargetSum = categoryTargetSums[catName];
    const catTargetText = catTargetSum != null ? `${catTargetSum.toFixed(1)}%` : '--';

    // Category Δ Target = target_market_value - actual_market_value
    let catDeltaHtml = '';
    if (catTargetSum != null && catTargetSum > 0) {
        const catTargetMV = catTargetSum / 100 * totalInvValue;
        const catDelta = catTargetMV - mv;
        const dtSign = catDelta >= 0 ? '+' : '';
        const dtClass = catDelta >= 0 ? 'delta-buy' : 'delta-sell';
        catDeltaHtml = `<div class="delta-target-wrap"><span class="delta-target-amt">${formatCurrencyAlways(catTargetMV)}</span><strong><span class="${dtClass}">${dtSign}${formatCurrencyAlways(catDelta)}</span></strong></div>`;
    }

    const dailyClass = daily >= 0 ? 'text-success' : 'text-danger';
    const dailySign = daily >= 0 ? '+' : '';
    const ytdClass = ytd >= 0 ? 'text-success' : 'text-danger';
    const ytdSign = ytd >= 0 ? '+' : '';
    const pnlClass = pnl >= 0 ? 'text-success' : 'text-danger';
    const realizedClass = realized >= 0 ? 'text-success' : 'text-danger';
    const totalCatPnlClass = totalCatPnl >= 0 ? 'text-success' : 'text-danger';

    return `
        <tr class="category-header-row" style="background-color: #fef9e7; border-left: 4px solid ${color};">
            <td data-col="0"><span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;margin-right:6px;"></span><strong>${catName}</strong> <span class="text-muted">(${catHoldings.length})</span></td>
            <td data-col="1"></td><td data-col="2"></td>
            <td data-col="3"><strong>${formatCurrency(cost)}</strong></td>
            <td data-col="4" class="${dailyClass}"><strong>${formatPercent(mv > 0 ? (daily / (mv - daily) * 100) : 0)}</strong></td>
            <td data-col="5" class="${dailyClass}"><strong>${dailySign}${formatCurrencyAlways(daily)}</strong></td>
            <td data-col="17" class="${ytdClass}"><strong>${ytdSign}${formatCurrencyAlways(ytd)}</strong>${buildLtStBreakdownHtml(ltYtd, stYtd)}</td>
            <td data-col="18" class="${ytdClass}"><strong>${formatPercent(ytdPct)}</strong></td>
            <td data-col="6"><strong>${formatCurrency(mv)}</strong></td>
            <td data-col="7"><strong>${allocPct.toFixed(1)}%</strong></td>
            <td data-col="8" ${catName === 'Individual Stocks' ? `class="target-pct-cell" data-symbol="category:Individual Stocks" style="cursor:pointer;"` : ''}><strong>${catTargetText}</strong></td>
            <td data-col="9">${catDeltaHtml}</td>
            <td data-col="10" class="${pnlClass}"><strong>${formatCurrency(pnl)}</strong>${buildLtStBreakdownHtml(ltUnreal, stUnreal)}</td>
            <td data-col="11" class="${pnlClass}"><strong>${formatPercent(pnlPct)}</strong></td>
            <td data-col="14" class="${realizedClass}"><strong>${formatCurrency(realized)}</strong>${buildLtStBreakdownHtml(ltReal, stReal)}</td>
            <td data-col="15" class="${totalCatPnlClass}"><strong>${formatCurrency(totalCatPnl)}</strong></td>
            <td data-col="16" class="${totalCatPnlClass}"><strong>${formatPercent(totalCatPnlPct)}</strong></td>
            <td data-col="12"></td><td data-col="13"></td>
        </tr>`;
}

function renderHoldingsTable(holdings) {
    const tbody = document.getElementById('holdingsBody');

    if (!holdings || holdings.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="19" class="empty-state">
                    <p>No holdings found</p>
                    <p>Upload a CSV file to get started</p>
                </td>
            </tr>
        `;
        return;
    }

    // Compute total portfolio value (including CASH) for allocation %
    const totalInvValue = holdings
        .reduce((sum, h) => sum + (h.market_value || 0), 0);

    // Pre-compute category target sums from targetAllocations.
    // Categories with a "category:<name>" key use that directly (e.g. Individual Stocks).
    // Others sum their individual symbol targets.
    const categoryTargetSums = {};
    for (const [key, pct] of Object.entries(targetAllocations)) {
        if (pct != null && pct > 0) {
            if (key.startsWith('category:')) {
                const catName = key.slice('category:'.length);
                categoryTargetSums[catName] = pct;
            } else if (getCategory(key) !== 'Individual Stocks') {
                const cat = getCategory(key);
                categoryTargetSums[cat] = (categoryTargetSums[cat] || 0) + pct;
            }
        }
    }

    // Sort holdings
    const sortedHoldings = sortHoldings(holdings, holdingsSortColumn, holdingsSortDirection);

    let rows = '';

    if (holdingsViewMode === 'category') {
        // Group by category, preserving sort order within each group
        const categoryOrder = ['Crypto', 'Index', 'Individual Stocks', 'Cash'];
        const grouped = {};
        sortedHoldings.forEach(h => {
            const cat = getCategory(h.symbol);
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(h);
        });
        // Sort categories: known order first, then any extras
        const cats = Object.keys(grouped).sort((a, b) => {
            const ai = categoryOrder.indexOf(a);
            const bi = categoryOrder.indexOf(b);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        for (const cat of cats) {
            const catHoldings = grouped[cat];
            rows += buildCategorySubtotalHtml(cat, catHoldings, totalInvValue, categoryTargetSums);
            rows += catHoldings.map(h => buildHoldingRowHtml(h, totalInvValue, holdings, categoryTargetSums)).join('');
        }
    } else {
        rows = sortedHoldings.map(h => buildHoldingRowHtml(h, totalInvValue, holdings, categoryTargetSums)).join('');
    }

    rows += buildTotalRowHtml(holdings, totalInvValue);
    tbody.innerHTML = rows;
    updateSortIndicators();
}

async function toggleTransactionDetail(holdingRow) {
    const symbol = holdingRow.dataset.symbol;
    const tbody = holdingRow.closest('tbody');

    // Check if detail row already exists (toggle off)
    const existingDetail = tbody.querySelector(`.txn-detail-row[data-symbol="${symbol}"]`);
    if (existingDetail) {
        existingDetail.remove();
        holdingRow.querySelector('.holding-chevron').classList.remove('rotated');
        return;
    }

    // Close any other open detail rows
    tbody.querySelectorAll('.txn-detail-row').forEach(r => r.remove());
    tbody.querySelectorAll('.holding-row').forEach(r => {
        r.querySelector('.holding-chevron')?.classList.remove('rotated');
    });

    // Rotate chevron
    holdingRow.querySelector('.holding-chevron').classList.add('rotated');

    // Insert placeholder row
    const detailRow = document.createElement('tr');
    detailRow.className = 'txn-detail-row';
    detailRow.dataset.symbol = symbol;
    detailRow.innerHTML = `<td colspan="17"><div class="txn-detail-container"><span class="text-muted small">Loading...</span></div></td>`;
    holdingRow.insertAdjacentElement('afterend', detailRow);

    // Fetch all transactions (no limit) so running totals are accurate
    if (!transactionCache[symbol]) {
        try {
            const res = await fetch(`/api/transactions/${symbol}?limit=10000&actions=BUY,SELL,GIFT,SPLIT`);
            if (!res.ok) throw new Error('Failed to fetch');
            const data = await res.json();
            transactionCache[symbol] = data.transactions;
        } catch (e) {
            detailRow.querySelector('.txn-detail-container').innerHTML = `<span class="text-danger small">Error loading transactions</span>`;
            return;
        }
    }

    const txns = transactionCache[symbol];
    if (!txns || txns.length === 0) {
        detailRow.querySelector('.txn-detail-container').innerHTML = `<span class="text-muted small">No transactions found</span>`;
        return;
    }

    // Compute running quantity and avg cost using FIFO lot tracking (oldest → newest)
    const oldestFirst = [...txns].reverse();
    let lots = []; // [{qty, costPerShare}] in purchase order
    for (const t of oldestFirst) {
        const qty = t.quantity || 0;
        const price = t.ave_price != null ? t.ave_price
                      : (qty > 0 && t.amount != null ? Math.abs(t.amount) / qty : 0);
        if (t.action === 'BUY') {
            lots.push({ qty, costPerShare: price });
        } else if (t.action === 'GIFT' || t.action === 'SPLIT') {
            lots.push({ qty, costPerShare: 0 });
        } else if (t.action === 'SELL') {
            // Remove shares FIFO
            let remaining = qty;
            while (remaining > 1e-9 && lots.length > 0) {
                if (lots[0].qty <= remaining + 1e-9) {
                    remaining -= lots[0].qty;
                    lots.shift();
                } else {
                    lots[0].qty -= remaining;
                    remaining = 0;
                }
            }
        }
        const totalQty = lots.reduce((s, l) => s + l.qty, 0);
        const totalCost = lots.reduce((s, l) => s + l.qty * l.costPerShare, 0);
        t._runningQty = totalQty;
        t._runningAvgCost = totalQty > 1e-9 ? totalCost / totalQty : 0;
    }

    const actionClass = (action) => {
        switch (action) {
            case 'BUY': case 'GIFT': return 'txn-buy';
            case 'SELL': return 'txn-sell';
            case 'DIV': return 'txn-div';
            default: return 'txn-other';
        }
    };

    const rows = txns.map(t => {
        const qty = t.quantity !== null ? formatNumber(t.quantity, 4) : '--';
        const price = t.ave_price !== null ? formatPrice(symbol, t.ave_price, true) : '--';
        const amount = t.amount !== null ? formatCurrencyAlways(t.amount) : '--';
        const heldQty = t._runningQty != null ? formatNumber(t._runningQty, 4) : '--';
        const avgCostAfter = (t._runningQty > 0 && t._runningAvgCost != null)
            ? formatPrice(symbol, t._runningAvgCost, true) : '--';
        return `<tr>
            <td>${t.date}</td>
            <td><span class="txn-action ${actionClass(t.action)}">${t.action}</span></td>
            <td>${qty}</td>
            <td>${price}</td>
            <td>${amount}</td>
            <td class="text-muted">${heldQty}</td>
            <td class="text-muted">${avgCostAfter}</td>
        </tr>`;
    }).join('');

    detailRow.querySelector('.txn-detail-container').innerHTML = `
        <table class="table table-sm txn-detail-table mb-0">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Action</th>
                    <th>Quantity</th>
                    <th>Price</th>
                    <th>Amount</th>
                    <th>Held Qty</th>
                    <th>Avg Cost</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function updateHoldingsTable(holdings) {
    // Store holdings data for re-sorting
    holdingsData = holdings || [];
    renderHoldingsTable(holdingsData);
    // Also update category table
    updateCategoryTable(holdingsData);
}

function updateCategoryTable(holdings) {
    const tbody = document.getElementById('categoryBody');

    if (!holdings || holdings.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center text-muted py-4">No category data available</td>
            </tr>
        `;
        return;
    }

    // Category colors for the indicator
    const categoryColors = {
        'Crypto': '#f59e0b',
        'Index': '#2563eb',
        'Individual Stocks': '#8b5cf6',
        'Cash': '#10b981'
    };

    // Aggregate holdings by category
    const categoryData = {};

    holdings.forEach(h => {
        const category = getCategory(h.symbol);

        if (!categoryData[category]) {
            categoryData[category] = {
                cost_basis: 0,
                market_value: 0,
                daily_change: 0,
                pnl: 0
            };
        }

        categoryData[category].cost_basis += h.cost_basis || 0;
        categoryData[category].market_value += h.market_value || 0;
        categoryData[category].daily_change += h.daily_change_amount || 0;
        categoryData[category].pnl += h.unrealized_pnl || 0;
    });

    // Calculate total market value first for percentage calculation
    const totalMarketValue = Object.values(categoryData).reduce((sum, data) => sum + data.market_value, 0);

    // Convert to array and sort by market value descending
    const categories = Object.entries(categoryData)
        .map(([name, data]) => ({
            name,
            ...data,
            pnl_percent: data.cost_basis > 0 ? (data.pnl / data.cost_basis) * 100 : 0,
            allocation_percent: totalMarketValue > 0 ? (data.market_value / totalMarketValue) * 100 : 0
        }))
        .sort((a, b) => b.market_value - a.market_value);

    // Calculate totals
    const totals = categories.reduce((acc, cat) => ({
        cost_basis: acc.cost_basis + cat.cost_basis,
        market_value: acc.market_value + cat.market_value,
        daily_change: acc.daily_change + cat.daily_change,
        pnl: acc.pnl + cat.pnl
    }), { cost_basis: 0, market_value: 0, daily_change: 0, pnl: 0 });
    totals.pnl_percent = totals.cost_basis > 0 ? (totals.pnl / totals.cost_basis) * 100 : 0;

    // Generate table rows
    let rows = categories.map(cat => {
        const isCash = cat.name === 'Cash';
        const dailyClass = cat.daily_change >= 0 ? 'text-success' : 'text-danger';
        const dailySign = cat.daily_change >= 0 ? '+' : '';
        const pnlClass = cat.pnl >= 0 ? 'text-success' : 'text-danger';
        const pnlSign = cat.pnl >= 0 ? '+' : '';
        const color = categoryColors[cat.name] || '#6b7280';

        const dailyChangeCell = isCash
            ? `<td class="text-muted">—</td>`
            : `<td class="${dailyClass}">${dailySign}${formatCurrency(cat.daily_change)}</td>`;
        const pnlCells = isCash
            ? `<td class="text-muted">—</td><td class="text-muted">—</td>`
            : `<td class="${pnlClass}">${pnlSign}${formatCurrency(cat.pnl)}</td><td class="${pnlClass}">${pnlSign}${cat.pnl_percent.toFixed(2)}%</td>`;

        return `
            <tr>
                <td>
                    <span style="display: inline-block; width: 12px; height: 12px; background-color: ${color}; border-radius: 2px; margin-right: 8px;"></span>
                    ${cat.name}
                    <span class="text-muted ms-2">(${cat.allocation_percent.toFixed(1)}%)</span>
                </td>
                <td>${formatCurrency(cat.cost_basis)}</td>
                ${dailyChangeCell}
                <td>${formatCurrency(cat.market_value)}</td>
                ${pnlCells}
            </tr>
        `;
    }).join('');

    // Add total row
    const totalDailyClass = totals.daily_change >= 0 ? 'text-success' : 'text-danger';
    const totalDailySign = totals.daily_change >= 0 ? '+' : '';
    const totalPnlClass = totals.pnl >= 0 ? 'text-success' : 'text-danger';
    const totalPnlSign = totals.pnl >= 0 ? '+' : '';

    rows += `
        <tr class="total-row">
            <td><strong>Total</strong></td>
            <td><strong>${formatCurrency(totals.cost_basis)}</strong></td>
            <td class="${totalDailyClass}"><strong>${totalDailySign}${formatCurrency(totals.daily_change)}</strong></td>
            <td><strong>${formatCurrency(totals.market_value)}</strong></td>
            <td class="${totalPnlClass}"><strong>${totalPnlSign}${formatCurrency(totals.pnl)}</strong></td>
            <td class="${totalPnlClass}"><strong>${totalPnlSign}${totals.pnl_percent.toFixed(2)}%</strong></td>
        </tr>
    `;

    tbody.innerHTML = rows;
}

function updateDividendsTable(dividends) {
    const tbody = document.getElementById('dividendsBody');

    if (!dividends || !dividends.by_asset || dividends.by_asset.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="empty-state">No dividends recorded</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = dividends.by_asset.map(d => `
        <tr>
            <td>${getAssetIconHtml(d.symbol)}<strong>${d.symbol}</strong></td>
            <td>${formatCurrency(d.total_amount)}</td>
            <td>${d.payment_count}</td>
        </tr>
    `).join('');
}

function sortSoldAssets(assets, column, direction) {
    return [...assets].sort((a, b) => {
        let aVal = a[column];
        let bVal = b[column];

        // Handle null/undefined values
        if (aVal === null || aVal === undefined) aVal = -Infinity;
        if (bVal === null || bVal === undefined) bVal = -Infinity;

        // String comparison for symbol
        if (column === 'symbol') {
            aVal = aVal.toString().toLowerCase();
            bVal = bVal.toString().toLowerCase();
            if (direction === 'asc') {
                return aVal.localeCompare(bVal);
            } else {
                return bVal.localeCompare(aVal);
            }
        }

        // Numeric comparison for other columns
        if (direction === 'asc') {
            return aVal - bVal;
        } else {
            return bVal - aVal;
        }
    });
}

function updateSoldSortIndicators() {
    document.querySelectorAll('#soldTable th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === soldSortColumn) {
            th.classList.add(soldSortDirection);
        }
    });
}

function renderSoldTable() {
    const tbody = document.getElementById('soldBody');

    if (!soldData || !soldData.sold_assets || soldData.sold_assets.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="8" class="empty-state">No realized P&L</td>
            </tr>
        `;
        return;
    }

    // Sort assets
    const sortedAssets = sortSoldAssets(soldData.sold_assets, soldSortColumn, soldSortDirection);

    // Build rows
    let rows = sortedAssets.map(s => `
        <tr>
            <td>${getAssetIconHtml(s.symbol)}<strong>${displaySymbol(s.symbol)}</strong></td>
            <td>${formatNumber(s.quantity, 4)}</td>
            <td>${formatPrice(s.symbol, s.avg_cost)}</td>
            <td>${formatCurrency(s.cost_basis)}</td>
            <td>${formatPrice(s.symbol, s.avg_sell_price)}</td>
            <td>${formatCurrency(s.proceeds)}</td>
            <td class="${s.pnl >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(s.pnl)}</td>
            <td class="${s.pnl_percent >= 0 ? 'text-success' : 'text-danger'}">${formatPercent(s.pnl_percent)}</td>
        </tr>
    `).join('');

    // Add total row
    rows += `
        <tr class="total-row">
            <td><strong>TOTAL</strong></td>
            <td></td>
            <td></td>
            <td>${formatCurrency(soldData.total_cost_basis)}</td>
            <td></td>
            <td>${formatCurrency(soldData.total_proceeds)}</td>
            <td class="${soldData.total_pnl >= 0 ? 'text-success' : 'text-danger'}"><strong>${formatCurrency(soldData.total_pnl)}</strong></td>
            <td></td>
        </tr>
    `;

    tbody.innerHTML = rows;
    updateSoldSortIndicators();
}

function updateSoldTable(sold) {
    soldData = sold;
    renderSoldTable();
}

// Fetch and update portfolio chart based on period
async function fetchAndUpdatePortfolioChart(period, view = 'value') {
    let url = '/api/performance';

    if (period !== 'ALL') {
        const endDate = new Date();
        let startDate = new Date();

        if (period === '1Y') {
            startDate.setFullYear(endDate.getFullYear() - 1);
        } else if (period === '3Y') {
            startDate.setFullYear(endDate.getFullYear() - 3);
        } else if (period === '5Y') {
            startDate.setFullYear(endDate.getFullYear() - 5);
        }

        const startStr = startDate.toISOString().split('T')[0];
        const endStr = endDate.toISOString().split('T')[0];
        url = `/api/performance?start_date=${startStr}&end_date=${endStr}`;
    }

    try {
        const response = await fetch(url);
        const data = await response.json();
        currentPerformanceData = data;
        updatePerformanceChart(data);
    } catch (error) {
        console.error('Error fetching portfolio data:', error);
    }
}

function updatePerformanceChart(performance) {
    // Store data for chart switching
    if (performance) {
        currentPerformanceData = performance;
    }

    const ctx = document.getElementById('performanceChart').getContext('2d');

    if (performanceChart) {
        performanceChart.destroy();
    }

    if (!performance || !performance.performance || performance.performance.length === 0) {
        // Show empty state
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No performance data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const data = performance.performance;

    performanceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{
                label: 'Portfolio Value',
                data: data.map(d => d.value),
                // Store investment values and cost basis for P&L calculation
                investmentValues: data.map(d => d.investment_value || d.value),
                costBasisValues: data.map(d => d.cost_basis || 0),
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.1)',
                fill: true,
                tension: 0.2,
                pointRadius: 0,
                pointHoverRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                datalabels: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        title: (context) => context[0].label,
                        label: (context) => {
                            const totalValue = context.raw;
                            const dataIndex = context.dataIndex;
                            const investmentValue = context.dataset.investmentValues[dataIndex];
                            const costBasis = context.dataset.costBasisValues[dataIndex];
                            // P&L = market_value - cost_basis
                            const pnl = investmentValue - costBasis;
                            const pnlPercent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
                            const pnlSign = pnl >= 0 ? '+' : '';
                            return [
                                `Value: ${formatCurrency(totalValue)}`,
                                `P&L: ${pnlSign}${formatCurrency(pnl)}`,
                                `P&L %: ${pnlSign}${pnlPercent.toFixed(2)}%`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxTicksLimit: 8
                    }
                },
                y: {
                    grid: {
                        color: '#e5e7eb'
                    },
                    ticks: {
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        }
    });
}

async function updateInvestmentChart(performance, period = 'ALL') {
    const ctx = document.getElementById('investmentChart').getContext('2d');

    if (investmentChart) {
        investmentChart.destroy();
    }

    // Use dedicated /api/investments endpoint (no yfinance needed, much faster)
    let url = '/api/investments';

    if (period !== 'ALL') {
        const endDate = new Date();
        let startDate = new Date();

        if (period === '1Y') {
            startDate.setFullYear(endDate.getFullYear() - 1);
        } else if (period === '3Y') {
            startDate.setFullYear(endDate.getFullYear() - 3);
        } else if (period === '5Y') {
            startDate.setFullYear(endDate.getFullYear() - 5);
        }

        const startStr = startDate.toISOString().split('T')[0];
        const endStr = endDate.toISOString().split('T')[0];
        url = `/api/investments?start_date=${startStr}&end_date=${endStr}`;
    }

    let data;
    try {
        const response = await fetch(url);
        const result = await response.json();
        data = result.investments || [];
    } catch (error) {
        console.error('Error fetching investment data:', error);
        data = [];
    }

    if (!data || data.length === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No investment data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    // Calculate monthly totals for bar labels (sum of by_category to match stacked bars)
    const monthlyTotals = {};
    data.forEach(d => {
        if (d.by_category) {
            monthlyTotals[d.month] = Object.values(d.by_category).reduce((sum, v) => sum + v, 0);
        } else {
            monthlyTotals[d.month] = 0;
        }
    });

    // Category colors (matching allocation chart)
    const categoryColors = {
        'Crypto': '#f59e0b',
        'Index': '#2563eb',
        'Individual Stocks': '#8b5cf6',
        'Cash': '#10b981'
    };

    // Get all unique categories and months
    const categories = new Set();
    data.forEach(d => {
        if (d.by_category) {
            Object.keys(d.by_category).forEach(cat => categories.add(cat));
        }
    });

    const months = data.map(d => d.month);

    // Store transactions for tooltip
    const transactionsByMonth = {};
    data.forEach(d => {
        transactionsByMonth[d.month] = d.transactions || [];
    });

    // Create datasets for each category (sorted by total amount descending)
    const categoryTotals = {};
    categories.forEach(cat => {
        categoryTotals[cat] = data.reduce((sum, d) => {
            return sum + Math.abs(d.by_category?.[cat] || 0);
        }, 0);
    });

    const sortedCategories = Array.from(categories).sort((a, b) => categoryTotals[b] - categoryTotals[a]);

    const datasets = sortedCategories.map(category => ({
        label: category,
        data: data.map(d => d.by_category?.[category] || 0),
        backgroundColor: categoryColors[category] || '#6b7280',
        borderColor: categoryColors[category] || '#6b7280',
        borderWidth: 1,
        borderRadius: 2
    }));

    investmentChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: months,
            datasets: datasets
        },
        plugins: [ChartDataLabels],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            scales: {
                x: {
                    stacked: true,
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxTicksLimit: 12,
                        callback: function(value, index) {
                            const label = this.getLabelForValue(value);
                            const [year, m] = label.split('-');
                            const monthNames = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
                            return monthNames[parseInt(m) - 1];
                        }
                    }
                },
                y: {
                    stacked: true,
                    grid: {
                        color: '#e5e7eb'
                    },
                    ticks: {
                        callback: (value) => {
                            const sign = value >= 0 ? '+' : '';
                            return sign + formatCurrency(value);
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 8
                    }
                },
                datalabels: {
                    display: function(context) {
                        // Only show on the last (topmost) dataset
                        return context.datasetIndex === context.chart.data.datasets.length - 1;
                    },
                    anchor: 'end',
                    align: 'top',
                    offset: 2,
                    font: {
                        size: 10,
                        weight: 'bold'
                    },
                    color: '#374151',
                    formatter: function(value, context) {
                        if (anonymousMode) return '';
                        const month = context.chart.data.labels[context.dataIndex];
                        const total = monthlyTotals[month] || 0;
                        if (total === 0) return '';
                        // Format as "x.xk"
                        const absTotal = Math.abs(total);
                        if (absTotal >= 1000) {
                            return (total / 1000).toFixed(1) + 'k';
                        }
                        return total.toFixed(0);
                    }
                },
                tooltip: {
                    callbacks: {
                        title: (context) => {
                            const month = context[0].label;
                            // Format as "Jan 2024"
                            const [year, m] = month.split('-');
                            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                              'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                            return `${monthNames[parseInt(m) - 1]} ${year}`;
                        },
                        label: (context) => {
                            const value = context.raw;
                            if (value === 0) return null;
                            const sign = value >= 0 ? '+' : '';
                            if (anonymousMode) {
                                return `${context.dataset.label}: ***`;
                            }
                            return `${context.dataset.label}: ${sign}${formatCurrencyAlways(value)}`;
                        },
                        afterBody: (context) => {
                            // Only show transactions once (for the first non-zero item)
                            const dataIndex = context[0].dataIndex;
                            const month = context[0].label;
                            const transactions = transactionsByMonth[month];

                            // Check if this is the first context item
                            if (context[0].datasetIndex !== 0) return [];

                            if (!transactions || transactions.length === 0) {
                                return [];
                            }

                            const lines = ['', 'Transactions:'];
                            const sorted = [...transactions].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
                            sorted.forEach(tx => {
                                const sign = tx.action === 'BUY' ? '+' : '-';
                                if (anonymousMode) {
                                    lines.push(`  ${tx.action} ${tx.symbol}: ***`);
                                } else {
                                    lines.push(`  ${tx.action} ${tx.symbol}: ${sign}${formatCurrencyAlways(tx.amount)}`);
                                }
                            });
                            return lines;
                        }
                    }
                }
            }
        }
    });
}

function updateDailyPnlList(dailyPnlData, intraday) {
    const container = document.getElementById('dailyPnlList');
    if (!container) return;

    // Get today's P&L from intraday data (EST midnight baseline, same as chart)
    let todayDailyPnl = null;
    let todayDailyPnlPct = null;
    if (intraday && intraday.intraday && intraday.intraday.length > 0) {
        const lastPoint = intraday.intraday[intraday.intraday.length - 1];
        todayDailyPnl = lastPoint.daily_pnl;
        todayDailyPnlPct = lastPoint.daily_pnl_percent;
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Build days list from the /api/daily-pnl response (need ~35 days for 5 weeks)
    const rawDays = (dailyPnlData && dailyPnlData.daily_pnl) ? [...dailyPnlData.daily_pnl].reverse() : [];

    const days = rawDays.slice(0, 42).map(entry => {
        const dateStr = (entry.date || '').substring(0, 10);
        let change = entry.daily_pnl;
        let changePct = entry.daily_pnl_percent;
        let assetChanges = entry.asset_changes || [];

        // Use intraday data for today if available (consistent header + breakdown)
        if (dateStr === todayStr && intraday?.intraday?.length) {
            const lastPoint = intraday.intraday[intraday.intraday.length - 1];
            if (lastPoint.asset_changes?.length) assetChanges = lastPoint.asset_changes;
            if (todayDailyPnl !== null) {
                change = todayDailyPnl;
                changePct = todayDailyPnlPct;
            }
        }

        // Skip today if no data yet
        if (change === 0 && dateStr === todayStr && todayDailyPnl === null) return null;

        return { date: dateStr, change, changePct, assetChanges };
    }).filter(Boolean);

    if (days.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-4">No data available</div>';
        return;
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Compute Monday-of-week (ISO week start) for a YYYY-MM-DD string
    function mondayOf(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        const dow = dt.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const offset = (dow === 0) ? 6 : (dow - 1);
        dt.setDate(dt.getDate() - offset);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }

    // Group days by week (Monday-start)
    const weekMap = new Map();
    for (const d of days) {
        const key = mondayOf(d.date);
        if (!weekMap.has(key)) weekMap.set(key, []);
        weekMap.get(key).push(d);
    }

    // Pick the 5 most recent weeks. Newest (current) on the LEFT.
    const weekKeys = [...weekMap.keys()].sort().reverse().slice(0, 5);

    if (weekKeys.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-4">No data available</div>';
        return;
    }

    function fmtMD(dt) {
        return `${monthNames[dt.getMonth()]} ${dt.getDate()}`;
    }

    const columnsHtml = weekKeys.map((wkKey, wkIdx) => {
        const wkDays = weekMap.get(wkKey).slice().sort((a, b) => a.date.localeCompare(b.date));
        const weekSum = wkDays.reduce((s, d) => s + (d.change || 0), 0);
        const weekSign = weekSum >= 0 ? '+' : '';
        const weekClass = weekSum >= 0 ? 'text-success' : 'text-danger';

        // Aggregate per-asset for the week
        const assetAgg = {};
        wkDays.forEach(d => {
            (d.assetChanges || []).forEach(a => {
                assetAgg[a.symbol] = (assetAgg[a.symbol] || 0) + (a.pnl || 0);
            });
        });
        const aggSorted = Object.entries(assetAgg)
            .filter(([, v]) => Math.abs(v) > 0.005)
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

        const breakdownRows = aggSorted.map(([sym, pnl]) => {
            const cls = pnl >= 0 ? 'text-success' : 'text-danger';
            const sgn = pnl >= 0 ? '+' : '';
            return `<div class="daily-pnl-breakdown-row">
                <span class="breakdown-symbol">${getAssetIconHtml(sym)}${sym}</span>
                <span class="${cls}">${anonymousMode ? '***' : sgn + formatCurrencyAlways(pnl)}</span>
            </div>`;
        }).join('') || `<div class="text-muted small text-center py-2">No moves</div>`;

        // Week header label "Apr 28 – May 4"
        const [wy, wm, wd] = wkKey.split('-').map(Number);
        const weekStart = new Date(wy, wm - 1, wd);
        const weekEnd = new Date(wy, wm - 1, wd + 6);
        const isCurrent = wkIdx === 0;
        const headerLabel = `${fmtMD(weekStart)} – ${fmtMD(weekEnd)}${isCurrent ? ' <span class="weekly-pnl-badge">current</span>' : ''}`;

        const dayRowsHtml = wkDays.map((d, di) => {
            const [yy, mm, dd] = d.date.split('-').map(Number);
            const label = `${monthNames[mm - 1]} ${dd}`;
            const colorClass = d.change >= 0 ? 'text-success' : 'text-danger';
            const sign = d.change >= 0 ? '+' : '';
            const amountStr = `${sign}${formatCurrencyAlways(d.change)}`;
            const pctStr = `${sign}${(d.changePct ?? 0).toFixed(2)}%`;
            const dow = new Date(yy, mm - 1, dd).getDay();
            const weekendClass = (dow === 0 || dow === 6) ? ' weekend' : '';

            const dayBreakdownRows = [...(d.assetChanges || [])]
                .filter(a => Math.abs(a.pnl || 0) > 0.005)
                .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
                .map(a => {
                    const aSign = a.pnl >= 0 ? '+' : '';
                    const aClass = a.pnl >= 0 ? 'text-success' : 'text-danger';
                    return `<div class="daily-pnl-breakdown-row">
                        <span class="breakdown-symbol">${getAssetIconHtml(a.symbol)}${a.symbol}</span>
                        <span class="${aClass}">${anonymousMode ? '***' : aSign + formatCurrencyAlways(a.pnl)}</span>
                    </div>`;
                }).join('') || `<div class="text-muted small text-center py-1">No moves</div>`;

            return `<div class="daily-pnl-item${weekendClass}" data-wk="${wkIdx}" data-di="${di}" style="cursor:pointer;flex-direction:column;align-items:stretch;">
                <div class="daily-pnl-item-row">
                    <span class="date"><i class="bi bi-chevron-right daily-pnl-chevron me-1"></i>${label}</span>
                    <span class="values ${colorClass}">
                        <span class="pnl-amount">${amountStr}</span>
                        ${anonymousMode ? '' : `<span class="pnl-percent">(${pctStr})</span>`}
                    </span>
                </div>
                <div class="daily-pnl-breakdown" style="display:none;">${dayBreakdownRows}</div>
            </div>`;
        }).join('');

        return `<div class="weekly-pnl-col${isCurrent ? ' is-current' : ''}" data-wk="${wkIdx}">
            <div class="weekly-pnl-header">${headerLabel}</div>
            <div class="weekly-pnl-days">${dayRowsHtml}</div>
            <div class="weekly-pnl-summary" data-wk-summary>
                <span class="date"><i class="bi bi-chevron-right weekly-pnl-chevron me-1"></i>Weekly</span>
                <span class="values ${weekClass}">
                    <span class="pnl-amount">${weekSign}${formatCurrencyAlways(weekSum)}</span>
                </span>
            </div>
            <div class="weekly-pnl-breakdown" style="display:none;">${breakdownRows}</div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="weekly-pnl-grid">${columnsHtml}</div>`;

    // Click to expand a single day
    container.querySelectorAll('.daily-pnl-item').forEach(item => {
        item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const breakdown = item.querySelector('.daily-pnl-breakdown');
            const chevron = item.querySelector('.daily-pnl-chevron');
            const isOpen = breakdown.style.display !== 'none';
            breakdown.style.display = isOpen ? 'none' : 'block';
            chevron.classList.toggle('rotated', !isOpen);
        });
    });

    // Click to expand the weekly summary
    container.querySelectorAll('.weekly-pnl-summary').forEach(sum => {
        sum.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const breakdown = sum.parentElement.querySelector('.weekly-pnl-breakdown');
            const chevron = sum.querySelector('.weekly-pnl-chevron');
            const isOpen = breakdown.style.display !== 'none';
            breakdown.style.display = isOpen ? 'none' : 'block';
            chevron.classList.toggle('rotated', !isOpen);
        });
    });
}

function updateMonthlyPnlList(dailyPnlData) {
    const container = document.getElementById('monthlyPnlList');
    if (!container) return;

    const rawDays = (dailyPnlData && dailyPnlData.daily_pnl) ? [...dailyPnlData.daily_pnl] : [];
    if (rawDays.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-4">No data available</div>';
        return;
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function mondayOf(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        const dow = dt.getDay();
        const offset = dow === 0 ? 6 : dow - 1;
        dt.setDate(dt.getDate() - offset);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }

    // Group by YYYY-MM
    const monthMap = new Map();
    for (const entry of rawDays) {
        const key = entry.date.substring(0, 7);
        if (!monthMap.has(key)) monthMap.set(key, []);
        monthMap.get(key).push(entry);
    }

    // Newest first, max 12 months
    const monthKeys = [...monthMap.keys()].sort().reverse().slice(0, 12);
    if (monthKeys.length === 0) {
        container.innerHTML = '<div class="text-center text-muted py-4">No data available</div>';
        return;
    }

    const columnsHtml = monthKeys.map((monthKey, mIdx) => {
        const [y, m] = monthKey.split('-').map(Number);
        const isCurrent = mIdx === 0;
        const monthLabel = `${monthNames[m - 1]} ${y}`;
        const days = monthMap.get(monthKey);

        // Group days by ISO week (Monday-start)
        const weekMap = new Map();
        for (const d of days) {
            const wk = mondayOf(d.date);
            if (!weekMap.has(wk)) weekMap.set(wk, []);
            weekMap.get(wk).push(d);
        }
        const weekKeys = [...weekMap.keys()].sort();

        // Monthly totals
        const monthTotal = days.reduce((s, d) => s + (d.daily_pnl || 0), 0);
        const monthSign = monthTotal >= 0 ? '+' : '';
        const monthClass = monthTotal >= 0 ? 'text-success' : 'text-danger';

        // Per-asset aggregate for monthly footer
        const monthAssetAgg = {};
        days.forEach(d => {
            (d.asset_changes || []).forEach(a => {
                monthAssetAgg[a.symbol] = (monthAssetAgg[a.symbol] || 0) + (a.pnl || 0);
            });
        });
        const monthAssetSorted = Object.entries(monthAssetAgg)
            .filter(([, v]) => Math.abs(v) > 0.005)
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

        const monthBreakdownRows = monthAssetSorted.map(([sym, pnl]) => {
            const cls = pnl >= 0 ? 'text-success' : 'text-danger';
            const sgn = pnl >= 0 ? '+' : '';
            return `<div class="daily-pnl-breakdown-row">
                <span class="breakdown-symbol">${getAssetIconHtml(sym)}${sym}</span>
                <span class="${cls}">${anonymousMode ? '***' : sgn + formatCurrencyAlways(pnl)}</span>
            </div>`;
        }).join('') || `<div class="text-muted small text-center py-2">No data</div>`;

        // Build week rows
        const weekRowsHtml = weekKeys.map((wkKey, wIdx) => {
            const wkDays = weekMap.get(wkKey).slice().sort((a, b) => a.date.localeCompare(b.date));
            const weekSum = wkDays.reduce((s, d) => s + (d.daily_pnl || 0), 0);
            const weekSign = weekSum >= 0 ? '+' : '';
            const weekClass = weekSum >= 0 ? 'text-success' : 'text-danger';

            // Week label: "May 5–7" (only days that have data)
            const first = wkDays[0].date;
            const last = wkDays[wkDays.length - 1].date;
            const [fy, fm, fd] = first.split('-').map(Number);
            const [ly, lm, ld] = last.split('-').map(Number);
            const startLbl = `${monthNames[fm - 1]} ${fd}`;
            const endLbl   = `${monthNames[lm - 1]} ${ld}`;
            const weekLabel = first === last ? startLbl : `${startLbl}–${endLbl}`;

            // Day rows inside expanded week
            const dayRowsHtml = wkDays.map(d => {
                const [dy, dm, dd] = d.date.split('-').map(Number);
                const dayLabel = `${monthNames[dm - 1]} ${dd}`;
                const dayClass = d.daily_pnl >= 0 ? 'text-success' : 'text-danger';
                const daySign  = d.daily_pnl >= 0 ? '+' : '';

                const assetRows = [...(d.asset_changes || [])]
                    .filter(a => Math.abs(a.pnl || 0) > 0.005)
                    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
                    .map(a => {
                        const aSign = a.pnl >= 0 ? '+' : '';
                        const aClass = a.pnl >= 0 ? 'text-success' : 'text-danger';
                        return `<div class="daily-pnl-breakdown-row" style="padding-left:0.5rem">
                            <span class="breakdown-symbol">${getAssetIconHtml(a.symbol)}${a.symbol}</span>
                            <span class="${aClass}">${anonymousMode ? '***' : aSign + formatCurrencyAlways(a.pnl)}</span>
                        </div>`;
                    }).join('');

                return `<div class="monthly-pnl-day-item">
                    <div class="monthly-pnl-day-row">
                        <span class="day-label">${dayLabel}</span>
                        <span class="${dayClass} pnl-amount">${anonymousMode ? '***' : daySign + formatCurrencyAlways(d.daily_pnl)}</span>
                    </div>
                    ${assetRows ? `<div class="monthly-pnl-asset-rows">${assetRows}</div>` : ''}
                </div>`;
            }).join('');

            return `<div class="monthly-pnl-week-item" data-mi="${mIdx}" data-wi="${wIdx}">
                <div class="monthly-pnl-week-item-row">
                    <span class="week-label"><i class="bi bi-chevron-right monthly-pnl-week-chevron me-1"></i>${weekLabel}</span>
                    <span class="${weekClass} pnl-amount">${anonymousMode ? '***' : weekSign + formatCurrencyAlways(weekSum)}</span>
                </div>
                <div class="monthly-pnl-week-breakdown" style="display:none;">${dayRowsHtml}</div>
            </div>`;
        }).join('');

        return `<div class="monthly-pnl-col${isCurrent ? ' is-current' : ''}">
            <div class="monthly-pnl-header">${monthLabel}${isCurrent ? ' <span class="weekly-pnl-badge">current</span>' : ''}</div>
            <div class="monthly-pnl-weeks">${weekRowsHtml}</div>
            <div class="monthly-pnl-summary">
                <span class="date"><i class="bi bi-chevron-right weekly-pnl-chevron me-1"></i>Monthly</span>
                <span class="${monthClass}"><span class="pnl-amount">${anonymousMode ? '***' : monthSign + formatCurrencyAlways(monthTotal)}</span></span>
            </div>
            <div class="monthly-pnl-summary-breakdown" style="display:none;">${monthBreakdownRows}</div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="monthly-pnl-grid">${columnsHtml}</div>`;

    // Expand/collapse week rows
    container.querySelectorAll('.monthly-pnl-week-item').forEach(item => {
        item.addEventListener('click', ev => {
            ev.stopPropagation();
            const breakdown = item.querySelector('.monthly-pnl-week-breakdown');
            const chevron   = item.querySelector('.monthly-pnl-week-chevron');
            const isOpen = breakdown.style.display !== 'none';
            breakdown.style.display = isOpen ? 'none' : 'block';
            chevron.classList.toggle('rotated', !isOpen);
        });
    });

    // Expand/collapse monthly summary footer
    container.querySelectorAll('.monthly-pnl-summary').forEach(sum => {
        sum.addEventListener('click', ev => {
            ev.stopPropagation();
            const breakdown = sum.parentElement.querySelector('.monthly-pnl-summary-breakdown');
            const chevron   = sum.querySelector('.weekly-pnl-chevron');
            const isOpen = breakdown.style.display !== 'none';
            breakdown.style.display = isOpen ? 'none' : 'block';
            chevron.classList.toggle('rotated', !isOpen);
        });
    });
}

function updatePnlChart(performance) {
    const ctx = document.getElementById('pnlChart').getContext('2d');

    if (pnlChart) {
        pnlChart.destroy();
    }

    if (!performance || !performance.performance || performance.performance.length === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No performance data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const data = performance.performance;

    // Calculate P&L for each data point: market_value - cost_basis
    const pnlData = data.map(d => {
        const investmentValue = d.investment_value || d.value;
        const costBasis = d.cost_basis || 0;
        return investmentValue - costBasis;
    });

    // Store cost basis data for tooltip calculations
    const costBasisData = data.map(d => d.cost_basis || 0);

    // Store investment value data for tooltip calculations
    const investmentValueData = data.map(d => d.investment_value || d.value || 0);

    // Use the first P&L value as the baseline
    const baselineValue = pnlData[0] || 0;

    // Use the first investment value for percentage calculation
    const startingInvestmentValue = investmentValueData[0] || 0;

    // Create segment coloring based on baseline
    const segmentColor = (ctx) => {
        const value = ctx.p1.parsed.y;
        return value >= baselineValue ? '#10b981' : '#ef4444';
    };

    const segmentBgColor = (ctx) => {
        const value = ctx.p1.parsed.y;
        return value >= baselineValue ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    };

    // Plugin to draw baseline and last point label
    const baselinePlugin = {
        id: 'baselineLine',
        afterDraw: (chart) => {
            const ctx = chart.ctx;
            const yAxis = chart.scales.y;
            const xAxis = chart.scales.x;
            const dataset = chart.data.datasets[0];
            const baseline = dataset.baselineValue;
            const startingValue = dataset.startingInvestmentValue;
            const data = dataset.data;
            const isTime = xAxis.type === 'time';

            // Helper to get Y value from data point (handles both {x,y} and scalar)
            const getY = (d) => (d && typeof d === 'object' && d.y !== undefined) ? d.y : d;
            const getX = (d) => (d && typeof d === 'object' && d.x !== undefined) ? d.x : null;

            if (baseline === undefined) return;

            // Draw baseline dashed line
            const yPixel = yAxis.getPixelForValue(baseline);
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.moveTo(xAxis.left, yPixel);
            ctx.lineTo(xAxis.right, yPixel);
            ctx.stroke();
            ctx.restore();

            // Draw vertical day dividers for multi-day (3D/1W) views
            if (isTime && data.length > 1) {
                // Collect unique dates and draw dividers at midnight boundaries
                const dates = [...new Set(data.map(d => getX(d)?.substring(0, 10)).filter(Boolean))];

                // Use backend daily P&L data (matches Daily P&L panel)
                const backendDailyPnl = chart.data.datasets[0]?.dailyPnlMap || {};

                // Fallback: compute from chart data if backend data not available
                const firstValByDate = {};
                for (const d of data) {
                    const dateStr = getX(d)?.substring(0, 10);
                    const val = getY(d);
                    if (dateStr && val != null && !(dateStr in firstValByDate)) {
                        firstValByDate[dateStr] = val;
                    }
                }
                const chartDailyPnl = {};
                for (let i = 0; i < dates.length; i++) {
                    const nextFirst = i < dates.length - 1 ? firstValByDate[dates[i + 1]] : null;
                    const thisFirst = firstValByDate[dates[i]];
                    if (nextFirst != null && thisFirst != null) {
                        chartDailyPnl[dates[i]] = nextFirst - thisFirst;
                    }
                }

                // Helper to draw date label + daily P&L at a given x position
                const drawDayLabel = (x, dateStr) => {
                    ctx.save();
                    ctx.setLineDash([]);
                    ctx.font = '11px sans-serif';
                    ctx.fillStyle = '#9ca3af';
                    ctx.textAlign = 'left';
                    ctx.fillText(dateStr.substring(5), x + 4, yAxis.top + 12);
                    const dailyChange = backendDailyPnl[dateStr] != null ? backendDailyPnl[dateStr] : chartDailyPnl[dateStr];
                    if (dailyChange != null) {
                        const sign = dailyChange >= 0 ? '+' : '';
                        ctx.font = 'bold 10px sans-serif';
                        ctx.fillStyle = dailyChange >= 0 ? '#10b981' : '#ef4444';
                        ctx.fillText(anonymousMode ? '***' : sign + formatCurrencyAlways(dailyChange), x + 4, yAxis.top + 26);
                    }
                    ctx.restore();
                };

                // First day label at left edge of chart
                drawDayLabel(xAxis.left, dates[0]);

                // Dividers and labels for subsequent days
                for (let di = 1; di < dates.length; di++) {
                    const midnightStr = dates[di] + 'T00:00:00';
                    const x = xAxis.getPixelForValue(new Date(midnightStr));
                    ctx.save();
                    ctx.beginPath();
                    ctx.setLineDash([4, 4]);
                    ctx.strokeStyle = 'rgba(156, 163, 175, 0.5)';
                    ctx.lineWidth = 1;
                    ctx.moveTo(x, yAxis.top);
                    ctx.lineTo(x, yAxis.bottom);
                    ctx.stroke();
                    ctx.restore();
                    // Date label + P&L for THIS day (under its own date)
                    drawDayLabel(x, dates[di]);
                }
            } else if (!isTime) {
                const labels = chart.data.labels;
                if (labels && labels.length > 1) {
                    const hasIntraday = labels[0] && labels[0].includes('T');
                    if (hasIntraday) {
                        // Intraday category dividers (per day boundary)
                        let prevDate = labels[0].substring(0, 10);
                        for (let i = 1; i < labels.length; i++) {
                            const currDate = labels[i].substring(0, 10);
                            if (currDate !== prevDate) {
                                const x = xAxis.getPixelForValue(i);
                                ctx.save();
                                ctx.beginPath();
                                ctx.setLineDash([4, 4]);
                                ctx.strokeStyle = 'rgba(156, 163, 175, 0.5)';
                                ctx.lineWidth = 1;
                                ctx.moveTo(x, yAxis.top);
                                ctx.lineTo(x, yAxis.bottom);
                                ctx.stroke();
                                ctx.setLineDash([]);
                                ctx.font = '11px sans-serif';
                                ctx.fillStyle = '#9ca3af';
                                ctx.textAlign = 'left';
                                ctx.fillText(currDate.substring(5), x + 4, yAxis.top + 12);
                                ctx.restore();
                                prevDate = currDate;
                            }
                        }
                    } else {
                        // Daily data dividers — interval based on data range
                        const totalDays = labels.length;
                        let interval;
                        if (totalDays <= 14) interval = 1;
                        else if (totalDays <= 45) interval = 3;
                        else if (totalDays <= 120) interval = 7;
                        else if (totalDays <= 400) interval = 30;
                        else interval = 90;

                        const pnlValues = data.map(d => getY(d));

                        // Draw start date label + P&L at left edge
                        const drawDailyLabel = (x, dateStr, pnlChange) => {
                            ctx.save();
                            ctx.setLineDash([]);
                            ctx.font = '10px sans-serif';
                            ctx.fillStyle = '#9ca3af';
                            ctx.textAlign = 'left';
                            ctx.fillText(dateStr.substring(5), x + 3, yAxis.top + 12);
                            if (pnlChange != null) {
                                const sign = pnlChange >= 0 ? '+' : '';
                                ctx.font = 'bold 9px sans-serif';
                                ctx.fillStyle = pnlChange >= 0 ? '#10b981' : '#ef4444';
                                ctx.fillText(anonymousMode ? '***' : sign + formatCurrencyAlways(pnlChange), x + 3, yAxis.top + 24);
                            }
                            ctx.restore();
                        };

                        // Start date label
                        drawDailyLabel(xAxis.left, labels[0], null);

                        let prevIdx = 0;
                        for (let i = interval; i < labels.length; i += interval) {
                            const dateStr = labels[i];
                            if (!dateStr) continue;
                            const x = xAxis.getPixelForValue(i);

                            // Vertical dashed line
                            ctx.save();
                            ctx.beginPath();
                            ctx.setLineDash([4, 4]);
                            ctx.strokeStyle = 'rgba(156, 163, 175, 0.4)';
                            ctx.lineWidth = 1;
                            ctx.moveTo(x, yAxis.top);
                            ctx.lineTo(x, yAxis.bottom);
                            ctx.stroke();
                            ctx.restore();

                            // P&L change from previous divider to this one
                            const pnlChange = (pnlValues[i] != null && pnlValues[prevIdx] != null)
                                ? pnlValues[i] - pnlValues[prevIdx] : null;
                            drawDailyLabel(x, dateStr, pnlChange);
                            prevIdx = i;
                        }
                    }
                }
            }

            // Draw vs Start label at the last data point
            if (data.length > 0) {
                const lastIndex = data.length - 1;
                const lastRaw = data[lastIndex];
                const lastValue = getY(lastRaw);
                const lastXVal = isTime ? new Date(getX(lastRaw)) : lastIndex;
                if (lastValue !== null && lastValue !== undefined) {
                    const x = xAxis.getPixelForValue(lastXVal);
                    const y = yAxis.getPixelForValue(lastValue);

                    // Calculate vs Start
                    const changeFromBaseline = lastValue - baseline;
                    const changePercent = startingValue !== 0 ? (changeFromBaseline / startingValue) * 100 : 0;
                    const changeSign = changeFromBaseline >= 0 ? '+' : '';

                    // Draw a dot at the last point
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(x, y, 5, 0, 2 * Math.PI);
                    ctx.fillStyle = changeFromBaseline >= 0 ? '#10b981' : '#ef4444';
                    ctx.fill();

                    // Draw vs Start label (position to the left to avoid overflow)
                    // In anonymous mode, show amount but hide percentage
                    const labelText = anonymousMode
                        ? `${changeSign}${formatCurrencyAlways(changeFromBaseline)}`
                        : `${changeSign}${formatCurrencyAlways(changeFromBaseline)} (${changeSign}${changePercent.toFixed(2)}%)`;
                    ctx.font = 'bold 12px sans-serif';
                    ctx.fillStyle = changeFromBaseline >= 0 ? '#10b981' : '#ef4444';

                    // Measure text width and position label to avoid overflow
                    const textWidth = ctx.measureText(labelText).width;
                    const chartRight = xAxis.right;

                    // If label would overflow, position it to the left of the point
                    if (x + 10 + textWidth > chartRight) {
                        ctx.textAlign = 'right';
                        ctx.fillText(labelText, x - 10, y - 5);
                    } else {
                        ctx.textAlign = 'left';
                        ctx.fillText(labelText, x + 10, y - 5);
                    }
                    ctx.restore();
                }
            }
        }
    };

    // Detect if data uses datetime labels (3D/1W views)
    const isTimeScale = data.length > 0 && data[0].date && data[0].date.includes('T');

    // For time scale, use {x, y} format; for category, use labels + data arrays
    const chartData = isTimeScale
        ? pnlData.map((y, i) => ({ x: data[i].date, y }))
        : pnlData;
    const chartLabels = isTimeScale ? undefined : data.map(d => d.date);

    pnlChart = new Chart(ctx, {
        type: 'line',
        data: {
            ...(chartLabels ? { labels: chartLabels } : {}),
            datasets: [{
                label: 'P&L',
                data: chartData,
                costBasisData: costBasisData,
                baselineValue: baselineValue,
                startingInvestmentValue: startingInvestmentValue,
                dailyPnlMap: performance.dailyPnlMap || null,
                segment: {
                    borderColor: segmentColor,
                    backgroundColor: segmentBgColor
                },
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                fill: {
                    target: { value: baselineValue },
                    above: 'rgba(16, 185, 129, 0.15)',
                    below: 'rgba(239, 68, 68, 0.15)'
                },
                tension: isTimeScale ? 0 : 0.2,
                pointRadius: 0,
                pointHoverRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'nearest',
                axis: 'x'
            },
            plugins: {
                legend: {
                    display: false
                },
                datalabels: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        title: (context) => {
                            const raw = context[0].raw;
                            if (raw && raw.x) {
                                const d = raw.x;
                                return d.substring(5, 10) + ' ' + d.substring(11, 16);
                            }
                            return context[0].label;
                        },
                        label: (context) => {
                            const pnl = isTimeScale ? context.raw.y : context.raw;
                            const dataIndex = context.dataIndex;
                            const costBasis = context.dataset.costBasisData[dataIndex];
                            const baseline = context.dataset.baselineValue;
                            const startingValue = context.dataset.startingInvestmentValue;
                            const pnlPercent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
                            const changeFromBaseline = pnl - baseline;
                            const changePercent = startingValue !== 0 ? (changeFromBaseline / startingValue) * 100 : 0;
                            const sign = pnl >= 0 ? '+' : '';
                            const changeSign = changeFromBaseline >= 0 ? '+' : '';
                            return [
                                `P&L: ${sign}${formatCurrency(pnl)}`,
                                `P&L %: ${sign}${pnlPercent.toFixed(2)}%`,
                                `vs Start: ${changeSign}${formatCurrency(changeFromBaseline)} (${changeSign}${changePercent.toFixed(2)}%)`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: isTimeScale ? {
                    type: 'time',
                    time: {
                        unit: 'hour',
                        displayFormats: {
                            hour: 'MM-dd HH:mm'
                        },
                        tooltipFormat: 'MM-dd HH:mm'
                    },
                    grid: { display: false },
                    ticks: { maxTicksLimit: 8 }
                } : {
                    grid: { display: false },
                    ticks: {
                        maxTicksLimit: 8,
                        callback: function(value, index) {
                            const label = this.getLabelForValue(index);
                            if (!label) return label;
                            if (label.length >= 10 && label[4] === '-') {
                                return label.substring(5, 10);
                            }
                            return label;
                        }
                    }
                },
                y: {
                    grid: {
                        color: '#e5e7eb'
                    },
                    ticks: {
                        callback: (value) => {
                            const sign = value >= 0 ? '+' : '';
                            return sign + formatCurrency(value);
                        }
                    }
                }
            }
        },
        plugins: [baselinePlugin]
    });
}

// Plugin to draw vertical lines for market open/close and current P&L label
const marketHoursPlugin = {
    id: 'marketHours',
    afterDraw: (chart) => {
        const ctx = chart.ctx;
        const xAxis = chart.scales.x;
        const yAxis = chart.scales.y;
        const labels = chart.data.labels;
        const dataset = chart.data.datasets[0];
        const data = dataset.data;

        // Determine which date this chart is showing (null = today)
        const chartDate = currentIntradayDate
            ? new Date(currentIntradayDate + 'T12:00:00')  // noon avoids UTC-offset day-shift
            : new Date();
        // Only draw market hour lines if the displayed date is a trading day
        if (isMarketDay(chartDate)) {
            const openIndex  = labels.findIndex(l => l === '09:30');
            const closeIndex = labels.findIndex(l => l === '16:00');
            const preIndex   = labels.findIndex(l => l === '04:00');
            const ahIndex    = labels.findIndex(l => l === '20:00');

            ctx.save();
            ctx.font = '11px sans-serif';

            // Pre-market (04:00) and post-market (20:00) — subtler style
            ctx.setLineDash([3, 6]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#6b7280';
            ctx.fillStyle = '#6b7280';

            if (preIndex !== -1) {
                const x = xAxis.getPixelForValue(preIndex);
                ctx.beginPath();
                ctx.moveTo(x, yAxis.top);
                ctx.lineTo(x, yAxis.bottom);
                ctx.stroke();
                ctx.fillText('Pre', x + 4, yAxis.top + 12);
            }

            if (ahIndex !== -1) {
                const x = xAxis.getPixelForValue(ahIndex);
                ctx.beginPath();
                ctx.moveTo(x, yAxis.top);
                ctx.lineTo(x, yAxis.bottom);
                ctx.stroke();
                ctx.fillText('AH', x + 4, yAxis.top + 12);
            }

            // Market open (09:30) and close (16:00) — solid style
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#9ca3af';
            ctx.fillStyle = '#9ca3af';

            if (openIndex !== -1) {
                const x = xAxis.getPixelForValue(openIndex);
                ctx.beginPath();
                ctx.moveTo(x, yAxis.top);
                ctx.lineTo(x, yAxis.bottom);
                ctx.stroke();
                ctx.fillText('Open', x + 4, yAxis.top + 12);
            }

            if (closeIndex !== -1) {
                const x = xAxis.getPixelForValue(closeIndex);
                ctx.beginPath();
                ctx.moveTo(x, yAxis.top);
                ctx.lineTo(x, yAxis.bottom);
                ctx.stroke();
                ctx.fillText('Close', x + 4, yAxis.top + 12);
            }

            ctx.restore();
        }

        // Draw current P&L label at the last data point
        if (dataset.lastDataIndex !== undefined && dataset.lastDataIndex >= 0) {
            const lastIndex = dataset.lastDataIndex;
            const lastValue = data[lastIndex];
            if (lastValue !== null) {
                const x = xAxis.getPixelForValue(lastIndex);
                const y = yAxis.getPixelForValue(lastValue);

                // Draw a dot at the last point
                ctx.save();
                ctx.beginPath();
                ctx.arc(x, y, 5, 0, 2 * Math.PI);
                ctx.fillStyle = lastValue >= 0 ? '#10b981' : '#ef4444';
                ctx.fill();

                // Draw P&L label (always show amount, hide percentage in anonymous mode)
                const sign = lastValue >= 0 ? '+' : '';
                const pnlText = `${sign}${formatCurrencyAlways(lastValue)}`;

                ctx.font = 'bold 12px sans-serif';
                ctx.fillStyle = lastValue >= 0 ? '#10b981' : '#ef4444';

                // Measure text width and position label to avoid overflow
                const textWidth = ctx.measureText(pnlText).width;
                const chartRight = xAxis.right;

                // If label would overflow, position it to the left of the point
                if (x + 10 + textWidth > chartRight) {
                    ctx.textAlign = 'right';
                    ctx.fillText(pnlText, x - 10, y - 5);

                    // Only show percentage if not in anonymous mode
                    if (!anonymousMode) {
                        const pnlPercent = dataset.pnlPercentData[lastIndex];
                        const percentText = `(${sign}${pnlPercent.toFixed(2)}%)`;
                        ctx.font = '11px sans-serif';
                        ctx.fillText(percentText, x - 10, y + 10);
                    }
                } else {
                    ctx.textAlign = 'left';
                    ctx.fillText(pnlText, x + 10, y - 5);

                    // Only show percentage if not in anonymous mode
                    if (!anonymousMode) {
                        const pnlPercent = dataset.pnlPercentData[lastIndex];
                        const percentText = `(${sign}${pnlPercent.toFixed(2)}%)`;
                        ctx.font = '11px sans-serif';
                        ctx.fillText(percentText, x + 10, y + 10);
                    }
                }
                ctx.restore();
            }
        }
    }
};

// Generate all time labels for a full day based on interval
function generateFullDayLabels(interval) {
    const labels = [];
    const intervalMinutes = parseInt(interval);

    for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += intervalMinutes) {
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            labels.push(timeStr);
        }
    }
    return labels;
}

function updateIntradayChart(intraday, interval = '5m') {
    const ctx = document.getElementById('intradayChart').getContext('2d');

    if (intradayChart) {
        intradayChart.destroy();
        intradayChart = null;
    }
    // Explicitly clear the canvas — Chart.js destroy() removes internal state
    // but does NOT wipe canvas pixels, so old curves would still be visible.
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    if (!intraday || !intraday.intraday || intraday.intraday.length === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No intraday data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    const rawData = intraday.intraday;

    // Create a map of time -> data for quick lookup
    const dataMap = {};
    rawData.forEach(d => {
        dataMap[d.time] = d;
    });

    // Generate full day labels based on interval
    const intervalMinutes = parseInt(interval);
    const fullDayLabels = generateFullDayLabels(intervalMinutes);

    // Map data to full day labels, fill with null for missing times
    const pnlData = [];
    const pnlPercentData = [];
    const baselineData = [];
    const assetChangesData = [];
    let lastDataIndex = -1;
    let lastPnl = 0;

    fullDayLabels.forEach((time, index) => {
        if (dataMap[time]) {
            pnlData.push(dataMap[time].daily_pnl);
            pnlPercentData.push(dataMap[time].daily_pnl_percent);
            baselineData.push(dataMap[time].baseline_value);
            assetChangesData.push(dataMap[time].asset_changes || []);
            lastDataIndex = index;
            lastPnl = dataMap[time].daily_pnl;
        } else {
            pnlData.push(null);
            pnlPercentData.push(null);
            baselineData.push(null);
            assetChangesData.push(null);
        }
    });

    // Segment coloring based on value (green above 0, red below 0)
    const segmentBorderColor = (ctx) => {
        const value = ctx.p1.parsed.y;
        return value >= 0 ? '#10b981' : '#ef4444';
    };

    const segmentBackgroundColor = (ctx) => {
        const value = ctx.p1.parsed.y;
        return value >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    };

    intradayChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: fullDayLabels,
            datasets: [{
                label: "Daily P&L",
                data: pnlData,
                pnlPercentData: pnlPercentData,
                baselineData: baselineData,
                assetChangesData: assetChangesData,
                lastDataIndex: lastDataIndex,
                segment: {
                    borderColor: segmentBorderColor,
                    backgroundColor: segmentBackgroundColor
                },
                borderColor: lastPnl >= 0 ? '#10b981' : '#ef4444',
                backgroundColor: lastPnl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                fill: {
                    target: 'origin'
                },
                tension: 0.2,
                pointRadius: 0,
                pointHoverRadius: 4,
                spanGaps: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                datalabels: {
                    display: false
                },
                tooltip: {
                    enabled: false,
                    external: function(context) {
                        let el = document.getElementById('intraday-tooltip');
                        if (!el) {
                            el = document.createElement('div');
                            el.id = 'intraday-tooltip';
                            el.style.cssText = 'position:fixed;background:#212529;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;pointer-events:none;z-index:9999;opacity:0;transition:opacity 0.15s;white-space:nowrap;line-height:1.6;';
                            document.body.appendChild(el);
                        }

                        const tooltip = context.tooltip;
                        if (tooltip.opacity === 0) {
                            el.style.opacity = '0';
                            return;
                        }

                        const dataPoints = tooltip.dataPoints;
                        if (!dataPoints || !dataPoints[0] || dataPoints[0].raw === null) {
                            el.style.opacity = '0';
                            return;
                        }

                        const dp = dataPoints[0];
                        const pnl = dp.raw;
                        const dataIndex = dp.dataIndex;
                        const dataset = dp.dataset;
                        const pnlPercent = dataset.pnlPercentData[dataIndex];
                        if (pnlPercent === null) { el.style.opacity = '0'; return; }

                        const pnlColor = pnl >= 0 ? '#10b981' : '#ef4444';
                        const sign = pnl >= 0 ? '+' : '';

                        let html = `<div style="color:#9ca3af;margin-bottom:4px">Time: ${dp.label}</div>`;
                        html += `<div style="color:${pnlColor}">Daily P&L: ${sign}${formatCurrencyAlways(pnl)}</div>`;
                        if (!anonymousMode) {
                            const pctSign = pnlPercent >= 0 ? '+' : '';
                            html += `<div style="color:${pnlColor}">Daily P&L %: ${pctSign}${pnlPercent.toFixed(2)}%</div>`;
                        }

                        // Top Movers
                        const assetChanges = dataset.assetChangesData[dataIndex];
                        if (assetChanges && assetChanges.length > 0) {
                            const nonZero = assetChanges.filter(a => Math.abs(a.pnl) >= 0.01).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
                            if (nonZero.length > 0) {
                                html += `<div style="color:#6b7280;margin-top:6px;border-top:1px solid #374151;padding-top:4px">── Top Movers ──</div>`;
                                nonZero.forEach(asset => {
                                    const c = asset.pnl >= 0 ? '#10b981' : '#ef4444';
                                    const s = asset.pnl >= 0 ? '+' : '';
                                    if (anonymousMode) {
                                        html += `<div><span style="color:#d1d5db">${asset.symbol}:</span> <span style="color:${c}">${s}${formatCurrencyAlways(asset.pnl)}</span></div>`;
                                    } else {
                                        const ps = asset.pnl_percent >= 0 ? '+' : '';
                                        html += `<div><span style="color:#d1d5db">${asset.symbol}:</span> <span style="color:${c}">${s}${formatCurrencyAlways(asset.pnl)} (${ps}${asset.pnl_percent.toFixed(2)}%)</span></div>`;
                                    }
                                });
                            }
                        }

                        el.innerHTML = html;
                        el.style.opacity = '1';

                        // Position tooltip
                        const chartRect = context.chart.canvas.getBoundingClientRect();
                        let x = chartRect.left + tooltip.caretX + 12;
                        let y = chartRect.top + tooltip.caretY - 12;
                        const elRect = el.getBoundingClientRect();
                        if (x + elRect.width > window.innerWidth - 8) x = x - elRect.width - 24;
                        if (y + elRect.height > window.innerHeight - 8) y = window.innerHeight - elRect.height - 8;
                        if (y < 8) y = 8;
                        el.style.left = x + 'px';
                        el.style.top = y + 'px';
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxTicksLimit: 12,
                        callback: function(value, index) {
                            // Show fewer labels for readability
                            const label = this.getLabelForValue(value);
                            // Show labels at every 2 hours
                            if (label && (label.endsWith(':00') && parseInt(label.split(':')[0]) % 2 === 0)) {
                                return label;
                            }
                            return '';
                        }
                    }
                },
                y: {
                    grid: {
                        color: '#e5e7eb'
                    },
                    ticks: {
                        callback: (value) => {
                            const sign = value >= 0 ? '+' : '';
                            return sign + formatCurrencyAlways(value);
                        }
                    }
                }
            }
        },
        plugins: [marketHoursPlugin]
    });
}

function updateAllocationChart(holdings, view = 'assets') {
    const ctx = document.getElementById('allocationChart').getContext('2d');

    // Store holdings for view switching
    if (holdings) {
        currentHoldingsForAllocation = holdings;
    } else {
        holdings = currentHoldingsForAllocation;
    }

    if (allocationChart) {
        allocationChart.destroy();
    }

    if (!holdings || holdings.length === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No holdings data', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    // Filter holdings with valid market values
    const validHoldings = holdings.filter(h => h.market_value && h.market_value > 0);

    if (validHoldings.length === 0) {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.fillText('No market value data', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }

    // Calculate total
    const total = validHoldings.reduce((sum, h) => sum + h.market_value, 0);
    const threshold = 0.03; // 3%

    let labels, data, chartColors;

    // Check if we're drilling into a specific category
    const specificCategories = ['Crypto', 'Index', 'Individual Stocks'];
    const isDrillDown = specificCategories.includes(view);

    if (isDrillDown) {
        // Drill-down view: show assets within the selected category
        const rawCategoryHoldings = validHoldings.filter(h => getCategory(h.symbol) === view);

        // Merge QQQ and QQQM into "QQQ(M)" for drill-down too
        const drillMergeSymbols = new Set(['QQQ', 'QQQM']);
        const categoryHoldings = [];
        let drillMergedValue = 0;
        let drillHasMerge = false;
        rawCategoryHoldings.forEach(h => {
            if (drillMergeSymbols.has(h.symbol)) {
                drillMergedValue += h.market_value;
                drillHasMerge = true;
            } else {
                categoryHoldings.push(h);
            }
        });
        if (drillHasMerge && drillMergedValue > 0) {
            categoryHoldings.push({ symbol: 'QQQ(M)', market_value: drillMergedValue });
        }

        if (categoryHoldings.length === 0) {
            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#6b7280';
            ctx.textAlign = 'center';
            ctx.fillText(`No ${view} holdings`, ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        const categoryTotal = categoryHoldings.reduce((sum, h) => sum + h.market_value, 0);

        // Sort by value
        categoryHoldings.sort((a, b) => b.market_value - a.market_value);

        labels = categoryHoldings.map(h => displaySymbol(h.symbol));
        data = categoryHoldings.map(h => h.market_value);

        // Colors based on category (dark to light, largest value gets darkest)
        // Crypto: orange, Index: blue, Individual Stocks: purple, Cash: green
        const categoryColorSchemes = {
            'Crypto': ['#92400e', '#b45309', '#d97706', '#f59e0b', '#fbbf24', '#fcd34d', '#fde68a', '#fef3c7'],
            'Index': ['#1e3a8a', '#1e40af', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'],
            'Individual Stocks': ['#581c87', '#6b21a8', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe'],
            'Cash': ['#065f46', '#047857', '#059669', '#10b981', '#34d399', '#6ee7b7', '#a7f3d0', '#d1fae5'],
        };
        const colorScheme = categoryColorSchemes[view] || ['#9ca3af'];
        // Assign colors from dark to light based on sorted position
        chartColors = data.map((_, i) => colorScheme[Math.min(i, colorScheme.length - 1)]);

    } else if (view === 'category') {
        // Group by category
        const categoryTotals = {};
        validHoldings.forEach(h => {
            const category = getCategory(h.symbol);
            categoryTotals[category] = (categoryTotals[category] || 0) + h.market_value;
        });

        // Convert to array and sort by value
        const categoryArray = Object.entries(categoryTotals)
            .map(([category, value]) => ({ category, value }))
            .sort((a, b) => b.value - a.value);

        labels = categoryArray.map(c => c.category);
        data = categoryArray.map(c => c.value);

        // Category colors: Crypto=orange, Index=blue, Individual Stocks=purple, Cash=green
        const categoryBaseColors = {
            'Crypto': '#f59e0b',      // Orange
            'Index': '#2563eb',       // Blue
            'Individual Stocks': '#8b5cf6',  // Purple
            'Cash': '#10b981',        // Green
        };

        chartColors = labels.map(label => categoryBaseColors[label] || '#9ca3af');

    } else {
        // Assets view (original logic)

        // Merge QQQ and QQQM into a single "QQQ(M)" entry for the chart
        const mergeSymbols = new Set(['QQQ', 'QQQM']);
        const chartHoldings = [];
        let mergedValue = 0;
        let hasMerge = false;
        validHoldings.forEach(h => {
            if (mergeSymbols.has(h.symbol)) {
                mergedValue += h.market_value;
                hasMerge = true;
            } else {
                chartHoldings.push(h);
            }
        });
        if (hasMerge && mergedValue > 0) {
            chartHoldings.push({ symbol: 'QQQ(M)', market_value: mergedValue });
        }

        const majorHoldings = [];
        let otherValue = 0;
        var otherHoldings = [];

        chartHoldings.forEach(h => {
            const percent = h.market_value / total;
            if (percent >= threshold) {
                majorHoldings.push(h);
            } else {
                otherValue += h.market_value;
                otherHoldings.push(h);
            }
        });

        // Sort other holdings by value descending for tooltip display
        otherHoldings.sort((a, b) => b.market_value - a.market_value);

        majorHoldings.sort((a, b) => b.market_value - a.market_value);

        labels = majorHoldings.map(h => displaySymbol(h.symbol));
        data = majorHoldings.map(h => h.market_value);

        if (otherValue > 0) {
            labels.push('OTHER');
            data.push(otherValue);
        }

        // Color based on category: Crypto=orange, Index=blue, Stocks=purple, Cash=green
        const categoryColorMap = {
            'Crypto': ['#92400e', '#b45309', '#d97706', '#f59e0b', '#fbbf24', '#fcd34d'],
            'Index': ['#1e3a8a', '#1e40af', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa'],
            'Individual Stocks': ['#581c87', '#6b21a8', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd'],
            'Cash': ['#065f46', '#047857', '#059669', '#10b981', '#34d399', '#6ee7b7'],
        };

        // Track color index per category for gradient effect
        const categoryColorIndex = {};

        chartColors = majorHoldings.map(h => {
            const sym = h.symbol === 'QQQ(M)' ? 'QQQ' : h.symbol;
            const category = getCategory(sym);
            const colors = categoryColorMap[category] || ['#9ca3af'];
            const idx = categoryColorIndex[category] || 0;
            categoryColorIndex[category] = idx + 1;
            return colors[Math.min(idx, colors.length - 1)];
        });

        // Add gray for OTHER
        if (otherValue > 0) {
            chartColors.push('#9ca3af');
        }
    }

    // Calculate the total for percentage display (use category total for drill-down)
    const displayTotal = isDrillDown
        ? data.reduce((sum, v) => sum + v, 0)
        : total;

    allocationChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: chartColors,
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: 10
            },
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        boxWidth: 12,
                        padding: 8,
                        font: {
                            size: 11
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const percent = ((context.raw / displayTotal) * 100).toFixed(1);
                            if (anonymousMode) {
                                return `${context.label}: *** (${percent}%)`;
                            }
                            return `${context.label}: ${formatCurrencyAlways(context.raw)} (${percent}%)`;
                        },
                        afterBody: (tooltipItems) => {
                            const item = tooltipItems[0];
                            if (item && item.label === 'OTHER' && typeof otherHoldings !== 'undefined' && otherHoldings.length > 0) {
                                const lines = ['───────────'];
                                otherHoldings.forEach(h => {
                                    const pct = ((h.market_value / displayTotal) * 100).toFixed(1);
                                    if (anonymousMode) {
                                        lines.push(`  ${displaySymbol(h.symbol)}: *** (${pct}%)`);
                                    } else {
                                        lines.push(`  ${displaySymbol(h.symbol)}: ${formatCurrencyAlways(h.market_value)} (${pct}%)`);
                                    }
                                });
                                return lines;
                            }
                            return [];
                        }
                    }
                },
                datalabels: {
                    color: '#fff',
                    font: {
                        weight: 'bold',
                        size: 11
                    },
                    formatter: (value, context) => {
                        const percent = (value / displayTotal) * 100;
                        // Hide label if slice is too small (less than 5%)
                        if (percent < 5) {
                            return '';
                        }
                        const label = context.chart.data.labels[context.dataIndex];
                        return `${label}\n${percent.toFixed(1)}%`;
                    },
                    textAlign: 'center',
                    // Position labels inside the slices
                    anchor: 'center',
                    align: 'center',
                    offset: 0,
                    // Add text shadow for better readability
                    textStrokeColor: 'rgba(0,0,0,0.3)',
                    textStrokeWidth: 2
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function updateAnnualTable(performance) {
    const tbody = document.getElementById('annualBody');

    if (!performance || !performance.performance || performance.performance.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">No performance data available</td>
            </tr>
        `;
        return;
    }

    const data = performance.performance;
    const realizedByYear = performance.realized_by_year || {};

    // Group data by year - get first and last data point for each year
    const yearlyData = {};
    data.forEach(d => {
        const year = d.date.substring(0, 4);
        const investmentValue = d.investment_value || d.value;
        const costBasis = d.cost_basis || 0;

        if (!yearlyData[year]) {
            yearlyData[year] = {
                startValue: investmentValue,
                startCostBasis: costBasis,
                endValue: investmentValue,
                endCostBasis: costBasis
            };
        } else {
            // Update end values (last data point of the year)
            yearlyData[year].endValue = investmentValue;
            yearlyData[year].endCostBasis = costBasis;
        }
    });

    // Calculate annual performance for each year
    const years = Object.keys(yearlyData).sort();
    const rows = [];

    years.forEach((year, index) => {
        const yearData = yearlyData[year];
        let startValue, netInvested;

        if (index === 0) {
            // First year: start value is the first cost basis (initial investment)
            startValue = yearData.startCostBasis;
            netInvested = yearData.endCostBasis - yearData.startCostBasis;
        } else {
            // Subsequent years: start value is previous year's end value
            const prevYear = years[index - 1];
            startValue = yearlyData[prevYear].endValue;
            // Net invested = change in cost basis during the year
            netInvested = yearData.endCostBasis - yearlyData[prevYear].endCostBasis;
        }

        const endValue = yearData.endValue;
        // P&L = end_value - start_value - net_invested
        const pnl = endValue - startValue - netInvested;
        // P&L% = P&L / (start_value + net_invested) * 100
        const totalInvested = startValue + netInvested;
        const pnlPercent = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;

        const realized = realizedByYear[year] || null;

        rows.push({
            year,
            startValue,
            endValue,
            netInvested,
            pnl,
            pnlPercent,
            realized
        });
    });

    // Render table rows (most recent year first)
    tbody.innerHTML = rows.reverse().map(r => {
        const totalInvested = r.startValue + r.netInvested;
        const pnlFormula = `P&L = End Value - Start Value - Net Invested
= ${formatCurrency(r.endValue)} - ${formatCurrency(r.startValue)} - ${formatCurrency(r.netInvested)}
= ${formatCurrency(r.pnl)}`;
        const pnlPercentFormula = `P&L% = P&L ÷ (Start Value + Net Invested) × 100
= ${formatCurrency(r.pnl)} ÷ ${formatCurrency(totalInvested)} × 100
= ${r.pnlPercent.toFixed(2)}%`;

        let realizedCell;
        if (r.realized && Math.abs(r.realized.total) > 0.005) {
            const rz = r.realized;
            const realizedFormula = `Realized = proceeds − cost basis on positions sold in ${r.year}
ST (held < 1yr): ${formatCurrency(rz.st)}
LT (held ≥ 1yr): ${formatCurrency(rz.lt)}
Total: ${formatCurrency(rz.total)}`;
            realizedCell = `<td class="has-tooltip" data-tooltip="${realizedFormula.replace(/"/g, '&quot;')}">
                <div class="${rz.total >= 0 ? 'text-success' : 'text-danger'} fw-semibold">${formatCurrency(rz.total)}</div>
                <div class="small text-muted">ST ${formatCurrency(rz.st)} · LT ${formatCurrency(rz.lt)}</div>
            </td>`;
        } else {
            realizedCell = `<td class="text-muted">—</td>`;
        }

        return `
        <tr>
            <td><strong>${r.year}</strong></td>
            <td>${formatCurrency(r.startValue)}</td>
            <td>${formatCurrency(r.endValue)}</td>
            <td>${formatCurrency(r.netInvested)}</td>
            <td class="${r.pnl >= 0 ? 'text-success' : 'text-danger'} has-tooltip" data-tooltip="${pnlFormula.replace(/"/g, '&quot;')}">${formatCurrency(r.pnl)}</td>
            <td class="${r.pnlPercent >= 0 ? 'text-success' : 'text-danger'} has-tooltip" data-tooltip="${pnlPercentFormula.replace(/"/g, '&quot;')}">${formatPercent(r.pnlPercent)}</td>
            ${realizedCell}
        </tr>
    `}).join('');

    // Setup tooltips for the new rows
    setupTooltips();
}

// Load performance data for a specific period
async function loadPerformanceData(period) {
    currentPeriod = period;

    // Update button states for Bootstrap
    document.querySelectorAll('.period-btn').forEach(btn => {
        if (btn.dataset.period === period) {
            btn.classList.remove('btn-outline-secondary');
            btn.classList.add('btn-primary', 'active');
        } else {
            btn.classList.remove('btn-primary', 'active');
            btn.classList.add('btn-outline-secondary');
        }
    });

    // For 3D/1W: use intraday-multiday API for evenly-spaced data across all days.
    if (period === '3D' || period === '1W') {
        const days = period === '3D' ? 4 : 8;
        const interval = period === '3D' ? '15m' : '60m';

        const [multidayData, summary, dailyPnlData] = await Promise.all([
            fetchIntradayMultiday(interval, days),
            fetchSummary(),
            fetchDailyPnl(false)
        ]);

        if (!multidayData?.data?.length) return;

        let actualCostBasis = 0;
        if (summary?.holdings) {
            actualCostBasis = summary.holdings
                .filter(h => h.symbol !== 'CASH')
                .reduce((sum, h) => sum + (h.cost_basis || 0), 0);
        }

        // Build daily P&L lookup from backend data (keyed by date)
        const dailyPnlMap = {};
        if (dailyPnlData?.daily_pnl) {
            dailyPnlData.daily_pnl.forEach(r => {
                dailyPnlMap[r.date] = r.daily_pnl;
            });
        }

        const performancePoints = multidayData.data.map(d => ({
            date: d.datetime,
            investment_value: d.value,
            cost_basis: actualCostBasis
        }));

        if (performancePoints.length > 0) {
            const performance = { performance: performancePoints, dailyPnlMap };
            updatePnlChart(performance);
            updatePerformanceChart(performance);
        }
        return;
    }

    const performance = await fetchPerformance(period);
    if (performance) {
        updatePnlChart(performance);
        updatePerformanceChart(performance);
    }
}

// Update the read-only interval badge in the Intraday card header
function updateIntradayIntervalBadge(interval) {
    const badge = document.getElementById('intradayIntervalBadge');
    if (badge) badge.textContent = interval || '--';
}

// Try intervals in order (finest first) and return the first that has data
async function fetchIntradayAutoInterval(date = null, useCache = true) {
    const intervals = ['1m', '5m', '15m', '30m'];
    for (const interval of intervals) {
        const data = await fetchIntraday(interval, date, useCache);
        if (data && data.intraday && data.intraday.length > 0) {
            return { data, interval };
        }
    }
    return { data: null, interval: '1m' };
}

// Load intraday data for a given date, auto-selecting the finest available interval
async function loadIntradayData(date = undefined, useCache = true) {
    if (date !== undefined) currentIntradayDate = date;

    // Show blocking overlay only when the user explicitly switches date
    const overlay = document.getElementById('intradayLoadingOverlay');
    if (date !== undefined && overlay) overlay.style.display = 'flex';

    try {
        const { data, interval } = await fetchIntradayAutoInterval(currentIntradayDate, useCache);
        currentInterval = interval;
        updateIntradayIntervalBadge(interval);
        if (data) {
            updateIntradayChart(data, interval);
        }
    } finally {
        if (overlay) overlay.style.display = 'none';
    }
}

// Main data loading function
async function loadAllData() {
    // Snapshot date at function start to guard against mid-flight date changes
    const snapshotDate = currentIntradayDate;

    // Fetch targets alongside other data
    fetchTargets();

    // Fetch all data in parallel; intraday auto-selects the finest available interval
    const fetchList = [
        fetchSummary(),
        fetchPerformance('ALL'),  // Fetch all data for annual table
        fetchDividends(),
        fetchSoldAssets(),
        fetchIntradayAutoInterval(snapshotDate)   // returns {data, interval}
    ];

    // For 3D/1W the P&L chart is built from dailyPnl + intraday (fetched below).
    // For other periods fetch the regular performance data.
    const useIntradayForPnl = currentPeriod === '3D' || currentPeriod === '1W';
    if (!useIntradayForPnl) {
        fetchList.push(fetchPerformance(currentPeriod));
    } else {
        fetchList.push(Promise.resolve(null)); // placeholder to keep index alignment
    }

    // Add separate fetch for portfolio chart if period is different from ALL
    const needsSeparatePortfolioFetch = portfolioPeriod !== 'ALL';
    if (needsSeparatePortfolioFetch) {
        fetchList.push(fetchPerformance(portfolioPeriod));
    }

    // Fetch daily P&L list (EST midnight boundary for crypto)
    fetchList.push(fetchDailyPnl());

    // Kick off monthly P&L fetch in parallel (larger dataset, separate cache key)
    const monthlyPnlPromise = fetchMonthlyPnlData();

    const results = await Promise.all(fetchList);
    const [summary, allPerformance, dividends, sold, intradayResult, pnlData] = results;
    const portfolioPerformance = needsSeparatePortfolioFetch ? results[6] : allPerformance;
    const dailyPnlData = results[results.length - 1];

    // Unpack auto-detected intraday result
    const intraday = intradayResult?.data ?? null;
    const detectedInterval = intradayResult?.interval ?? '1m';

    if (summary) {
        updateSummaryCards(summary);
        updateHoldingsTable(summary.holdings);
        updateAllocationChart(summary.holdings, allocationView);
    }

    // Only update the chart if the user hasn't switched date mid-flight
    if (intraday && currentIntradayDate === snapshotDate) {
        currentInterval = detectedInterval;
        updateIntradayIntervalBadge(detectedInterval);
        updateIntradayChart(intraday, detectedInterval);
    }

    // Handle P&L chart - always delegate to loadPerformanceData for consistent behavior
    if (useIntradayForPnl) {
        loadPerformanceData(currentPeriod);
    } else if (pnlData) {
        updatePnlChart(pnlData);
    }

    // Update daily P&L list
    if (dailyPnlData) {
        updateDailyPnlList(dailyPnlData, intraday);
    }

    // Update monthly P&L list (awaits the parallel fetch started above)
    const monthlyPnlData = await monthlyPnlPromise;
    if (monthlyPnlData) {
        updateMonthlyPnlList(monthlyPnlData);
    }

    // Update Portfolio Value chart based on portfolioPeriod
    if (portfolioPerformance) {
        currentPerformanceData = portfolioPerformance;
        if (portfolioChartView === 'value') {
            updatePerformanceChart(portfolioPerformance);
        } else {
            updateInvestmentChart(null, portfolioPeriod);
        }
    }

    if (allPerformance) {
        updateAnnualTable(allPerformance);
    }

    if (sold) {
        updateSoldTable(sold);
    }

    if (dividends) {
        updateDividendsTable(dividends);
    }
}

// Auto-refresh functions
function startAutoRefresh(intervalSeconds) {
    stopAutoRefresh();

    autoRefreshInterval = intervalSeconds;
    document.getElementById('autoRefreshLabel').textContent = intervalSeconds === 0 ? 'Off' :
        intervalSeconds < 60 ? `${intervalSeconds}s` : `${intervalSeconds / 60}m`;

    if (intervalSeconds === 0) {
        document.getElementById('refreshCountdown').classList.add('d-none');
        return;
    }

    // Show countdown badge
    document.getElementById('refreshCountdown').classList.remove('d-none');
    countdownValue = intervalSeconds;
    updateCountdownDisplay();

    // Start countdown timer (updates every second)
    countdownTimer = setInterval(() => {
        countdownValue--;
        if (countdownValue <= 0) {
            countdownValue = intervalSeconds;
            // Trigger refresh
            refreshData();
        }
        updateCountdownDisplay();
    }, 1000);
}

function stopAutoRefresh() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

function updateCountdownDisplay() {
    const display = countdownValue < 60 ? `${countdownValue}s` : `${Math.floor(countdownValue / 60)}:${(countdownValue % 60).toString().padStart(2, '0')}`;
    document.getElementById('countdownValue').textContent = display;
}

async function refreshData() {
    // Clear cache and reload data
    apiCache.clear();
    Object.keys(transactionCache).forEach(k => delete transactionCache[k]);
    await loadAllData();
}

// Event handlers
document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise spin me-1"></i>Refreshing...';

    try {
        await reloadPortfolio();
        Object.keys(transactionCache).forEach(k => delete transactionCache[k]);
        await loadAllData();
        showToast('Data refreshed successfully', 'success');

        // Reset countdown if auto-refresh is on
        if (autoRefreshInterval > 0) {
            countdownValue = autoRefreshInterval;
            updateCountdownDisplay();
        }
    } catch (error) {
        showToast('Error refreshing data', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Refresh';
    }
});

document.getElementById('fileInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const result = await uploadFile(file);
        showToast(`Uploaded ${result.transactions_count} transactions`, 'success');
        await loadAllData();
    } catch (error) {
        showToast(error.message || 'Error uploading file', 'error');
    }

    // Reset file input
    event.target.value = '';
});

async function addTransaction(payload) {
    const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
        const msg = typeof data.detail === 'string'
            ? data.detail
            : (Array.isArray(data.detail) ? data.detail.map(d => d.msg).join('; ') : 'Failed to add transaction');
        throw new Error(msg);
    }
    apiCache.clear();
    return data;
}

// Add Transaction modal wiring
(function setupAddTxn() {
    const form = document.getElementById('addTxnForm');
    if (!form) return;
    const modalEl = document.getElementById('addTxnModal');
    const errBox = document.getElementById('addTxnError');
    const submitBtn = document.getElementById('addTxnSubmit');

    // Default the date to today whenever the modal opens
    modalEl.addEventListener('show.bs.modal', () => {
        errBox.classList.add('d-none');
        const dateInput = form.elements['date'];
        if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.classList.add('d-none');

        const fd = new FormData(form);
        const num = (v) => (v === '' || v == null) ? null : Number(v);
        const str = (v) => (v === '' || v == null) ? null : v;
        const payload = {
            date: fd.get('date'),
            asset: (fd.get('asset') || '').trim().toUpperCase(),
            action: fd.get('action'),
            quantity: num(fd.get('quantity')),
            ave_price: num(fd.get('ave_price')),
            amount: num(fd.get('amount')),
            source: str(fd.get('source')),
            broker: str(fd.get('broker')),
            comment: str(fd.get('comment')),
        };

        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding…';
        try {
            const result = await addTransaction(payload);
            bootstrap.Modal.getInstance(modalEl).hide();
            form.reset();
            showToast(result.message || 'Transaction added', 'success');
            await loadAllData();
        } catch (error) {
            errBox.textContent = error.message || 'Error adding transaction';
            errBox.classList.remove('d-none');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
        }
    });
})();

// Initial load and event handlers setup
document.addEventListener('DOMContentLoaded', () => {
    // Period button event handlers
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const period = btn.dataset.period;
            loadPerformanceData(period);
        });
    });


    // Date picker for intraday chart
    const datePicker = document.getElementById('intradayDatePicker');
    if (datePicker) {
        // Set max to today and default to today
        const todayStr = new Date().toISOString().slice(0, 10);
        datePicker.max = todayStr;
        datePicker.value = todayStr;

        datePicker.addEventListener('change', () => {
            const selectedDate = datePicker.value;
            const todayVal = new Date().toISOString().slice(0, 10);
            // null means today (uses the live endpoint without date param)
            const dateParam = selectedDate === todayVal ? null : selectedDate;
            // Always bypass frontend cache when user explicitly switches dates
            loadIntradayData(dateParam, false);
        });
    }

    // Holdings view mode toggle (All / Category)
    document.querySelectorAll('.holdings-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            holdingsViewMode = btn.dataset.view;
            document.querySelectorAll('.holdings-view-btn').forEach(b => {
                if (b.dataset.view === holdingsViewMode) {
                    b.classList.remove('btn-outline-secondary');
                    b.classList.add('btn-primary', 'active');
                } else {
                    b.classList.remove('btn-primary', 'active');
                    b.classList.add('btn-outline-secondary');
                }
            });
            renderHoldingsTable(holdingsData);
        });
    });

    // Holdings row expand/collapse transaction detail
    document.getElementById('holdingsBody').addEventListener('click', (e) => {
        // Handle target % inline editing
        const targetCell = e.target.closest('.target-pct-cell');
        if (targetCell && !targetCell.querySelector('input')) {
            e.stopPropagation();
            const symbol = targetCell.dataset.symbol;
            const currentVal = targetAllocations[symbol] || '';
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'target-pct-input';
            input.value = currentVal;
            input.min = '0';
            input.max = '100';
            input.step = '0.1';
            targetCell.textContent = '';
            targetCell.appendChild(input);
            input.focus();
            input.select();

            const commit = () => {
                const val = parseFloat(input.value);
                saveTarget(symbol, isNaN(val) || val <= 0 ? 0 : val);
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') input.blur();
                if (ev.key === 'Escape') {
                    input.removeEventListener('blur', commit);
                    renderHoldingsTable(holdingsData);
                }
            });
            return;
        }

        const holdingRow = e.target.closest('.holding-row');
        if (holdingRow) toggleTransactionDetail(holdingRow);
    });

    // Holdings table sort event handlers
    document.querySelectorAll('#holdingsTable th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.sort;
            if (holdingsSortColumn === column) {
                // Toggle direction if same column
                holdingsSortDirection = holdingsSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, default to descending for numbers, ascending for symbol
                holdingsSortColumn = column;
                holdingsSortDirection = column === 'symbol' ? 'asc' : 'desc';
            }
            renderHoldingsTable(holdingsData);
        });
    });

    // Sold table sort event handlers
    document.querySelectorAll('#soldTable th.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.sort;
            if (soldSortColumn === column) {
                // Toggle direction if same column
                soldSortDirection = soldSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                // New column, default to descending for numbers, ascending for symbol
                soldSortColumn = column;
                soldSortDirection = column === 'symbol' ? 'asc' : 'desc';
            }
            renderSoldTable();
        });
    });

    // Auto-refresh dropdown handlers
    document.querySelectorAll('.auto-refresh-option').forEach(option => {
        option.addEventListener('click', (e) => {
            e.preventDefault();
            const interval = parseInt(option.dataset.interval);
            startAutoRefresh(interval);

            // Update active state
            document.querySelectorAll('.auto-refresh-option').forEach(opt => {
                opt.classList.remove('active');
            });
            option.classList.add('active');
        });
    });

    // Anonymous mode button
    document.getElementById('anonymousBtn').addEventListener('click', toggleAnonymousMode);
    updateAnonymousButton();

    // Portfolio chart view buttons (Value / Investment)
    document.querySelectorAll('.portfolio-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            portfolioChartView = view;

            // Update button states
            document.querySelectorAll('.portfolio-view-btn').forEach(b => {
                if (b.dataset.view === view) {
                    b.classList.remove('btn-outline-secondary');
                    b.classList.add('btn-primary', 'active');
                } else {
                    b.classList.remove('btn-primary', 'active');
                    b.classList.add('btn-outline-secondary');
                }
            });

            // Update title
            const titleEl = document.getElementById('portfolioChartTitle');
            if (view === 'value') {
                titleEl.textContent = 'Portfolio Value';
            } else {
                titleEl.textContent = 'Monthly Investment';
            }

            // Show/hide appropriate chart
            const performanceContainer = document.getElementById('performanceChartContainer');
            const investmentContainer = document.getElementById('investmentChartContainer');

            if (view === 'value') {
                performanceContainer.style.display = 'block';
                investmentContainer.style.display = 'none';
                // Refresh value chart with current period
                fetchAndUpdatePortfolioChart(portfolioPeriod, 'value');
            } else {
                performanceContainer.style.display = 'none';
                investmentContainer.style.display = 'block';
                // Update investment chart with current period
                updateInvestmentChart(null, portfolioPeriod);
            }
        });
    });

    // Portfolio period buttons (global for both value and investment views)
    document.querySelectorAll('.portfolio-period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const period = btn.dataset.period;
            portfolioPeriod = period;

            // Update button states
            document.querySelectorAll('.portfolio-period-btn').forEach(b => {
                if (b.dataset.period === period) {
                    b.classList.remove('btn-outline-secondary');
                    b.classList.add('btn-primary', 'active');
                } else {
                    b.classList.remove('btn-primary', 'active');
                    b.classList.add('btn-outline-secondary');
                }
            });

            // Update the appropriate chart based on current view
            if (portfolioChartView === 'value') {
                fetchAndUpdatePortfolioChart(period, 'value');
            } else {
                updateInvestmentChart(null, period);
            }
        });
    });

    // Allocation view buttons
    document.querySelectorAll('.allocation-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            allocationView = view;
            selectedCategory = null;

            // Update button states
            document.querySelectorAll('.allocation-view-btn').forEach(b => {
                if (b.dataset.view === view) {
                    b.classList.remove('btn-outline-secondary');
                    b.classList.add('btn-primary', 'active');
                } else {
                    b.classList.remove('btn-primary', 'active');
                    b.classList.add('btn-outline-secondary');
                }
            });

            // Show/hide category tabs
            const categoryTabs = document.getElementById('categoryTabs');
            if (view === 'category') {
                categoryTabs.style.display = 'flex';
            } else {
                categoryTabs.style.display = 'none';
            }

            // Reset category tab states
            document.querySelectorAll('.category-tab-btn').forEach(b => {
                b.classList.remove('active');
                // Reset to outline style
                b.className = b.className.replace(/btn-(crypto|index|stocks)\b(?!-)/, 'btn-outline-$1');
            });

            // Re-render chart with new view
            updateAllocationChart(null, view);
        });
    });

    // Category tab buttons (drill-down)
    document.querySelectorAll('.category-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const category = btn.dataset.category;
            selectedCategory = category;

            // Update category tab button states
            document.querySelectorAll('.category-tab-btn').forEach(b => {
                if (b.dataset.category === category) {
                    b.classList.add('active');
                    // Change to solid style
                    b.className = b.className.replace(/btn-outline-(crypto|index|stocks)/, 'btn-$1');
                } else {
                    b.classList.remove('active');
                    // Change back to outline style
                    b.className = b.className.replace(/btn-(crypto|index|stocks)\b(?!-)/, 'btn-outline-$1');
                }
            });

            // Re-render chart with category drill-down
            updateAllocationChart(null, category);
        });
    });

    // Column visibility toggle for Holdings table
    const colDefs = [
        { col: 0, label: 'Symbol', locked: true },
        { col: 1, label: 'Quantity' },
        { col: 2, label: 'Avg Cost' },
        { col: 3, label: 'Invested' },
        { col: 4, label: 'Price' },
        { col: 5, label: 'Today' },
        { col: 17, label: 'YTD' },
        { col: 18, label: 'YTD %' },
        { col: 6, label: 'Market Value' },
        { col: 7, label: 'Alloc %' },
        { col: 8, label: 'Target %' },
        { col: 9, label: '\u0394 Target' },
        { col: 10, label: 'Unrealized P&L' },
        { col: 11, label: 'Unrealized %' },
        { col: 14, label: 'Realized P&L' },
        { col: 15, label: 'Total P&L' },
        { col: 16, label: 'Total %' },
        { col: 12, label: 'Annual %' },
        { col: 13, label: 'W-Annual %' },
    ];

    // Load saved prefs (default: all visible)
    let hiddenCols = JSON.parse(localStorage.getItem('holdingsHiddenCols') || '[]');

    function applyColumnVisibility() {
        const style = document.getElementById('col-visibility-style') || (() => {
            const s = document.createElement('style');
            s.id = 'col-visibility-style';
            document.head.appendChild(s);
            return s;
        })();
        const rules = hiddenCols.map(c =>
            `#holdingsTable th[data-col="${c}"], #holdingsTable td[data-col="${c}"] { display: none; }`
        ).join('\n');
        style.textContent = rules;
    }

    const menu = document.getElementById('colToggleMenu');
    colDefs.forEach(def => {
        const li = document.createElement('li');
        const label = document.createElement('label');
        label.className = 'dropdown-item d-flex align-items-center gap-2 mb-0';
        label.style.cursor = def.locked ? 'default' : 'pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'form-check-input mt-0';
        cb.checked = !hiddenCols.includes(def.col);
        cb.disabled = !!def.locked;
        cb.addEventListener('change', () => {
            if (cb.checked) {
                hiddenCols = hiddenCols.filter(c => c !== def.col);
            } else {
                hiddenCols.push(def.col);
            }
            localStorage.setItem('holdingsHiddenCols', JSON.stringify(hiddenCols));
            applyColumnVisibility();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(def.label));
        li.appendChild(label);
        menu.appendChild(li);
    });

    applyColumnVisibility();

    // Generic per-card collapse buttons (Investment P&L, Monthly Investment,
    // Asset Allocation, etc.). Wires up any <button class="card-collapse-btn"
    // data-collapse-target="..."> to toggle the matching element id.
    (function initCardCollapseButtons() {
        document.querySelectorAll('.card-collapse-btn').forEach(btn => {
            const targetId = btn.dataset.collapseTarget;
            if (!targetId) return;
            const target = document.getElementById(targetId);
            if (!target) return;
            const STORAGE_KEY = `cardCollapsed:${targetId}`;
            const collapsed = localStorage.getItem(STORAGE_KEY) === '1';

            function applyState(isCollapsed) {
                target.style.display = isCollapsed ? 'none' : '';
                btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.classList.toggle('bi-chevron-down', isCollapsed);
                    icon.classList.toggle('bi-chevron-up', !isCollapsed);
                }
            }
            applyState(collapsed);

            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const willCollapse = target.style.display !== 'none';
                applyState(willCollapse);
                localStorage.setItem(STORAGE_KEY, willCollapse ? '1' : '0');
                // Charts inside collapsed panels should resize when re-shown
                if (!willCollapse && window.Chart) {
                    setTimeout(() => {
                        target.querySelectorAll('canvas').forEach(c => {
                            const inst = Chart.getChart(c);
                            if (inst) inst.resize();
                        });
                    }, 0);
                }
            });
        });
    })();

    // Summary cards collapse: persist + restore state
    (function initSummaryCollapse() {
        const btn = document.getElementById('summaryToggleBtn');
        const panel = document.getElementById('summaryCardsCollapse');
        const icon = document.getElementById('summaryToggleIcon');
        const label = document.getElementById('summaryToggleLabel');
        if (!btn || !panel) return;
        const STORAGE_KEY = 'summaryCardsExpanded';
        const expanded = localStorage.getItem(STORAGE_KEY) === '1';

        function applyState(isOpen) {
            panel.classList.toggle('show', isOpen);
            btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if (icon) {
                icon.classList.toggle('bi-chevron-down', !isOpen);
                icon.classList.toggle('bi-chevron-up', isOpen);
            }
            if (label) label.textContent = isOpen ? 'Hide summary' : 'Show summary';
        }
        applyState(expanded);

        btn.addEventListener('click', () => {
            const nowOpen = !panel.classList.contains('show');
            applyState(nowOpen);
            localStorage.setItem(STORAGE_KEY, nowOpen ? '1' : '0');
        });
    })();

    // Load data
    loadAllData();

    // Auto-start 1-minute refresh
    startAutoRefresh(60);
    // Mark the 1 minute option as active
    document.querySelectorAll('.auto-refresh-option').forEach(opt => {
        opt.classList.remove('active');
        if (opt.dataset.interval === '60') {
            opt.classList.add('active');
        }
    });

    // -----------------------------------------------------------------------
    // Simulator event listeners
    // -----------------------------------------------------------------------
    initSimulator();
});


// ============================================================================
//  PORTFOLIO SIMULATOR
// ============================================================================

let simPerfChart = null;
let simDriftChart = null;
let simIntervalDays = 7;

const SIM_COLORS = [
    '#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6',
    '#0891b2', '#65a30d', '#ea580c', '#db2777', '#0284c7',
];

function initSimulator() {
    // Set default dates: 5 years ago → today
    const today = new Date();
    const fiveYearsAgo = new Date(today);
    fiveYearsAgo.setFullYear(today.getFullYear() - 5);

    const fmt = d => d.toISOString().slice(0, 10);
    document.getElementById('simStartDate').value = fmt(fiveYearsAgo);
    document.getElementById('simEndDate').value   = fmt(today);

    // Seed default allocation
    simClearRows();
    simAddRow('VOO',  60);
    simAddRow('QQQM', 40);
    simUpdateWeightBadge();

    // Preset buttons
    document.querySelectorAll('.sim-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => simApplyPreset(btn.dataset.preset));
    });

    // Add row
    document.getElementById('simAddRowBtn').addEventListener('click', () => {
        simAddRow('', '');
    });

    // Interval buttons
    document.querySelectorAll('.sim-interval-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sim-interval-btn').forEach(b => {
                b.classList.remove('btn-primary', 'active');
                b.classList.add('btn-outline-secondary');
            });
            btn.classList.remove('btn-outline-secondary');
            btn.classList.add('btn-primary', 'active');
            simIntervalDays = parseInt(btn.dataset.days, 10);
        });
    });

    // DCA summary label
    const dcaFreq = document.getElementById('simDcaFreq');
    const dcaAmt  = document.getElementById('simDcaAmount');
    const updateDcaSummary = () => {
        const freq = dcaFreq.value;
        const amt  = parseFloat(dcaAmt.value) || 0;
        const el = document.getElementById('simDcaSummary');
        if (freq === 'none' || amt <= 0) {
            el.textContent = 'No recurring contributions.';
            el.className = 'small text-muted mt-1';
        } else {
            const labels = { weekly: 'every week', biweekly: 'every 2 weeks', monthly: 'every month' };
            el.textContent = `Invests $${amt.toLocaleString('en-US')} ${labels[freq]}`;
            el.className = 'small text-primary fw-semibold mt-1';
        }
    };
    dcaFreq.addEventListener('change', updateDcaSummary);
    dcaAmt.addEventListener('input', updateDcaSummary);
    updateDcaSummary();

    // Run button
    document.getElementById('simRunBtn').addEventListener('click', runSimulation);

    // Page toggle
    document.getElementById('pageTrackerBtn').addEventListener('click', () => switchPage('tracker'));
    document.getElementById('pageSimulatorBtn').addEventListener('click', () => switchPage('simulator'));
}

function switchPage(page) {
    const trackerPage   = document.getElementById('trackerPage');
    const simulatorPage = document.getElementById('simulatorPage');
    const trackerBtn    = document.getElementById('pageTrackerBtn');
    const simulatorBtn  = document.getElementById('pageSimulatorBtn');

    if (page === 'tracker') {
        trackerPage.style.display   = '';
        simulatorPage.style.display = 'none';
        trackerBtn.className    = 'btn btn-light btn-sm px-3';
        simulatorBtn.className  = 'btn btn-outline-light btn-sm px-3';
    } else {
        trackerPage.style.display   = 'none';
        simulatorPage.style.display = '';
        trackerBtn.className    = 'btn btn-outline-light btn-sm px-3';
        simulatorBtn.className  = 'btn btn-light btn-sm px-3';
    }
}

// ---- Allocation row helpers ------------------------------------------------

function simClearRows() {
    document.getElementById('simAllocRows').innerHTML = '';
}

function simAddRow(symbol = '', weight = '') {
    const container = document.getElementById('simAllocRows');
    const div = document.createElement('div');
    div.className = 'sim-alloc-row';
    div.innerHTML = `
        <input type="text" class="form-control sim-alloc-symbol" placeholder="TICKER"
               value="${symbol}" maxlength="12">
        <input type="number" class="form-control sim-alloc-weight" placeholder="%" min="0"
               max="100" step="1" value="${weight}">
        <button class="sim-alloc-remove" title="Remove"><i class="bi bi-x-lg"></i></button>`;

    div.querySelector('.sim-alloc-symbol').addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase();
    });
    div.querySelector('.sim-alloc-weight').addEventListener('input', simUpdateWeightBadge);
    div.querySelector('.sim-alloc-remove').addEventListener('click', () => {
        div.remove();
        simUpdateWeightBadge();
    });

    container.appendChild(div);
    simUpdateWeightBadge();
}

function simGetAllocations() {
    const rows = document.querySelectorAll('.sim-alloc-row');
    const result = [];
    rows.forEach(row => {
        const sym = row.querySelector('.sim-alloc-symbol').value.trim().toUpperCase();
        const wt  = parseFloat(row.querySelector('.sim-alloc-weight').value) || 0;
        if (sym && wt > 0) result.push({ symbol: sym, weight: wt });
    });
    return result;
}

function simUpdateWeightBadge() {
    const allocs = simGetAllocations();
    const total  = allocs.reduce((s, a) => s + a.weight, 0);
    const badge  = document.getElementById('simWeightSum');
    badge.textContent = total.toFixed(0) + ' %';
    badge.classList.remove('ok', 'warn', 'bg-secondary');
    if (Math.abs(total - 100) < 0.5) {
        badge.classList.add('ok');
    } else if (total > 0) {
        badge.classList.add('warn');
    } else {
        badge.classList.add('bg-secondary');
    }
}

function simApplyPreset(preset) {
    simClearRows();
    if (preset === '6040') {
        simAddRow('VOO', 60);
        simAddRow('TLT', 40);
    } else if (preset === 'allindex') {
        simAddRow('VOO',  50);
        simAddRow('QQQM', 50);
    } else if (preset === 'techgrowth') {
        simAddRow('QQQM', 60);
        simAddRow('SOXX', 40);
    } else if (preset === 'current') {
        // Pull from live holdings
        if (holdingsData && holdingsData.length > 0) {
            const investments = holdingsData.filter(h => h.symbol !== 'CASH' && h.market_value > 0);
            const totalMv     = investments.reduce((s, h) => s + (h.market_value || 0), 0);
            if (totalMv > 0) {
                investments.forEach(h => {
                    const pct = (h.market_value / totalMv * 100).toFixed(1);
                    simAddRow(h.symbol, pct);
                });
            } else {
                showToast('No holdings data yet — load the Tracker first.', 'warning');
                simAddRow('VOO', 60);
                simAddRow('QQQM', 40);
            }
        } else {
            showToast('No holdings data yet — load the Tracker first.', 'warning');
            simAddRow('VOO', 60);
            simAddRow('QQQM', 40);
        }
    }
    simUpdateWeightBadge();
}

// ---- Run -------------------------------------------------------------------

async function runSimulation() {
    const errEl  = document.getElementById('simRunError');
    const runBtn = document.getElementById('simRunBtn');
    errEl.classList.add('d-none');

    const allocs     = simGetAllocations();
    const startDate  = document.getElementById('simStartDate').value;
    const endDate    = document.getElementById('simEndDate').value;
    const capital    = parseFloat(document.getElementById('simCapital').value) || 0;
    const rebalance  = document.getElementById('simRebalance').value;
    const benchmark  = document.getElementById('simBenchmark').value.trim().toUpperCase() || null;
    const dcaFreq    = document.getElementById('simDcaFreq').value;
    const dcaAmount  = parseFloat(document.getElementById('simDcaAmount').value) || 0;

    if (allocs.length === 0) {
        errEl.textContent = 'Add at least one asset with a positive weight.';
        errEl.classList.remove('d-none');
        return;
    }
    if (!startDate || !endDate || startDate >= endDate) {
        errEl.textContent = 'Invalid date range.';
        errEl.classList.remove('d-none');
        return;
    }
    if (capital <= 0 && (dcaFreq === 'none' || dcaAmount <= 0)) {
        errEl.textContent = 'Set an initial lump sum, DCA contribution, or both.';
        errEl.classList.remove('d-none');
        return;
    }

    // Loading state
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Running…';

    try {
        const body = {
            allocations:         allocs,
            start_date:          startDate,
            end_date:            endDate,
            initial_capital:     capital,
            rebalance_frequency: rebalance,
            data_interval_days:  simIntervalDays,
            benchmark:           benchmark || '',
            dca_frequency:       dcaFreq,
            dca_amount:          dcaAmount,
        };
        const resp = await fetch('/api/simulator/run', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || 'Server error');
        }
        const data = await resp.json();
        renderSimResults(data);
    } catch (e) {
        errEl.textContent = 'Error: ' + e.message;
        errEl.classList.remove('d-none');
    } finally {
        runBtn.disabled = false;
        runBtn.innerHTML = '<i class="bi bi-play-fill me-2"></i>Run Simulation';
    }
}

// ---- Render results --------------------------------------------------------

function renderSimResults(data) {
    document.getElementById('simPlaceholder').style.display = 'none';
    document.getElementById('simResults').style.display     = '';

    const { data_points, metrics, benchmark_data, benchmark_metrics, config } = data;

    renderSimMetricCards(metrics, benchmark_metrics, config);
    renderSimPerfChart(data_points, benchmark_data, benchmark_metrics);
    renderSimDriftChart(data_points, config.allocations.map(a => a.symbol));
    renderSimComparisonTable(metrics, benchmark_metrics, config);

    // Benchmark badge
    const badge = document.getElementById('simBenchmarkBadge');
    if (benchmark_metrics) {
        badge.textContent = 'vs ' + benchmark_metrics.symbol;
        badge.classList.remove('d-none');
    } else {
        badge.classList.add('d-none');
    }
}

// ---- Metric cards ----------------------------------------------------------

function renderSimMetricCards(metrics, benchMetrics, config) {
    const fmt$ = v => '$' + (v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const fmtPct = v => (v >= 0 ? '+' : '') + (v || 0).toFixed(2) + '%';
    const colClass = v => v >= 0 ? 'text-success' : 'text-danger';

    const isDca = config && config.dca_frequency && config.dca_frequency !== 'none' && config.dca_amount > 0;
    const cagrLabel = isDca ? 'Money-Wtd CAGR' : 'CAGR';

    const cards = [
        {
            icon:  'bi-wallet2',
            label: 'Final Value',
            value: fmt$(metrics.final_value),
            cls:   '',
            bench: benchMetrics ? fmt$(benchMetrics.final_value) : null,
        },
        {
            icon:  'bi-cash-stack',
            label: 'Total Invested',
            value: fmt$(metrics.total_invested),
            cls:   '',
            bench: null,
            sub:   isDca
                ? `${config.dca_count} × $${config.dca_amount.toLocaleString('en-US')} (${config.dca_frequency})`
                : 'lump sum',
        },
        {
            icon:  'bi-graph-up-arrow',
            label: 'Total Return',
            value: fmtPct(metrics.total_return),
            cls:   colClass(metrics.total_return),
            bench: benchMetrics ? fmtPct(benchMetrics.total_return) : null,
            bCls:  benchMetrics ? colClass(benchMetrics.total_return) : '',
        },
        {
            icon:  'bi-speedometer2',
            label: cagrLabel,
            value: fmtPct(metrics.cagr),
            cls:   colClass(metrics.cagr),
            bench: benchMetrics ? fmtPct(benchMetrics.cagr) : null,
            bCls:  benchMetrics ? colClass(benchMetrics.cagr) : '',
        },
        {
            icon:  'bi-arrow-down-circle',
            label: 'Max Drawdown',
            value: '-' + (metrics.max_drawdown || 0).toFixed(2) + '%',
            cls:   'text-danger',
            bench: benchMetrics ? '-' + (benchMetrics.max_drawdown || 0).toFixed(2) + '%' : null,
            bCls:  'text-danger',
        },
        {
            icon:  'bi-award',
            label: 'Sharpe Ratio',
            value: (metrics.sharpe_ratio || 0).toFixed(2),
            cls:   colClass(metrics.sharpe_ratio),
            bench: benchMetrics ? (benchMetrics.sharpe_ratio || 0).toFixed(2) : null,
            bCls:  benchMetrics ? colClass(benchMetrics.sharpe_ratio) : '',
        },
    ];

    const container = document.getElementById('simMetricCards');
    container.innerHTML = cards.map(c => `
        <div class="col-6 col-md-4 col-lg-4">
            <div class="card border-0 shadow-sm sim-metric-card h-100">
                <div class="card-body text-center py-3">
                    <div class="metric-label"><i class="bi ${c.icon} me-1"></i>${c.label}</div>
                    <div class="metric-value ${c.cls}">${c.value}</div>
                    ${c.sub
                        ? `<div class="metric-bench">${c.sub}</div>`
                        : (c.bench !== null
                            ? `<div class="metric-bench ${c.bCls || ''}">bench: ${c.bench}</div>`
                            : '')}
                </div>
            </div>
        </div>`).join('');
}

// ---- Performance line chart ------------------------------------------------

function renderSimPerfChart(dataPoints, benchData, benchMetrics) {
    const labels = dataPoints.map(d => d.date);
    const portVals = dataPoints.map(d => d.value);

    const datasets = [
        {
            label: 'Portfolio',
            data:  portVals,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.08)',
            borderWidth: 2,
            fill: true,
            pointRadius: 0,
            tension: 0.1,
        },
        {
            // Step-style "invested-to-date" line — shows the cost basis growing
            // each DCA period
            label: 'Total Invested',
            data:  dataPoints.map(d => d.invested),
            borderColor: 'rgba(107,114,128,0.7)',
            backgroundColor: 'transparent',
            borderWidth: 1.2,
            borderDash: [3, 3],
            fill: false,
            pointRadius: 0,
            stepped: 'before',
        },
    ];

    // Rebalance markers
    const rebalancePoints = dataPoints
        .filter(d => d.rebalanced)
        .map(d => ({ x: d.date, y: d.value }));

    if (rebalancePoints.length > 0) {
        datasets.push({
            label: 'Rebalance',
            data:  rebalancePoints,
            type:  'scatter',
            pointRadius: 4,
            pointStyle: 'triangle',
            backgroundColor: 'rgba(245,158,11,0.8)',
            borderColor: '#f59e0b',
            borderWidth: 1,
            showLine: false,
        });
    }

    if (benchData && benchData.length > 0) {
        datasets.push({
            label: benchMetrics ? benchMetrics.symbol + ' (DCA)' : 'Benchmark',
            data:  benchData.map(d => d.value),
            borderColor: '#16a34a',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 3],
            fill: false,
            pointRadius: 0,
            tension: 0.1,
        });
    }

    if (simPerfChart) simPerfChart.destroy();
    const ctx = document.getElementById('simPerfChart').getContext('2d');
    simPerfChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.dataset.type === 'scatter') return ' Rebalanced';
                            const v = ctx.parsed.y;
                            return ` ${ctx.dataset.label}: $${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', tooltipFormat: 'MMM d, yyyy' },
                    grid: { display: false },
                    ticks: { maxTicksLimit: 8, font: { size: 11 } },
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: {
                        font: { size: 11 },
                        callback: v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
                    },
                },
            },
        },
    });
}

// ---- Allocation drift stacked area chart -----------------------------------

function renderSimDriftChart(dataPoints, symbols) {
    const labels = dataPoints.map(d => d.date);

    const datasets = symbols.map((sym, i) => ({
        label: sym,
        data:  dataPoints.map(d => d.allocations[sym] ?? 0),
        backgroundColor: SIM_COLORS[i % SIM_COLORS.length] + '99',
        borderColor:     SIM_COLORS[i % SIM_COLORS.length],
        borderWidth: 1,
        fill: true,
        pointRadius: 0,
        tension: 0.1,
    }));

    // Target lines (dashed) for each symbol
    // We can infer target from initial allocation
    const initAlloc = dataPoints[0]?.allocations || {};
    symbols.forEach((sym, i) => {
        const target = initAlloc[sym];
        if (target !== undefined) {
            datasets.push({
                label: sym + ' target',
                data:  labels.map(() => target),
                borderColor: SIM_COLORS[i % SIM_COLORS.length],
                borderWidth: 1,
                borderDash: [4, 3],
                backgroundColor: 'transparent',
                fill: false,
                pointRadius: 0,
                tension: 0,
            });
        }
    });

    if (simDriftChart) simDriftChart.destroy();
    const ctx = document.getElementById('simDriftChart').getContext('2d');
    simDriftChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        boxWidth: 12,
                        font: { size: 11 },
                        filter: item => !item.text.includes(' target'),
                    },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.dataset.label.includes(' target')) return null;
                            return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'month', tooltipFormat: 'MMM d, yyyy' },
                    grid: { display: false },
                    ticks: { maxTicksLimit: 8, font: { size: 11 } },
                },
                y: {
                    stacked: true,
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: {
                        font: { size: 11 },
                        callback: v => v + '%',
                    },
                },
            },
        },
    });
}

// ---- Comparison table -------------------------------------------------------

function renderSimComparisonTable(metrics, benchMetrics, config) {
    const bench = benchMetrics;
    const isDca = config && config.dca_frequency && config.dca_frequency !== 'none' && config.dca_amount > 0;
    const cagrLabel = isDca ? 'CAGR (XIRR)' : 'CAGR';

    // Update headers
    const portHdr  = document.getElementById('simCmpPortHeader');
    const benchHdr = document.getElementById('simCmpBenchHeader');
    portHdr.textContent  = 'Your Portfolio';
    benchHdr.textContent = bench ? bench.symbol + ' (DCA)' : '—';

    const fmt$ = v => '$' + (v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

    const rows = [
        {
            label: 'Total Invested',
            port:  fmt$(metrics.total_invested),
            bench: bench ? fmt$(bench.total_invested) : '—',
            portCls: '', benchCls: '',
        },
        {
            label: 'Final Value',
            port:  fmt$(metrics.final_value),
            bench: bench ? fmt$(bench.final_value) : '—',
            portCls:  metrics.final_value > metrics.total_invested ? 'text-success' : 'text-danger',
            benchCls: bench ? (bench.final_value > bench.total_invested ? 'text-success' : 'text-danger') : '',
        },
        {
            label: 'Net Profit',
            port:  fmt$(metrics.final_value - metrics.total_invested),
            bench: bench ? fmt$(bench.final_value - bench.total_invested) : '—',
            portCls:  metrics.final_value > metrics.total_invested ? 'text-success' : 'text-danger',
            benchCls: bench ? (bench.final_value > bench.total_invested ? 'text-success' : 'text-danger') : '',
        },
        {
            label: 'Total Return',
            port:  (metrics.total_return >= 0 ? '+' : '') + (metrics.total_return || 0).toFixed(2) + '%',
            bench: bench ? (bench.total_return >= 0 ? '+' : '') + (bench.total_return || 0).toFixed(2) + '%' : '—',
            portCls:  metrics.total_return >= 0 ? 'text-success' : 'text-danger',
            benchCls: bench ? (bench.total_return >= 0 ? 'text-success' : 'text-danger') : '',
        },
        {
            label: cagrLabel,
            port:  (metrics.cagr >= 0 ? '+' : '') + (metrics.cagr || 0).toFixed(2) + '%',
            bench: bench ? (bench.cagr >= 0 ? '+' : '') + (bench.cagr || 0).toFixed(2) + '%' : '—',
            portCls:  metrics.cagr >= 0 ? 'text-success' : 'text-danger',
            benchCls: bench ? (bench.cagr >= 0 ? 'text-success' : 'text-danger') : '',
        },
        {
            label: 'Max Drawdown',
            port:  '-' + (metrics.max_drawdown || 0).toFixed(2) + '%',
            bench: bench ? '-' + (bench.max_drawdown || 0).toFixed(2) + '%' : '—',
            portCls: 'text-danger', benchCls: 'text-danger',
        },
        {
            label: 'Ann. Volatility',
            port:  (metrics.annualised_volatility || 0).toFixed(2) + '%',
            bench: bench ? (bench.annualised_volatility || 0).toFixed(2) + '%' : '—',
            portCls: '', benchCls: '',
        },
        {
            label: 'Sharpe Ratio',
            port:  (metrics.sharpe_ratio || 0).toFixed(2),
            bench: bench ? (bench.sharpe_ratio || 0).toFixed(2) : '—',
            portCls:  metrics.sharpe_ratio >= 1 ? 'text-success' : (metrics.sharpe_ratio < 0 ? 'text-danger' : ''),
            benchCls: bench
                ? (bench.sharpe_ratio >= 1 ? 'text-success' : (bench.sharpe_ratio < 0 ? 'text-danger' : ''))
                : '',
        },
    ];

    document.getElementById('simComparisonBody').innerHTML = rows.map(r => `
        <tr>
            <td>${r.label}</td>
            <td class="fw-semibold ${r.portCls}">${r.port}</td>
            <td class="${r.benchCls}">${r.bench}</td>
        </tr>`).join('');
}
