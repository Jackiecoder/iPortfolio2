const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/js/app.js'), 'utf8');
const handlers = source.slice(source.indexOf('// Event handlers'), source.indexOf("document.getElementById('refreshBtn').addEventListener"));

const THREE_HOURS = 3 * 60 * 60 * 1000;

function setup(saved = null, { expiresAt = THREE_HOURS, start = 0, storageUnavailable = false } = {}) {
    let now = start, nextId = 0, refreshCount = 0;
    const timers = new Map();
    const storage = new Map([['liveRefreshEnabled', saved], ['liveRefreshExpiresAt', String(expiresAt)]]);
    const toasts = [];
    const elements = Object.fromEntries(['refreshBtn', 'portfolioRefreshCard', 'liveRefreshSwitch'].map(id => [id, {
        checked: false, classList: { toggle() {} }, setAttribute() {},
        addEventListener(event, handler) { this[event] = handler; },
    }]));
    const document = {
        hidden: false, getElementById: id => elements[id],
        addEventListener(event, handler) { this[event] = handler; },
    };
    const window = { addEventListener(event, handler) { this[event] = handler; } };
    const checkStorage = () => { if (storageUnavailable) throw new Error('Storage unavailable'); };
    const context = vm.createContext({
        document, window, Date: { now: () => now }, console: { error() {} },
        localStorage: {
            getItem: key => { checkStorage(); return storage.get(key); },
            setItem: (key, value) => { checkStorage(); storage.set(key, value); },
            removeItem: key => { checkStorage(); storage.delete(key); },
        },
        setInterval(callback, interval) { timers.set(++nextId, { callback, interval, next: now + interval }); return nextId; },
        clearInterval: id => timers.delete(id),
        setTimeout(callback, delay) { timers.set(++nextId, { callback, next: now + delay }); return nextId; },
        clearTimeout: id => timers.delete(id),
        refreshData: async () => { refreshCount++; return {}; },
        showToast: (...args) => toasts.push(args),
    });
    vm.runInContext(handlers, context);
    context.initLiveRefresh();
    return {
        context, document, window, elements, storage, timers, toasts,
        count: () => refreshCount,
        toggle(enabled) { elements.liveRefreshSwitch.checked = enabled; elements.liveRefreshSwitch.change(); },
        async advance(ms) {
            const end = now + ms;
            while (true) {
                const [id, timer] = [...timers.entries()].sort((a, b) => a[1].next - b[1].next)[0] || [];
                if (!timer || timer.next > end) break;
                now = timer.next;
                if (timer.interval) timer.next += timer.interval;
                else timers.delete(id);
                await timer.callback();
            }
            now = end;
        },
        suspend(ms) { now += ms; },
    };
}

test('Live defaults off, refreshes every minute when enabled, and stops when disabled', async () => {
    const page = setup();
    await page.advance(120000);
    assert.equal(page.count(), 0);
    page.toggle(true);
    assert.equal(page.storage.get('liveRefreshEnabled'), 'true');
    await page.advance(59999);
    assert.equal(page.count(), 0);
    await page.advance(1);
    assert.equal(page.count(), 1);
    await page.advance(60000);
    assert.equal(page.count(), 2);
    assert.deepEqual(page.toasts, []);
    page.toggle(false);
    await page.advance(120000);
    assert.equal(page.count(), 2);
    assert.equal(page.storage.get('liveRefreshEnabled'), 'false');
    assert.equal(page.timers.size, 0);
});

test('saved Live deadline resumes after reload and repeated toggles keep one interval and one expiry timer', async () => {
    const page = setup('true');
    assert.equal(page.elements.liveRefreshSwitch.checked, true);
    page.toggle(false);
    page.toggle(true);
    page.toggle(true);
    assert.equal(page.timers.size, 2);
    await page.advance(60000);
    assert.equal(page.count(), 1);
});

test('manual and automatic refreshes cannot overlap in either direction', async () => {
    const page = setup('true');
    let finish, requests = 0;
    page.context.refreshData = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
    const manual = page.context.runManualRefresh();
    await page.advance(60000);
    assert.equal(requests, 1);
    assert.equal(page.elements.refreshBtn.disabled, true);
    finish({});
    await manual;
    const automatic = page.context.runRefresh({ automatic: true });
    await page.context.runManualRefresh();
    assert.equal(requests, 2);
    finish({});
    await automatic;
    assert.equal(page.elements.refreshBtn.disabled, false);
    assert.equal(page.toasts.length, 1);
});

test('failed automatic refresh releases the guard and retries on the next minute', async () => {
    const page = setup('true');
    let requests = 0;
    page.context.refreshData = async () => { if (++requests === 1) throw new Error('offline'); return {}; };
    await page.advance(60000);
    assert.equal(page.elements.refreshBtn.disabled, false);
    await page.advance(60000);
    assert.equal(requests, 2);
    assert.deepEqual(page.toasts, []);
});

