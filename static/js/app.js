// Portfolio Tracker Frontend Application

// Chart instances
let performanceChart = null;
let allocationChart = null;
let pnlChart = null;

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

// Utility functions
function formatCurrency(value) {
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
    const sign = value >= 0 ? '+' : '';
    return `${sign}${formatNumber(value)}%`;
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
    pnlElement.className = `card-text fs-4 fw-bold mb-0 ${summary.total_unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}`;

    const returnElement = document.getElementById('totalReturn');
    returnElement.textContent = formatPercent(summary.total_pnl_percent);
    returnElement.className = `card-text fs-4 fw-bold mb-0 ${summary.total_pnl_percent >= 0 ? 'text-success' : 'text-danger'}`;

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
                <td colspan="8" class="empty-state">
                    <p>No holdings found</p>
                    <p>Upload a CSV file to get started</p>
                </td>
            </tr>
        `;
        return;
    }

    // Sort holdings
    const sortedHoldings = sortHoldings(holdings, holdingsSortColumn, holdingsSortDirection);

    tbody.innerHTML = sortedHoldings.map(h => `
        <tr>
            <td><strong>${h.symbol}</strong></td>
            <td>${formatNumber(h.quantity, 4)}</td>
            <td>${formatCurrency(h.avg_cost)}</td>
            <td>${formatCurrency(h.cost_basis)}</td>
            <td>${formatCurrency(h.current_price)}</td>
            <td>${formatCurrency(h.market_value)}</td>
            <td class="${h.unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(h.unrealized_pnl)}</td>
            <td class="${h.pnl_percent >= 0 ? 'text-success' : 'text-danger'}">${formatPercent(h.pnl_percent)}</td>
        </tr>
    `).join('');

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
            <td><strong>${d.symbol}</strong></td>
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
            <td><strong>${s.symbol}</strong></td>
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

function updateAllocationChart(holdings) {
    const ctx = document.getElementById('allocationChart').getContext('2d');

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

    // Calculate total and threshold
    const total = validHoldings.reduce((sum, h) => sum + h.market_value, 0);
    const threshold = 0.03; // 3%

    // Separate holdings into major (>= 3%) and minor (< 3%)
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

    // Sort major holdings by value descending
    majorHoldings.sort((a, b) => b.market_value - a.market_value);

    // Prepare chart data
    const labels = majorHoldings.map(h => h.symbol);
    const data = majorHoldings.map(h => h.market_value);

    // Add "OTHER" category if there are minor holdings
    if (otherValue > 0) {
        labels.push('OTHER');
        data.push(otherValue);
    }

    // Generate colors
    const colors = [
        '#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
        '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
    ];
    // Use gray for "OTHER"
    const chartColors = data.map((_, i) => {
        if (i === data.length - 1 && otherValue > 0) {
            return '#9ca3af'; // Gray for OTHER
        }
        return colors[i % colors.length];
    });

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
                            return `${context.label}: ${formatCurrency(context.raw)} (${percent}%)`;
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

// Main data loading function
async function loadAllData() {
    // Fetch all data in parallel
    const [summary, performance, allPerformance, dividends, sold] = await Promise.all([
        fetchSummary(),
        fetchPerformance(currentPeriod),
        fetchPerformance('ALL'),  // Fetch all data for annual table
        fetchDividends(),
        fetchSoldAssets()
    ]);

    if (summary) {
        updateSummaryCards(summary);
        updateHoldingsTable(summary.holdings);
        updateAllocationChart(summary.holdings);
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

    // Load data
    loadAllData();
});
