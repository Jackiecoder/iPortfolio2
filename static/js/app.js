// Portfolio Tracker Frontend Application

// Chart instances
let performanceChart = null;
let investmentChart = null;
let allocationChart = null;
let pnlChart = null;
let intradayChart = null;

// Portfolio chart view mode
let portfolioChartView = 'value'; // 'value' or 'investment'
let currentPerformanceData = null; // Store performance data for chart switching
let portfolioPeriod = '1Y'; // Portfolio chart period (global for both value and investment views)

// Current intraday interval
let currentInterval = '5m';

// Anonymous mode
let anonymousMode = localStorage.getItem('anonymousMode') === 'true';

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
                <td colspan="11" class="empty-state">
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

        // Annualized return with calculation tooltip
        const annualReturn = h.annualized_return;
        const holdingDays = h.holding_days;
        const pnlPercent = h.pnl_percent;
        const annualReturnClass = annualReturn !== null && annualReturn !== undefined
            ? (annualReturn >= 0 ? 'text-success' : 'text-danger')
            : '';
        const annualReturnText = annualReturn !== null && annualReturn !== undefined
            ? `${annualReturn >= 0 ? '+' : ''}${annualReturn.toFixed(2)}%`
            : '--';

        // Build tooltip showing calculation
        let annualTooltip = '';
        if (holdingDays !== null && holdingDays !== undefined && pnlPercent !== null) {
            const years = holdingDays / 365;
            const yearsForCalc = Math.max(years, 1);
            const pnlSign = pnlPercent >= 0 ? '+' : '';
            annualTooltip = `title="${pnlSign}${pnlPercent.toFixed(2)}% / ${yearsForCalc.toFixed(2)} yrs\n(${holdingDays} days${years < 1 ? ', min 1yr' : ''})"`;
        }

        // Weighted annualized return (per-lot cost-basis weighted CAGR)
        const weightedAnnualReturn = h.weighted_annualized_return;
        const weightedAnnualReturnClass = weightedAnnualReturn !== null && weightedAnnualReturn !== undefined
            ? (weightedAnnualReturn >= 0 ? 'text-success' : 'text-danger')
            : '';
        const weightedAnnualReturnText = weightedAnnualReturn !== null && weightedAnnualReturn !== undefined
            ? `${weightedAnnualReturn >= 0 ? '+' : ''}${weightedAnnualReturn.toFixed(2)}%`
            : '--';
        const weightedAnnualTooltip = 'title="Per-lot cost-basis weighted CAGR"';

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
            <td class="${annualReturnClass}" ${annualTooltip}>${annualReturnText}</td>
            <td class="${weightedAnnualReturnClass}" ${weightedAnnualTooltip}>${weightedAnnualReturnText}</td>
        </tr>
    `}).join('');

    updateSortIndicators();
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
        const dailyClass = cat.daily_change >= 0 ? 'text-success' : 'text-danger';
        const dailySign = cat.daily_change >= 0 ? '+' : '';
        const pnlClass = cat.pnl >= 0 ? 'text-success' : 'text-danger';
        const pnlSign = cat.pnl >= 0 ? '+' : '';
        const color = categoryColors[cat.name] || '#6b7280';

        return `
            <tr>
                <td>
                    <span style="display: inline-block; width: 12px; height: 12px; background-color: ${color}; border-radius: 2px; margin-right: 8px;"></span>
                    ${cat.name}
                    <span class="text-muted ms-2">(${cat.allocation_percent.toFixed(1)}%)</span>
                </td>
                <td>${formatCurrency(cat.cost_basis)}</td>
                <td class="${dailyClass}">${dailySign}${formatCurrency(cat.daily_change)}</td>
                <td>${formatCurrency(cat.market_value)}</td>
                <td class="${pnlClass}">${pnlSign}${formatCurrency(cat.pnl)}</td>
                <td class="${pnlClass}">${pnlSign}${cat.pnl_percent.toFixed(2)}%</td>
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
                    display: false
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
                            transactions.forEach(tx => {
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

            if (baseline === undefined) return;

            // Draw baseline dashed line
            const yPixel = yAxis.getPixelForValue(baseline);
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([5, 5]);
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 1;
            ctx.moveTo(xAxis.left, yPixel);
            ctx.lineTo(xAxis.right, yPixel);
            ctx.stroke();
            ctx.restore();

            // Draw vs Start label at the last data point
            if (data.length > 0) {
                const lastIndex = data.length - 1;
                const lastValue = data[lastIndex];
                if (lastValue !== null && lastValue !== undefined) {
                    const x = xAxis.getPixelForValue(lastIndex);
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

    pnlChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{
                label: 'P&L',
                data: pnlData,
                costBasisData: costBasisData,
                baselineValue: baselineValue,
                startingInvestmentValue: startingInvestmentValue,
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
                            const pnl = context.raw;
                            const dataIndex = context.dataIndex;
                            const costBasis = context.dataset.costBasisData[dataIndex];
                            const baseline = context.dataset.baselineValue;
                            const startingValue = context.dataset.startingInvestmentValue;
                            const pnlPercent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
                            const changeFromBaseline = pnl - baseline;
                            // Calculate percentage change vs start based on starting portfolio value
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

        // Only draw market open/close lines if today is a trading day
        if (isMarketDay()) {
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

    // Check if we're drilling into a specific category
    const specificCategories = ['Crypto', 'Index', 'Individual Stocks'];
    const isDrillDown = specificCategories.includes(view);

    if (isDrillDown) {
        // Drill-down view: show assets within the selected category
        const categoryHoldings = validHoldings.filter(h => getCategory(h.symbol) === view);

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

        labels = categoryHoldings.map(h => h.symbol);
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
            const category = getCategory(h.symbol);
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
    const fetchList = [
        fetchSummary(),
        fetchPerformance(currentPeriod),
        fetchPerformance('ALL'),  // Fetch all data for annual table
        fetchDividends(),
        fetchSoldAssets(),
        fetchIntraday(currentInterval)
    ];

    // Add separate fetch for portfolio chart if period is different from ALL
    const needsSeparatePortfolioFetch = portfolioPeriod !== 'ALL';
    if (needsSeparatePortfolioFetch) {
        fetchList.push(fetchPerformance(portfolioPeriod));
    }

    const results = await Promise.all(fetchList);
    const [summary, performance, allPerformance, dividends, sold, intraday] = results;
    const portfolioPerformance = needsSeparatePortfolioFetch ? results[6] : allPerformance;

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
