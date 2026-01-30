// Portfolio Tracker Frontend Application

// Chart instances
let performanceChart = null;
let allocationChart = null;
let pnlChart = null;
let intradayChart = null;

// Current intraday interval
let currentInterval = '5m';

// Anonymous mode
let anonymousMode = localStorage.getItem('anonymousMode') === 'true';

// Allocation view mode
let allocationView = 'assets'; // 'assets' or 'sectors'
let currentHoldingsForAllocation = null;

// Sector mapping for common stocks/ETFs
const symbolToSector = {
    // Technology
    'AAPL': 'Technology',
    'MSFT': 'Technology',
    'GOOGL': 'Technology',
    'GOOG': 'Technology',
    'META': 'Technology',
    'NVDA': 'Technology',
    'AMD': 'Technology',
    'INTC': 'Technology',
    'AVGO': 'Technology',
    'QCOM': 'Technology',
    'TXN': 'Technology',
    'CSCO': 'Technology',
    'ORCL': 'Technology',
    'IBM': 'Technology',
    'ADBE': 'Technology',
    'CRM': 'Technology',
    'NOW': 'Technology',
    'PLTR': 'Technology',
    'SNOW': 'Technology',
    'NET': 'Technology',
    'CRWD': 'Technology',
    'ZS': 'Technology',
    'DDOG': 'Technology',
    'MDB': 'Technology',

    // Consumer Discretionary
    'AMZN': 'Consumer',
    'TSLA': 'Consumer',
    'HD': 'Consumer',
    'NKE': 'Consumer',
    'MCD': 'Consumer',
    'SBUX': 'Consumer',
    'LOW': 'Consumer',
    'TGT': 'Consumer',
    'BKNG': 'Consumer',
    'ABNB': 'Consumer',
    'UBER': 'Consumer',
    'LYFT': 'Consumer',
    'DIS': 'Consumer',
    'NFLX': 'Consumer',
    'ROKU': 'Consumer',
    'SPOT': 'Consumer',

    // Consumer Staples
    'WMT': 'Consumer Staples',
    'COST': 'Consumer Staples',
    'PG': 'Consumer Staples',
    'KO': 'Consumer Staples',
    'PEP': 'Consumer Staples',
    'PM': 'Consumer Staples',
    'MO': 'Consumer Staples',

    // Healthcare
    'JNJ': 'Healthcare',
    'UNH': 'Healthcare',
    'PFE': 'Healthcare',
    'MRK': 'Healthcare',
    'ABBV': 'Healthcare',
    'LLY': 'Healthcare',
    'TMO': 'Healthcare',
    'ABT': 'Healthcare',
    'CVS': 'Healthcare',
    'WBA': 'Healthcare',

    // Financials
    'JPM': 'Financials',
    'BAC': 'Financials',
    'WFC': 'Financials',
    'C': 'Financials',
    'GS': 'Financials',
    'MS': 'Financials',
    'BLK': 'Financials',
    'SCHW': 'Financials',
    'V': 'Financials',
    'MA': 'Financials',
    'AXP': 'Financials',
    'PYPL': 'Financials',
    'SQ': 'Financials',
    'COIN': 'Financials',
    'HOOD': 'Financials',

    // Energy
    'XOM': 'Energy',
    'CVX': 'Energy',
    'COP': 'Energy',
    'SLB': 'Energy',
    'EOG': 'Energy',

    // Industrials
    'BA': 'Industrials',
    'CAT': 'Industrials',
    'DE': 'Industrials',
    'GE': 'Industrials',
    'HON': 'Industrials',
    'MMM': 'Industrials',
    'UPS': 'Industrials',
    'FDX': 'Industrials',
    'LMT': 'Industrials',
    'RTX': 'Industrials',

    // Communication Services
    'T': 'Communication',
    'VZ': 'Communication',
    'TMUS': 'Communication',
    'CMCSA': 'Communication',

    // Real Estate
    'AMT': 'Real Estate',
    'PLD': 'Real Estate',
    'CCI': 'Real Estate',
    'EQIX': 'Real Estate',
    'O': 'Real Estate',

    // Materials
    'LIN': 'Materials',
    'APD': 'Materials',
    'FCX': 'Materials',
    'NEM': 'Materials',

    // Utilities
    'NEE': 'Utilities',
    'DUK': 'Utilities',
    'SO': 'Utilities',

    // Automotive
    'F': 'Automotive',
    'GM': 'Automotive',
    'RIVN': 'Automotive',
    'LCID': 'Automotive',

    // ETFs - Index
    'SPY': 'Index ETF',
    'VOO': 'Index ETF',
    'VTI': 'Index ETF',
    'QQQ': 'Index ETF',
    'QQQM': 'Index ETF',
    'IWM': 'Index ETF',
    'DIA': 'Index ETF',

    // ETFs - Sector
    'VGT': 'Tech ETF',
    'XLK': 'Tech ETF',
    'XLF': 'Financial ETF',
    'XLE': 'Energy ETF',
    'XLV': 'Healthcare ETF',
    'ARKK': 'Innovation ETF',
    'ARKW': 'Innovation ETF',

    // ETFs - Bonds
    'TLT': 'Bonds',
    'BND': 'Bonds',
    'AGG': 'Bonds',
    'LQD': 'Bonds',
    'HYG': 'Bonds',
    'TIP': 'Bonds',

    // ETFs - Commodities
    'GLD': 'Commodities',
    'SLV': 'Commodities',
    'USO': 'Commodities',

    // ETFs - Dividend
    'SCHD': 'Dividend ETF',
    'VYM': 'Dividend ETF',
    'JEPI': 'Dividend ETF',
    'DVY': 'Dividend ETF',

    // ETFs - Real Estate
    'VNQ': 'Real Estate ETF',
    'IYR': 'Real Estate ETF',

    // Crypto
    'BTC-USD': 'Crypto',
    'ETH-USD': 'Crypto',
    'SOL-USD': 'Crypto',
    'DOGE-USD': 'Crypto',
    'ADA-USD': 'Crypto',
    'XRP-USD': 'Crypto',
    'DOT-USD': 'Crypto',
    'AVAX-USD': 'Crypto',
    'MATIC-USD': 'Crypto',
    'LINK-USD': 'Crypto',
    'UNI-USD': 'Crypto',
    'ATOM-USD': 'Crypto',
    'LTC-USD': 'Crypto',

    // Crypto-related stocks
    'MSTR': 'Crypto',
    'RIOT': 'Crypto',
    'MARA': 'Crypto',
    'CLSK': 'Crypto',

    // Cash
    'CASH': 'Cash',
};

