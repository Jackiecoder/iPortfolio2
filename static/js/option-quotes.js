(function (root) {
    'use strict';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const finite = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
    const today = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
    function valuation(call, quote, snapshot) {
        if (!quote || !snapshot || snapshot.cache_status === 'stale' || call.adjustment_required || call.expiration < today() || !(call.remaining_contracts > 0) || quote.quote_status === 'crossed') return null;
        const age = Date.now() - Date.parse(snapshot.fetched_at);
        if (!Number.isFinite(age) || age < -60000 || age > 120000) return null;
        const shares = call.remaining_contracts * 100;
        const openingNet = Number(call.premium) * shares - Number(call.fees) * call.remaining_contracts / call.contracts;
        const mid = finite(quote.bid) && finite(quote.ask) && quote.ask >= quote.bid ? (quote.bid + quote.ask) / 2 : null;
        return { askCost: finite(quote.ask) ? quote.ask * shares : null,
            midCost: mid === null ? null : mid * shares,
            pnl: mid === null ? null : openingNet - mid * shares };
    }
    function matchingCall(snapshot, call) {
        if (!snapshot || snapshot.symbol !== call.asset || snapshot.expiration !== call.expiration) return null;
        return snapshot.calls.find(q => Number(q.strike) === Number(call.strike)) || null;
    }
    function timestamp(value) {
        if (!value || !Number.isFinite(Date.parse(value))) return 'Not supplied';
        return new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'}).format(new Date(value)) + ' ET';
    }
    function init(config) {
        const $ = id => document.getElementById(id);
        if (!$('oqForm')) return null;
        const cache = new Map(), pending = new Map();
        if (config.demo) $('oqSymbol').value = 'MU';
        let chain = null, chainVersion = 0, loading = false, queryError = '';
        const key = (symbol, expiration) => `${symbol}|${expiration || ''}`;
        const price = n => finite(n) ? config.money(n) : '—';
        const amount = n => n === null ? '—' : config.money(n);
        const count = n => config.private() ? '***' : n === null ? '—' : Number(n).toLocaleString('en-US');
        const quoteNote = result => `${esc(result.source)} · Retrieved ${esc(timestamp(result.fetched_at))}${result.cache_status === 'cached' ? ` · Cached ${result.cache_age_seconds}s` : ''}. ${esc(result.delay_notice)}${result.cache_status === 'stale' ? ' ' + esc(result.warning) : ''}`;
        async function fetchChain(symbol, expiration) {
            const k = key(symbol, expiration);
            if (pending.has(k)) return pending.get(k);
            const task = (async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                try {
                    const params = new URLSearchParams({symbol});
                    if (expiration) params.set('expiration', expiration);
                    const response = await fetch('/api/options/calls?' + params, {signal:controller.signal});
                    const result = await response.json();
                    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Quotes unavailable. Check the ticker and expiration.');
                    cache.set(k, {result}); cache.set(key(symbol, result.expiration), {result});
                    return result;
                } catch (error) {
                    const message = error.name === 'AbortError' ? 'Quote request timed out. Try again.' : error.message;
                    // Failed refresh must not leave an apparently current valuation.
                    cache.set(k, {error: message});
                    throw new Error(message);
                } finally { clearTimeout(timeout); }
            })();
            pending.set(k, task);
            try { return await task; }
            finally { pending.delete(k); }
        }
        function renderCards() {
            for (const slot of document.querySelectorAll('[data-cc-quote]')) {
                const call = config.calls().find(c => c.id === Number(slot.dataset.ccQuote));
                if (!call || !call.remaining_contracts) { slot.innerHTML = ''; continue; }
                if (call.adjustment_required || call.expiration < today()) {
                    slot.textContent = call.adjustment_required ? 'Quote valuation unavailable for an adjusted contract.' : 'Expired contract: confirm the outcome with your broker. No current valuation.';
                    continue;
                }
                const k = key(call.asset, call.expiration), entry = cache.get(k);
                if (pending.has(k) || !entry) { slot.textContent = 'Loading reference quotes…'; continue; }
                if (entry.error) { slot.textContent = `Quotes unavailable: ${entry.error}`; continue; }
                const q = matchingCall(entry.result, call);
                if (!q) { slot.textContent = 'No matching standard call quote for this strike and expiration.'; continue; }
                const v = valuation(call, q, entry.result);
                slot.innerHTML = `<div class="oq-quote-grid">${[['Bid',price(q.bid)],['Ask',price(q.ask)],['Mid',price(q.mid)],['Last',price(q.last)]].map(([l,p])=>`<div><span>${l}</span><strong>${p}</strong></div>`).join('')}</div>
                    <div class="oq-estimates"><div>Est. buyback at Ask <strong>${amount(v?.askCost ?? null)}</strong></div><div>Est. unrealized P&amp;L at Mid <strong>${amount(v?.pnl ?? null)}</strong></div></div>
                    <p class="oq-note">Last trade: ${esc(timestamp(q.last_trade_at))}. ${q.quote_status === 'crossed' ? 'Crossed quote; estimates unavailable. ' : q.mid === null ? 'Incomplete bid/ask; midpoint unavailable. ' : ''}${quoteNote(entry.result)}</p>
                    <p class="oq-note mb-0">Estimates use remaining contracts and allocated opening fees, exclude closing fees, and stay separate from Holdings totals.</p>`;
            }
        }
        async function loadCalls() {
            const groups = [...new Map(config.calls().filter(c => c.remaining_contracts > 0 && !c.adjustment_required && c.expiration >= today()).map(c => [key(c.asset,c.expiration), c])).values()];
            // Limit upstream demand while independent Holdings and ledger views stay responsive.
            let next = 0;
            await Promise.all(Array.from({length:Math.min(3,groups.length)}, async () => {
                while (next < groups.length) {
                    const c = groups[next++];
                    const request = fetchChain(c.asset, c.expiration);
                    renderCards();
                    try { await request; } catch (_) { /* Per-contract error is rendered below. */ }
                    renderCards();
                }
            }));
        }
        function renderChain() {
            $('oqStatus').textContent = loading ? 'Loading call quotes…' : queryError;
            if (loading || queryError || !chain) { $('oqResults').innerHTML = ''; return; }
            const strike = $('oqStrike').value.trim();
            const rows = chain.calls.filter(q => !strike || Number(strike) === q.strike);
            $('oqResults').innerHTML = `<p class="oq-note">${quoteNote(chain)}</p><div class="table-responsive oq-table"><table class="table table-sm"><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Mid</th><th>Last</th><th>Volume</th><th>Open interest</th><th>Last trade (ET)</th></tr></thead><tbody>${rows.map(q=>`<tr><th>${price(q.strike)}</th><td>${price(q.bid)}</td><td>${price(q.ask)}</td><td>${price(q.mid)}</td><td>${price(q.last)}</td><td>${count(q.volume)}</td><td>${count(q.open_interest)}</td><td>${esc(timestamp(q.last_trade_at))}${q.quote_status === 'crossed' ? ' · Crossed quote' : ''}</td></tr>`).join('')}</tbody></table></div>${rows.length ? '' : '<p class="small">No matching standard call strike. Clear the strike filter to see all listed calls.</p>'}`;
        }
        $('oqForm').addEventListener('submit', async event => {
            event.preventDefault();
            const version = ++chainVersion;
            const symbol = $('oqSymbol').value.trim().toUpperCase(), expiry = $('oqExpiry').value;
            if (!$('oqForm').reportValidity()) return;
            loading = true; queryError = ''; chain = null; renderChain();
            try {
                const result = await fetchChain(symbol, expiry);
                if (version !== chainVersion) return;
                chain = result;
                $('oqExpiry').innerHTML = result.expirations.map(d=>`<option value="${esc(d)}" ${d === result.expiration ? 'selected' : ''}>${esc(d)}</option>`).join('');
            } catch (error) { if (version === chainVersion) queryError = error.message; }
            finally { if (version === chainVersion) { loading = false; renderChain(); renderCards(); } }
        });
        $('oqSymbol').addEventListener('input', () => {
            chainVersion++; chain = null; loading = false; queryError = '';
            $('oqExpiry').innerHTML = '<option value="">Nearest listed date</option>';
            renderChain();
        });
        $('oqExpiry').addEventListener('change', () => { chainVersion++; chain = null; loading = false; queryError = ''; renderChain(); });
        $('oqStrike').addEventListener('input', renderChain);
        document.addEventListener('visibilitychange', () => {
            renderCards();
            if (!document.hidden && $('trackerCoveredCalls').classList.contains('active')) loadCalls();
        });
        setInterval(() => {
            if (!document.hidden && $('trackerCoveredCalls').classList.contains('active')) loadCalls();
        }, 60000);
        return {loadCalls, render:() => {renderCards(); renderChain();}};
    }
    const api = {init, valuation, matchingCall, timestamp};
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.OptionQuotes = api;
})(globalThis);
