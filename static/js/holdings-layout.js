// Holdings: one vertical scroll surface, with the real table headings following
// the page beneath sticky navigation. No duplicate tables or touch traps.
document.addEventListener('DOMContentLoaded', () => {
    const page = document.getElementById('trackerPage');
    const pane = document.getElementById('trackerHoldings');
    const tabs = document.getElementById('trackerTabs');
    const navbar = document.querySelector('.app-navbar');
    const table = document.getElementById('holdingsTable');
    const scroller = table?.closest('.holdings-table-scroll');
    const toggle = document.getElementById('holdingsOverviewToggle');
    if (!page || !pane || !tabs || !table || !scroller || !toggle) return;
    const mobile = window.matchMedia('(max-width: 767.98px)');
    let frame = 0;

    function alignHeadings() {
        frame = 0;
        if (!pane.classList.contains('active')) {
            scroller.style.removeProperty('--holdings-header-offset');
            return;
        }
        const bounds = table.getBoundingClientRect();
        const headingHeight = table.tHead.getBoundingClientRect().height;
        let top = mobile.matches ? tabs.getBoundingClientRect().bottom : 0;
        if (!mobile.matches && navbar) {
            const navBounds = navbar.getBoundingClientRect();
            const scrollBounds = scroller.getBoundingClientRect();
            const position = getComputedStyle(navbar).position;
            // A sidebar does not cover this table; a sticky workspace bar does.
            if (['sticky', 'fixed'].includes(position) &&
                navBounds.right > scrollBounds.left && navBounds.left < scrollBounds.right) {
                top = Math.max(0, navBounds.bottom);
            }
        }
        const offset = Math.max(0, Math.min(top - bounds.top, bounds.height - headingHeight));
        scroller.style.setProperty('--holdings-header-offset', `${offset}px`);
    }
    function scheduleAlignment() {
        if (!frame) frame = requestAnimationFrame(alignHeadings);
    }
    function closeOverview() {
        page.classList.remove('holdings-overview-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.querySelector('i').className = 'bi bi-chevron-down';
    }
    function syncTab() {
        const active = pane.classList.contains('active');
        page.classList.toggle('holdings-focused', active);
        closeOverview();
        if (active) scroller.scrollTop = 0;
        scheduleAlignment();
    }
    tabs.addEventListener('shown.bs.tab', () => {
        syncTab();
        // Keep tab navigation reachable when leaving a long holdings list, or
        // entering it from a scrolled chart, after the summary changes height.
        if (mobile.matches) {
            const top = window.scrollY + document.getElementById('trackerTabsStart').getBoundingClientRect().top;
            if (window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
        }
    });
    toggle.addEventListener('click', () => {
        const open = page.classList.toggle('holdings-overview-open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.querySelector('i').className = `bi bi-chevron-${open ? 'up' : 'down'}`;
        if (open) document.getElementById('portfolioOverview').scrollIntoView({ block: 'start', behavior: 'instant' });
        scheduleAlignment();
    });
    window.addEventListener('scroll', scheduleAlignment, { passive: true });
    window.addEventListener('resize', scheduleAlignment, { passive: true });
    mobile.addEventListener('change', () => {
        scroller.scrollTop = 0;
        scheduleAlignment();
    });
    const resize = new ResizeObserver(scheduleAlignment);
    [table, table.tHead, tabs, navbar, pane.querySelector('.holdings-card-header')]
        .filter(Boolean).forEach(element => resize.observe(element));

    // Keep one concise timestamp visible; retain both source timestamps and the
    // snapshot explanation inside native, keyboard-accessible update details.
    const today = document.getElementById('holdingsTodayStatus');
    const prices = document.getElementById('holdingsDataStatus');
    const label = document.getElementById('holdingsUpdateLabel');
    function updateLabel() {
        const daily = today.textContent.replace(' · Same snapshot as Intraday P&L', '');
        const priceStatus = prices.textContent;
        label.textContent = /failed/i.test(priceStatus) ? priceStatus
            : daily || priceStatus || 'Updating…';
        if (daily && /updating|cached/i.test(priceStatus) && !/updating|cached/i.test(daily)) {
            label.textContent += ' · Updating prices…';
        }
    }
    const status = new MutationObserver(updateLabel);
    [today, prices].forEach(element => status.observe(element, { childList: true, subtree: true, characterData: true }));
    updateLabel();
    syncTab();
});