function getSector(symbol) {
    return symbolToSector[symbol] || 'Other';
}

// Current selected period
let currentPeriod = '1Y';

// Holdings data and sort state
let holdingsData = [];
let holdingsSortColumn = 'market_value';
let holdingsSortDirection = 'desc';

// Sold assets data and sort state
let soldData = null;
let soldSortColumn = 'pnl';
let soldSortDirection = 'desc';

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
        case '5Y':
            startDate.setFullYear(today.getFullYear() - 5);
            break;
        case 'ALL':
            return { start_date: null, end_date: null };
        default:
            startDate.setFullYear(today.getFullYear() - 1);
    }

    const formatDate = (d) => d.toISOString().split('T')[0];
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

async function fetchIntraday(interval = '5m', useCache = true) {
    const cacheKey = `intraday_${interval}`;
    if (useCache) {
        const cached = apiCache.get(cacheKey);
        if (cached) return cached;
    }

    try {
        const response = await fetch(`/api/intraday?interval=${interval}`);
        if (!response.ok) throw new Error('Failed to fetch intraday data');
        const data = await response.json();
        apiCache.set(cacheKey, data);
        return data;
    } catch (error) {
        console.error('Error fetching intraday data:', error);
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

    const returnElement = document.getElementById('totalReturn');
    returnElement.textContent = formatPercent(summary.total_pnl_percent);
    returnElement.className = `card-text fs-4 fw-bold mb-0 has-tooltip ${summary.total_pnl_percent >= 0 ? 'text-success' : 'text-danger'}`;
    const returnTooltip = `Total Return = (Realized + Unrealized + Dividends) / All-Time Cost\nRealized P&L: ${formatCurrency(summary.total_realized_pnl)}\nUnrealized P&L: ${formatCurrency(summary.total_unrealized_pnl)}\nDividends: ${formatCurrency(summary.total_dividends)}\nTotal P&L: ${formatCurrency(summary.total_pnl)}\nAll-Time Cost: ${formatCurrency(summary.all_time_cost_basis)}\n= ${formatPercent(summary.total_pnl_percent)}`;
    returnElement.dataset.tooltip = returnTooltip;

    document.getElementById('totalDividends').textContent = formatCurrency(summary.total_dividends);
}

function sortHoldings(holdings, column, direction) {
    return [...holdings].sort((a, b) => {
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

function updateSortIndicators() {
    document.querySelectorAll('#holdingsTable th.sortable').forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === holdingsSortColumn) {
            th.classList.add(holdingsSortDirection);
        }
    });
}

function renderHoldingsTable(holdings) {
    const tbody = document.getElementById('holdingsBody');

    if (!holdings || holdings.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="empty-state">
                    <p>No holdings found</p>
                    <p>Upload a CSV file to get started</p>
                </td>
            </tr>
        `;
        return;
    }

    // Sort holdings
    const sortedHoldings = sortHoldings(holdings, holdingsSortColumn, holdingsSortDirection);

    tbody.innerHTML = sortedHoldings.map(h => {
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
        return `
        <tr>
            <td>${getAssetIconHtml(h.symbol)}<strong>${h.symbol}</strong></td>
            <td>${anonymousMode ? '***' : formatNumber(h.quantity, 4)}</td>
            <td>${formatCurrency(h.avg_cost)}</td>
            <td>${formatCurrency(h.cost_basis)}</td>
            <td>${formatCurrencyAlways(h.current_price)} ${dailyChangePctHtml}</td>
            <td class="${dailyChangeAmtClass}">${dailyChangeAmtText}</td>
            <td>${formatCurrency(h.market_value)}</td>
            <td class="${h.unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(h.unrealized_pnl)}</td>
            <td class="${h.pnl_percent >= 0 ? 'text-success' : 'text-danger'}">${formatPercent(h.pnl_percent)}</td>
        </tr>
    `}).join('');

    updateSortIndicators();
}

function updateHoldingsTable(holdings) {
    // Store holdings data for re-sorting
    holdingsData = holdings || [];
    renderHoldingsTable(holdingsData);
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
            <td>${getAssetIconHtml(s.symbol)}<strong>${s.symbol}</strong></td>
            <td>${formatNumber(s.quantity, 4)}</td>
            <td>${formatCurrency(s.avg_cost)}</td>
            <td>${formatCurrency(s.cost_basis)}</td>
            <td>${formatCurrency(s.avg_sell_price)}</td>
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

function updatePerformanceChart(performance) {
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

    // Determine if overall P&L is positive or negative for coloring
    const lastPnl = pnlData[pnlData.length - 1];
    const lineColor = lastPnl >= 0 ? '#10b981' : '#ef4444';
    const bgColor = lastPnl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';

    pnlChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{
                label: 'P&L',
                data: pnlData,
                costBasisData: costBasisData,
                borderColor: lineColor,
                backgroundColor: bgColor,
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
                tooltip: {
                    callbacks: {
                        title: (context) => context[0].label,
                        label: (context) => {
                            const pnl = context.raw;
                            const dataIndex = context.dataIndex;
                            const costBasis = context.dataset.costBasisData[dataIndex];
                            const pnlPercent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
                            const sign = pnl >= 0 ? '+' : '';
                            return [
                                `P&L: ${sign}${formatCurrency(pnl)}`,
                                `P&L %: ${sign}${pnlPercent.toFixed(2)}%`
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
                        callback: (value) => {
                            const sign = value >= 0 ? '+' : '';
                            return sign + formatCurrency(value);
                        }
                    }
                }
            }
        }
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

        // Find indices for market open (09:30) and close (16:00)
        const openIndex = labels.findIndex(l => l === '09:30');
        const closeIndex = labels.findIndex(l => l === '16:00');

        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#9ca3af';
        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#6b7280';

        // Draw market open line
        if (openIndex !== -1) {
            const x = xAxis.getPixelForValue(openIndex);
            ctx.beginPath();
            ctx.moveTo(x, yAxis.top);
            ctx.lineTo(x, yAxis.bottom);
            ctx.stroke();
            ctx.fillText('Open', x + 4, yAxis.top + 12);
        }

        // Draw market close line
        if (closeIndex !== -1) {
            const x = xAxis.getPixelForValue(closeIndex);
            ctx.beginPath();
            ctx.moveTo(x, yAxis.top);
            ctx.lineTo(x, yAxis.bottom);
            ctx.stroke();
            ctx.fillText('Close', x + 4, yAxis.top + 12);
        }

        ctx.restore();

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
                ctx.textAlign = 'left';
                ctx.fillText(pnlText, x + 10, y - 5);

                // Only show percentage if not in anonymous mode
                if (!anonymousMode) {
                    const pnlPercent = dataset.pnlPercentData[lastIndex];
                    const percentText = `(${sign}${pnlPercent.toFixed(2)}%)`;
                    ctx.font = '11px sans-serif';
                    ctx.fillText(percentText, x + 10, y + 10);
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
    }

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

    // Determine if current P&L is positive or negative for coloring
    const lineColor = lastPnl >= 0 ? '#10b981' : '#ef4444';
    const bgColor = lastPnl >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';

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
                borderColor: lineColor,
                backgroundColor: bgColor,
                fill: true,
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
                tooltip: {
                    filter: (context) => context.raw !== null,
                    callbacks: {
                        title: (context) => `Time: ${context[0].label}`,
                        label: (context) => {
                            const pnl = context.raw;
                            if (pnl === null) return [];
                            const dataIndex = context.dataIndex;
                            const pnlPercent = context.dataset.pnlPercentData[dataIndex];
                            if (pnlPercent === null) return [];
                            const sign = pnl >= 0 ? '+' : '';
                            // Always show P&L amount, hide percentage in anonymous mode
                            const lines = [`Daily P&L: ${sign}${formatCurrencyAlways(pnl)}`];
                            if (!anonymousMode) {
                                const pctSign = pnlPercent >= 0 ? '+' : '';
                                lines.push(`Daily P&L %: ${pctSign}${pnlPercent.toFixed(2)}%`);
                            }
                            return lines;
                        },
                        afterBody: (context) => {
                            if (!context || !context[0]) return [];
                            const dataIndex = context[0].dataIndex;
                            const assetChanges = context[0].dataset.assetChangesData[dataIndex];
                            if (!assetChanges || assetChanges.length === 0) return [];

                            const lines = ['', '── Top Movers ──'];
                            assetChanges.forEach(asset => {
                                const sign = asset.pnl >= 0 ? '+' : '';
                                // Show amount always, hide percentage in anonymous mode
                                if (anonymousMode) {
                                    lines.push(`${asset.symbol}: ${sign}${formatCurrencyAlways(asset.pnl)}`);
                                } else {
                                    const pctSign = asset.pnl_percent >= 0 ? '+' : '';
                                    lines.push(`${asset.symbol}: ${sign}${formatCurrencyAlways(asset.pnl)} (${pctSign}${asset.pnl_percent.toFixed(2)}%)`);
                                }
                            });
                            return lines;
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

    if (view === 'sectors') {
        // Group by sector
        const sectorTotals = {};
        validHoldings.forEach(h => {
            const sector = getSector(h.symbol);
            sectorTotals[sector] = (sectorTotals[sector] || 0) + h.market_value;
        });

        // Convert to array and sort by value (show all sectors)
        const sectorArray = Object.entries(sectorTotals)
            .map(([sector, value]) => ({ sector, value }))
            .sort((a, b) => b.value - a.value);

        labels = sectorArray.map(s => s.sector);
        data = sectorArray.map(s => s.value);

        // Sector colors
        const sectorColors = {
            'Technology': '#2563eb',
            'Consumer': '#f59e0b',
            'Consumer Staples': '#84cc16',
            'Healthcare': '#ef4444',
            'Financials': '#10b981',
            'Energy': '#78716c',
            'Industrials': '#6366f1',
            'Communication': '#ec4899',
            'Real Estate': '#14b8a6',
            'Materials': '#a855f7',
            'Utilities': '#64748b',
            'Automotive': '#f97316',
            'Index ETF': '#0ea5e9',
            'Tech ETF': '#3b82f6',
            'Financial ETF': '#22c55e',
            'Energy ETF': '#a3a3a3',
            'Healthcare ETF': '#f87171',
            'Innovation ETF': '#a78bfa',
            'Bonds': '#94a3b8',
            'Commodities': '#fbbf24',
            'Dividend ETF': '#34d399',
            'Real Estate ETF': '#2dd4bf',
            'Crypto': '#f59e0b',
            'Cash': '#6b7280',
            'Other': '#9ca3af',
        };

        chartColors = labels.map(label => sectorColors[label] || '#9ca3af');

    } else {
        // Assets view (original logic)
        const majorHoldings = [];
        let otherValue = 0;

        validHoldings.forEach(h => {
            const percent = h.market_value / total;
            if (percent >= threshold) {
                majorHoldings.push(h);
            } else {
                otherValue += h.market_value;
            }
        });

        majorHoldings.sort((a, b) => b.market_value - a.market_value);

        labels = majorHoldings.map(h => h.symbol);
        data = majorHoldings.map(h => h.market_value);

        if (otherValue > 0) {
            labels.push('OTHER');
            data.push(otherValue);
        }

        const colors = [
            '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
            '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
        ];
        chartColors = data.map((_, i) => {
            if (i === data.length - 1 && otherValue > 0) {
                return '#9ca3af';
            }
            return colors[i % colors.length];
        });
    }

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
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        boxWidth: 12,
                        padding: 10
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const percent = ((context.raw / total) * 100).toFixed(1);
                            if (anonymousMode) {
                                return `${context.label}: *** (${percent}%)`;
                            }
                            return `${context.label}: ${formatCurrencyAlways(context.raw)} (${percent}%)`;
                        }
                    }
                }
            }
        }
    });
}

function updateAnnualTable(performance) {
    const tbody = document.getElementById('annualBody');

    if (!performance || !performance.performance || performance.performance.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-state">No performance data available</td>
            </tr>
        `;
        return;
    }

    const data = performance.performance;

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

        rows.push({
            year,
            startValue,
            endValue,
            netInvested,
            pnl,
            pnlPercent
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
        return `
        <tr>
            <td><strong>${r.year}</strong></td>
            <td>${formatCurrency(r.startValue)}</td>
            <td>${formatCurrency(r.endValue)}</td>
            <td>${formatCurrency(r.netInvested)}</td>
            <td class="${r.pnl >= 0 ? 'text-success' : 'text-danger'} has-tooltip" data-tooltip="${pnlFormula.replace(/"/g, '&quot;')}">${formatCurrency(r.pnl)}</td>
            <td class="${r.pnlPercent >= 0 ? 'text-success' : 'text-danger'} has-tooltip" data-tooltip="${pnlPercentFormula.replace(/"/g, '&quot;')}">${formatPercent(r.pnlPercent)}</td>
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

    const performance = await fetchPerformance(period);
    if (performance) {
        updatePnlChart(performance);
        updatePerformanceChart(performance);
    }
}

// Load intraday data for a specific interval
async function loadIntradayData(interval) {
    currentInterval = interval;

    // Update button states for Bootstrap
    document.querySelectorAll('.interval-btn').forEach(btn => {
        if (btn.dataset.interval === interval) {
            btn.classList.remove('btn-outline-secondary');
            btn.classList.add('btn-primary', 'active');
        } else {
            btn.classList.remove('btn-primary', 'active');
            btn.classList.add('btn-outline-secondary');
        }
    });

    const intraday = await fetchIntraday(interval);
    if (intraday) {
        updateIntradayChart(intraday, interval);
    }
}

// Main data loading function
async function loadAllData() {
    // Fetch all data in parallel
    const [summary, performance, allPerformance, dividends, sold, intraday] = await Promise.all([
        fetchSummary(),
        fetchPerformance(currentPeriod),
        fetchPerformance('ALL'),  // Fetch all data for annual table
        fetchDividends(),
        fetchSoldAssets(),
        fetchIntraday(currentInterval)
    ]);

    if (summary) {
        updateSummaryCards(summary);
        updateHoldingsTable(summary.holdings);
        updateAllocationChart(summary.holdings, allocationView);
    }

    if (intraday) {
        updateIntradayChart(intraday, currentInterval);
    }

    if (performance) {
        updatePnlChart(performance);
        updatePerformanceChart(performance);
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
    await loadAllData();
}

// Event handlers
document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise spin me-1"></i>Refreshing...';

    try {
        await reloadPortfolio();
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

// Initial load and event handlers setup
document.addEventListener('DOMContentLoaded', () => {
    // Period button event handlers
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const period = btn.dataset.period;
            loadPerformanceData(period);
        });
    });

    // Interval button event handlers (for intraday chart)
    document.querySelectorAll('.interval-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const interval = btn.dataset.interval;
            loadIntradayData(interval);
        });
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

    // Allocation view buttons
    document.querySelectorAll('.allocation-view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            allocationView = view;

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

            // Re-render chart with new view
            updateAllocationChart(null, view);
        });
    });

    // Load data
    loadAllData();

    // Auto-start 5-minute refresh
    startAutoRefresh(300);
    // Mark the 5 minutes option as active
    document.querySelectorAll('.auto-refresh-option').forEach(opt => {
        opt.classList.remove('active');
        if (opt.dataset.interval === '300') {
            opt.classList.add('active');
        }
    });
});
