// Give the intraday line all remaining space on the opening screen, including
// when timestamps, summary details or mobile controls change height.
document.addEventListener('DOMContentLoaded', () => {
    const pane = document.getElementById('trackerToday');
    const card = pane?.querySelector('.intraday-focus-card');
    const plot = card?.querySelector('.pnl-chart-container');
    if (!plot) return;
    let frame = 0;

    function fitChart() {
        frame = 0;
        if (!pane.classList.contains('active') || !plot.getClientRects().length) return;
        const bounds = plot.getBoundingClientRect();
        const viewport = window.visualViewport?.height || window.innerHeight;
        // Use document coordinates so scrolling never makes the plot grow.
        const top = bounds.top + window.scrollY;
        const footer = card.getBoundingClientRect().bottom - bounds.bottom;
        const bottomGap = parseFloat(getComputedStyle(document.querySelector('.app-shell')).paddingBottom) || 16;
        const minimum = viewport < 640 ? 160 : 220;
        const height = Math.max(minimum, Math.floor(viewport - top - footer - bottomGap));
        const value = `${height}px`;
        if (plot.style.getPropertyValue('--today-chart-height') !== value) {
            plot.style.setProperty('--today-chart-height', value);
        }
    }
    function scheduleFit() {
        if (!frame) frame = requestAnimationFrame(fitChart);
    }

    const observer = new ResizeObserver(scheduleFit);
    [
        document.querySelector('.app-navbar'),
        document.querySelector('.demo-banner'),
        document.getElementById('portfolioOverview'),
        document.getElementById('transactionUpdateNotice'),
        document.getElementById('trackerTabs'),
        card.querySelector('.card-header'),
        card.querySelector('.intraday-spotlight'),
    ].filter(Boolean).forEach(element => observer.observe(element));
    document.getElementById('trackerTabs')?.addEventListener('shown.bs.tab', scheduleFit);
    window.addEventListener('resize', scheduleFit, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleFit, { passive: true });
    scheduleFit();
});