test('a suspended tab catches up on return only if Live remains enabled', async () => {
    const page = setup('true');
    page.document.hidden = true;
    page.suspend(180000);
    page.document.visibilitychange();
    assert.equal(page.count(), 0);
    page.document.hidden = false;
    page.document.visibilitychange();
    assert.equal(page.count(), 1);
    page.toggle(false);
    page.suspend(180000);
    page.document.visibilitychange();
    assert.equal(page.count(), 1);
});

test('Live turns off at three hours before sending another request; manual refresh still works', async () => {
    const page = setup();
    page.toggle(true);
    assert.equal(Number(page.storage.get('liveRefreshExpiresAt')), THREE_HOURS);
    await page.advance(THREE_HOURS - 1);
    assert.equal(page.count(), 179);
    assert.equal(page.elements.liveRefreshSwitch.checked, true);
    await page.advance(1);
    assert.equal(page.count(), 179);
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.storage.get('liveRefreshEnabled'), 'false');
    assert.equal(page.storage.has('liveRefreshExpiresAt'), false);
    assert.equal(page.timers.size, 0);
    assert.deepEqual(page.toasts, [['Live turned off after 3 hours.', 'info']]);
    await page.advance(THREE_HOURS);
    await page.context.runRefresh({ automatic: true });
    assert.equal(page.count(), 179);
    await page.context.runManualRefresh();
    assert.equal(page.count(), 180);
    page.toggle(true);
    assert.equal(Number(page.storage.get('liveRefreshExpiresAt')), THREE_HOURS * 3);
    await page.advance(60000);
    assert.equal(page.count(), 181);
});

test('reload preserves the original deadline instead of adding three more hours', async () => {
    const page = setup('true', { start: THREE_HOURS - 60000 });
    assert.equal(page.elements.liveRefreshSwitch.checked, true);
    assert.equal(Number(page.storage.get('liveRefreshExpiresAt')), THREE_HOURS);
    await page.advance(60000);
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.count(), 0);
});

test('expired, legacy, and invalid saved deadlines stay off', async () => {
    for (const expiresAt of [null, undefined, 'invalid', Infinity, 0, THREE_HOURS + 1]) {
        const page = setup('true', { expiresAt: expiresAt === undefined ? 'undefined' : expiresAt });
        assert.equal(page.elements.liveRefreshSwitch.checked, false, String(expiresAt));
        assert.equal(page.timers.size, 0);
        await page.advance(60000);
        assert.equal(page.count(), 0);
    }
    const expired = setup('true', { start: THREE_HOURS });
    assert.equal(expired.elements.liveRefreshSwitch.checked, false);
});

test('expired suspended tabs stop before visibility catch-up or a delayed interval fires', async () => {
    for (const wake of ['visibility', 'interval']) {
        const page = setup('true');
        const delayedTick = [...page.timers.values()].find(timer => timer.interval).callback;
        page.document.hidden = true;
        page.suspend(THREE_HOURS + 60000);
        if (wake === 'visibility') {
            page.document.hidden = false;
            page.document.visibilitychange();
        } else await delayedTick();
        assert.equal(page.count(), 0);
        assert.equal(page.elements.liveRefreshSwitch.checked, false);
        assert.equal(page.timers.size, 0);
    }
});

test('Live expires even while an earlier request is still in flight', async () => {
    const page = setup('true');
    let finish;
    page.context.refreshData = () => new Promise(resolve => { finish = resolve; });
    const request = page.context.runRefresh({ automatic: true });
    await page.advance(THREE_HOURS);
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.timers.size, 0);
    assert.equal(page.elements.refreshBtn.disabled, true);
    finish({});
    await request;
    assert.equal(page.elements.refreshBtn.disabled, false);
});

test('another tab synchronizes the existing deadline and can turn Live off', async () => {
    const page = setup();
    page.storage.set('liveRefreshExpiresAt', '120000');
    page.window.storage({ key: 'liveRefreshExpiresAt' });
    // An intermediate storage event must not overwrite the other tab's update.
    assert.equal(page.storage.get('liveRefreshExpiresAt'), '120000');
    page.storage.set('liveRefreshEnabled', 'true');
    page.window.storage({ key: 'liveRefreshEnabled' });
    assert.equal(page.elements.liveRefreshSwitch.checked, true);
    await page.advance(60000);
    page.window.storage({ key: 'liveRefreshExpiresAt' });
    assert.equal(page.storage.get('liveRefreshExpiresAt'), '120000');
    await page.advance(60000);
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.count(), 1);
    page.toggle(true);
    page.storage.set('liveRefreshEnabled', 'false');
    page.window.storage({ key: 'liveRefreshEnabled' });
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.timers.size, 0);
});

test('three-hour limit works even when browser storage is blocked', async () => {
    const page = setup(null, { storageUnavailable: true });
    page.toggle(true);
    await page.advance(THREE_HOURS);
    assert.equal(page.elements.liveRefreshSwitch.checked, false);
    assert.equal(page.count(), 179);
    assert.equal(page.timers.size, 0);
});
