(function (root) {
    'use strict';
    const currencies = ['USD', 'CNY'];
    const labels = { in: '转入', out: '转出', internal: '账户间转账', lent: '我借给别人', borrowed: '我向别人借',
        purchase: '进货', sale: '出货', opening: '期初库存', exchange: '换汇', recorded: '已记录', open: '待还款', partial: '部分结清', settled: '已结清', unpaid: '未付款', paid: '已付清', void: '已作废' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cleanNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const quantity = (value, privateMode = false) => privateMode ? '***' : cleanNumber(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
    const money = (value, currency = 'USD', privateMode = false) => privateMode ? '***' : `${escape(currency)} ${cleanNumber(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
    const sensitive = (value, privateMode) => privateMode ? '***' : escape(value || '—');
    const formatRate = (value, privateMode = false) => privateMode ? '***' : Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value).toLocaleString('zh-CN', { maximumSignificantDigits: 12, useGrouping: false }) : '—';
    // Rate entry fills the target amount using decimal arithmetic, preserving large exact input strings.
    function decimalParts(value) {
        const source = String(value ?? '').trim();
        const match = /^(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:e([+-]?[0-9]+))?$/i.exec(source);
        if (!match || source.length > 100) return null;
        const fraction = match[2] ?? match[3] ?? '';
        const exponent = Number(match[4] || 0);
        if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
        const integer = match[1] || '0';
        let coefficient = BigInt(integer + fraction), scale = fraction.length - exponent;
        if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
        return { coefficient, scale };
    }
    function amountFromRate(fromAmount, rate) {
        const amount = decimalParts(fromAmount), quote = decimalParts(rate);
        if (!amount || !quote || amount.coefficient <= 0n || quote.coefficient <= 0n) return null;
        let coefficient = amount.coefficient * quote.coefficient;
        const scale = amount.scale + quote.scale;
        if (scale > 6) { const divisor = 10n ** BigInt(scale - 6); coefficient = (coefficient + divisor / 2n) / divisor; }
        else coefficient *= 10n ** BigInt(6 - scale);
        const digits = coefficient.toString().padStart(7, '0');
        return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/\.?0+$/, '');
    }
    function inventoryAmount(left, right) {
        const a = decimalParts(left), b = decimalParts(right);
        if (!a || !b) return null;
        let coefficient = a.coefficient * b.coefficient;
        const scale = a.scale + b.scale;
        if (scale > 6) {
            const divisor = 10n ** BigInt(scale - 6), remainder = coefficient % divisor;
            coefficient /= divisor;
            if (remainder * 2n > divisor || (remainder * 2n === divisor && coefficient % 2n === 1n)) coefficient += 1n;
        } else coefficient *= 10n ** BigInt(6 - scale);
        const digits = coefficient.toString().padStart(7, '0');
        return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/\.?0+$/, '');
    }
    function decimalSum(values) {
        const parts = values.map(decimalParts);
        if (parts.some(p => !p)) return null;
        const scale = Math.max(0, ...parts.map(p => p.scale));
        const coefficient = parts.reduce((sum, p) => sum + p.coefficient * 10n ** BigInt(scale - p.scale), 0n);
        if (!scale) return coefficient.toString();
        const digits = coefficient.toString().padStart(scale + 1, '0');
        return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
    }
    function decimalGreater(left, right) {
        const a = decimalParts(left), b = decimalParts(right);
        if (!a || !b) return false;
        const scale = Math.max(a.scale, b.scale);
        return a.coefficient * 10n ** BigInt(scale - a.scale) > b.coefficient * 10n ** BigInt(scale - b.scale);
    }
    function validInventoryRate(rate, sameCurrency) {
        const parts = decimalParts(rate);
        if (parts) while (parts.scale > 0 && parts.coefficient % 10n === 0n) { parts.coefficient /= 10n; parts.scale -= 1; }
        return Boolean(parts && parts.coefficient > 0n && parts.scale <= 12 && (!sameCurrency || !decimalGreater(rate, '1') && !decimalGreater('1', rate)));
    }
    function exchangeAmounts(record) {
        const from = cleanNumber(record.from_amount), to = cleanNumber(record.to_amount), fee = cleanNumber(record.fee_amount);
        const debited = from + (record.fee_currency === record.from_currency ? fee : 0);
        const received = to - (record.fee_currency === record.to_currency ? fee : 0);
        return { debited_amount: debited, received_amount: received, exchange_rate: from > 0 ? to / from : 0, inverse_rate: to > 0 ? from / to : 0, effective_rate: debited > 0 ? received / debited : 0 };
    }
    function badge(status, label) {
        const style = status === 'void' ? 'is-void' : ['settled', 'paid', 'in', 'sale'].includes(status) ? 'is-good' : ['open', 'partial', 'unpaid'].includes(status) ? 'is-open' : '';
        return `<span class="finance-badge ${style}">${escape(label || labels[status] || status)}</span>`;
    }
    function filterRecords(records, filter = {}, products = []) {
        const names = new Map(products.map(p => [Number(p.id), p.name]));
        const query = String(filter.search || '').trim().toLocaleLowerCase();
        return records.filter(record => {
            if (!filter.showVoided && record.voided) return false;
            if (filter.currency && ![record.currency, record.base_currency, record.from_currency, record.to_currency].includes(filter.currency)) return false;
            if (filter.status && record.status !== filter.status && record.direction !== filter.status && record.kind !== filter.status) return false;
            if (!query) return true;
            return [record.counterparty, record.from_account, record.to_account, record.reference, record.method, record.note,
                record.date, record.currency, record.base_currency, record.from_currency, record.to_currency, names.get(Number(record.product_id))].some(v => String(v || '').toLocaleLowerCase().includes(query));
        }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id));
    }
    function renderRows(records, section, products = [], privateMode = false) {
        const names = new Map(products.map(p => [Number(p.id), p]));
        return records.map(record => {
            let title, subtitle, amount, secondary, income = false;
            let type = record.direction || record.kind;
            let status = record.voided ? 'void' : (record.status || type);
            if (section === 'transfers') {
                title = sensitive(record.counterparty || (record.direction === 'internal' ? '自己的账户' : '未填写对方'), privateMode);
                subtitle = record.direction === 'internal' ? `${sensitive(record.from_account, privateMode)} → ${sensitive(record.to_account, privateMode)}` : sensitive(record.note || record.reference || [record.from_account, record.to_account].filter(Boolean).join(' → '), privateMode);
                amount = money(record.amount, record.currency, privateMode);
                secondary = labels[type]; income = type === 'in';
            } else if (section === 'loans') {
                title = sensitive(record.counterparty, privateMode);
                subtitle = `${escape(labels[type])}${record.due_date ? ` · 到期 ${sensitive(record.due_date, privateMode)}` : ''}${record.note ? ` · ${sensitive(record.note, privateMode)}` : ''}`;
                amount = money(record.outstanding, record.currency, privateMode);
                secondary = `本金 ${money(record.principal, record.currency, privateMode)}`; income = type === 'lent';
            } else if (section === 'exchanges') {
                status = record.voided ? 'void' : 'recorded';
                title = `${escape(record.from_currency)} → ${escape(record.to_currency)}${record.counterparty ? ` · ${sensitive(record.counterparty, privateMode)}` : ''}`;
                subtitle = `${sensitive(record.from_account, privateMode)} → ${sensitive(record.to_account, privateMode)}${record.note || record.reference ? ` · ${sensitive(record.note || record.reference, privateMode)}` : ''}`;
                amount = `到账 ${money(record.received_amount, record.to_currency, privateMode)}`;
                secondary = `支出 ${money(record.debited_amount, record.from_currency, privateMode)}`;
            } else {
                const product = names.get(Number(record.product_id));
                title = sensitive(product?.name || '商品', privateMode);
                subtitle = `${quantity(record.quantity, privateMode)} ${sensitive(product?.unit || '件', privateMode)}${record.counterparty ? ` · ${sensitive(record.counterparty, privateMode)}` : ''}${record.note ? ` · ${sensitive(record.note, privateMode)}` : ''}`;
                amount = money(record.total, record.currency, privateMode);
                secondary = record.kind === 'opening' ? '期初成本' : record.remaining_payment > 0 ? `${record.kind === 'sale' ? '待收' : '待付'} ${money(record.remaining_payment, record.currency, privateMode)}` : '已结清';
                income = type === 'sale';
                const baseCurrency = record.base_currency || product?.currency || record.currency;
                const baseTotal = record.base_total ?? record.total;
                subtitle += `<span class="finance-row-base">库存核算 ${money(baseTotal, baseCurrency, privateMode)}${income ? ` · 毛利 ${money(record.realized_profit, baseCurrency, privateMode)}` : ''}</span>`;
            }
            const statusLabel = section === 'movements' && !record.voided ? (record.kind === 'opening' ? '期初库存' : record.status === 'unpaid' ? (income ? '未收款' : '未付款') : record.status === 'partial' ? (income ? '部分收款' : '部分付款') : income ? '已收清' : '已付清') : undefined;
            return `<article class="finance-row ${record.voided ? 'is-void' : ''}">
                <div class="finance-row-date">${sensitive(record.date, privateMode)}</div>
                <div class="finance-row-main"><div class="finance-row-title"><strong>${title}</strong>${badge(status, statusLabel)}${section === 'movements' && record.kind !== 'opening' ? badge(type) : ''}</div><div class="finance-row-note">${subtitle}</div></div>
                <div class="finance-row-money ${income ? 'is-income' : ''}"><strong>${amount}</strong><small>${secondary}</small></div>
                <button type="button" class="btn finance-detail-button" data-finance-detail="${escape(section)}" data-id="${Number(record.id)}"${privateMode ? ' disabled' : ''}>详情</button>
            </article>`;
        }).join('');
    }
    function validatePayload(type, payload, record) {
        if (type !== 'products' && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '')) return '请填写有效的记录日期。';
        const positive = key => Number.isFinite(Number(payload[key])) && Number(payload[key]) > 0;
        const nonnegative = key => Number.isFinite(Number(payload[key])) && Number(payload[key]) >= 0;
        if (type === 'transfers' && !positive('amount')) return '转账金额必须大于 0。';
        if (type === 'exchanges') {
            if (!currencies.includes(payload.from_currency) || !currencies.includes(payload.to_currency)) return '请选择支持的换出与换入币种。';
            if (payload.from_currency === payload.to_currency) return '换出与换入必须是不同币种。';
            if (!positive('from_amount') || !positive('to_amount')) return '换出金额与换入金额必须大于 0。';
            if (!nonnegative('fee_amount')) return '手续费不能为负数。';
            if (![payload.from_currency, payload.to_currency].includes(payload.fee_currency)) return '手续费币种必须是换出或换入币种。';
            if (payload.fee_currency === payload.to_currency && Number(payload.fee_amount) >= Number(payload.to_amount)) return '换入币种的手续费必须小于扣费前的换入金额。';
        }
        if (type === 'loans') {
            if (!String(payload.counterparty || '').trim()) return '请填写借款人或出借人的姓名。';
            if (!positive('principal')) return '借款本金必须大于 0。';
            if (payload.due_date && payload.due_date < payload.date) return '约定还款日期不能早于借款日期。';
            if (record && Number(payload.principal) < cleanNumber(record.repaid)) return '本金不能少于已经记录的还款金额。';
        }
        if (type === 'products' && !String(payload.name || '').trim()) return '请填写商品名称。';
        if (type === 'movements') {
            if (!payload.product_id) return '请先添加并选择商品。';
            if (!positive('quantity')) return '数量必须大于 0。';
            if (!nonnegative('unit_price')) return '单价不能为负数。';
            if (!nonnegative('paid_amount')) return '已收付金额不能为负数。';
            if (payload.currency !== undefined && !currencies.includes(payload.currency)) return '请选择美元或人民币作为货款币种。';
            if (payload.exchange_rate !== undefined && !validInventoryRate(payload.exchange_rate, payload.currency === (payload.base_currency || record?.base_currency))) return '折算汇率必须大于 0，最多保留 12 位小数；同币种汇率必须为 1。';
            if (payload.kind === 'opening' && Number(payload.paid_amount) !== 0) return '期初库存不记录付款，请将已收付金额设为 0。';
            const historicalPayments = record?.payments ? record.payments.filter(p => !p.voided).map(p => p.invoice_amount ?? p.amount) : [record ? cleanNumber(record.paid_amount) - cleanNumber(record.initial_paid_amount) : '0'];
            if (payload.kind !== 'opening' && decimalGreater(decimalSum([payload.paid_amount, ...historicalPayments]), inventoryAmount(payload.quantity, payload.unit_price))) return '已收付金额与后续收付款之和不能超过总金额。';
        }
        if (type === 'repayments' || type === 'payments') {
            if (!positive('amount')) return '收付款金额必须大于 0。';
            const outstanding = type === 'repayments' ? record?.outstanding : record?.remaining_payment;
            if (type === 'payments' && payload.currency !== undefined) {
                if (!currencies.includes(payload.currency)) return '请选择美元或人民币作为实际收付款币种。';
                if (!validInventoryRate(payload.exchange_rate, payload.currency === record?.currency)) return '折算汇率必须大于 0，最多保留 12 位小数；同币种汇率必须为 1。';
                const converted = inventoryAmount(payload.amount, payload.exchange_rate);
                if (!converted || !decimalGreater(converted, '0')) return '换算后的货款金额必须大于 0。';
                if (decimalGreater(converted, outstanding)) return '折算后的货款金额不能超过尚未结清的余额。';
            } else if (Number(payload.amount) > cleanNumber(outstanding) + 0.0000001) return '金额不能超过尚未结清的余额。';
            if (record && payload.date < record.date) return '收付款日期不能早于原记录日期。';
        }
        return '';
    }
    function createRequestTracker(makeId) {
        let fingerprint, requestId;
        return payload => {
            const next = JSON.stringify(payload);
            if (next !== fingerprint) { fingerprint = next; requestId = makeId(); }
            return requestId;
        };
    }
    function errorMessage(detail, status) {
        const messages = {
            'Record not found': '记录不存在，请刷新财务记录。',
            'This record has been voided': '这笔记录已经作废，请刷新后查看历史。',
            'This record changed; refresh and try again': '记录已被更新，请刷新并确认当前内容后再修改。',
            'Currency and unit cannot change after inventory history exists': '商品已有进出货历史，币种与数量单位不能修改。',
            'Currency and direction cannot change after repayment history exists': '借贷已有还款历史，币种与借贷方向不能修改。',
            'Product and kind cannot change after payment history exists': '已有收付款历史，不能更换商品或进出货类型。',
            'Invoice currency cannot change after payment history exists': '已有收付款历史，不能修改货款币种。可以更正库存折算汇率。',
            'Enter the exchange rate for a different currency': '不同币种请填写本次折算汇率。',
            'Exchange rate must be a positive finite number': '折算汇率必须是大于 0 的有效数字。',
            'Same-currency exchange rate must be 1': '同币种的折算汇率必须为 1。',
            'Converted payment amount must be positive': '换算后的货款金额必须大于 0。',
            'Use at most 12 decimal places for the exchange rate': '折算汇率最多保留 12 位小数。',
            'Exchange rate is too large': '折算汇率过大，请检查输入。',
            'A product with inventory history cannot be voided': '商品已有进出货历史，需要保留。可以修改名称、位置与备注。',
            'Void the repayments before voiding this loan': '请先在还款历史中作废尚有效的还款，再作废借贷记录。',
            'Void the payments before voiding this movement': '请先作废尚有效的分次收付款，再作废进出货记录。',
            'Payment date cannot precede the original record date': '收付款日期不能早于原记录日期。',
            'Repayments cannot exceed the loan principal': '累计还款不能超过借款本金。',
            'An active product already uses this SKU': '这个商品编号已被其他商品使用，请填写不同的编号。',
            'Choose an active product': '请选择尚未作废的商品。',
            'Payments cannot exceed the movement total': '累计收付款不能超过这笔货款的总金额。',
            'Paid amount cannot exceed the movement total': '已收付金额不能超过这笔货款的总金额。',
            'Opening inventory cannot have payments': '期初库存只记录数量与成本，不记录收付款。',
            'Opening inventory cannot have a payment': '期初库存只记录数量与成本，不记录收付款。',
            'Date must use YYYY-MM-DD': '请填写有效的记录日期。',
            'Record date cannot be in the future': '记录日期不能晚于今天。',
            'Due date cannot be earlier than the loan date': '约定还款日期不能早于借款日期。',
            'Unsupported currency': '请选择支持的记账币种。',
            'Amount must be a number': '金额或数量必须填写数字。',
            'Amount must be a finite number': '请填写有效的金额或数量。',
            'Amount is too large': '金额或数量过大，请检查输入。',
            'Use at most 6 decimal places': '金额与数量最多保留 6 位小数。',
            'Amount must be positive': '金额或数量必须大于 0。',
            'Financial ledger is temporarily unavailable; refresh and retry with the same request': '财务记录暂时无法保存，请保留表单并重试。',
            'Exchange currencies must be different': '换出与换入必须是不同币种。',
            'Fee currency must match the source or target currency': '手续费币种必须是换出或换入币种。',
            'Target-currency fee must be less than the gross received amount': '换入币种的手续费必须小于扣费前的换入金额。',
        };
        const translate = value => {
            const message = String(value || '').replace(/^Value error, /, '');
            if (message.startsWith('Insufficient inventory for ')) return '该日期的商品库存不足，请检查此前的进出货记录。';
            return messages[message] || (status === 409 ? '记录与已有历史冲突，请刷新并检查当前记录后重试。' : '记录未能保存，请检查输入后重试。');
        };
        return Array.isArray(detail) ? detail.map(e => translate(e.msg)).join('；') : translate(detail);
    }
    function init(config = {}) {
        if (config.demo || typeof document === 'undefined') return { load: async () => {}, refreshPrivacy() {}, setPrivate() {} };
        const $ = id => document.getElementById(id);
        if (!$('financeForm')) return null;
        let state = { transfers: [], loans: [], products: [], movements: [], exchanges: [], summary: [] };
        let section = 'transfers', loaded = false, loading = null, busy = false, editor = null, voidTarget = null, stateRevision = 0;
        let privateOverride;
        const privateMode = () => privateOverride === undefined ? Boolean(typeof config.private === 'function' ? config.private() : config.private) : privateOverride;
        const today = () => typeof config.today === 'function' ? config.today() : config.today || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
        const getModal = id => root.bootstrap.Modal.getOrCreateInstance($(id));
        const toast = message => config.toast?.(message, 'success');
        const notice = (message, isLoading = false) => {
            $('financeNotice').textContent = message;
            $('financeNotice').classList.toggle('d-none', !message);
            $('financeNotice').classList.toggle('is-loading', isLoading);
        };
        const showError = (id, message) => { $(id).textContent = message; $(id).classList.toggle('d-none', !message); };
        function applyState(data) {
            for (const key of ['transfers', 'loans', 'products', 'movements', 'exchanges', 'summary']) state[key] = Array.isArray(data[key]) ? data[key] : [];
            stateRevision += 1;
            loaded = true;
            render();
        }
        async function api(path, body, method = 'POST') {
            const response = await fetch(`/api/finance${path}`, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
            let data;
            try { data = await response.json(); } catch (_) { throw new Error('服务器没有返回有效记录。请刷新后重试。'); }
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) throw new Error('登录状态已失效，请重新登录后查看财务。');
                throw new Error(errorMessage(data.detail, response.status));
            }
            return data;
        }
        async function load(force = false) {
            if (loading) return loading;
            if (loaded && !force) return;
            notice('正在读取财务记录…', true);
            $('financeReload').disabled = true;
            const requestedRevision = stateRevision;
            loading = (async () => {
                try {
                    const data = await api('', null, 'GET');
                    if (requestedRevision === stateRevision) { applyState(data); notice(''); }
                }
                catch (error) { if (requestedRevision === stateRevision) notice(privateMode() ? '财务记录暂时无法读取，请刷新重试。' : error.message); }
                finally { $('financeReload').disabled = false; loading = null; }
            })();
            return loading;
        }
        function renderOverview() {
            const p = privateMode();
            if (!state.summary.length) {
                $('financeOverview').innerHTML = '<div class="finance-overview-empty">第一笔记录保存后，这里会按币种显示往来与余额。</div>';
                return;
            }
            const exchangeCurrencies = new Set(state.exchanges.filter(e => !e.voided).flatMap(e => [e.from_currency, e.to_currency]));
            const summaries = section === 'exchanges' ? state.summary.filter(s => exchangeCurrencies.has(s.currency)) : state.summary;
            if (!summaries.length) { $('financeOverview').innerHTML = '<div class="finance-overview-empty">保存换汇记录后，这里会按币种分别显示换入、换出与手续费。</div>'; return; }
            $('financeOverview').innerHTML = summaries.map(s => {
                const values = section === 'exchanges' ? [['换出本金（不含费）', s.exchange_out], ['换入金额（扣费前）', s.exchange_in], ['换汇手续费', s.exchange_fees], ['换汇净流动（含费）', s.exchange_net]] :
                    section === 'movements' ? [['库存成本', s.inventory_cost], ['采购待付', s.payable], ['销售待收', s.receivable], ['出货毛利', s.realized_profit]] :
                    section === 'loans' ? [['别人待还给我', s.lent_outstanding], ['我待还给别人', s.borrowed_outstanding]] :
                        [['记录的转入', s.transfer_in], ['记录的转出', s.transfer_out], ['净转入', s.transfer_net], ['库存成本', s.inventory_cost]];
                return `<div class="finance-currency-ledger"><div class="finance-currency-code">${escape(s.currency)}</div><div class="finance-currency-values">${values.map(([label, amount]) => `<div><span>${label}</span><strong>${money(amount, s.currency, p)}</strong></div>`).join('')}</div></div>`;
            }).join('');
        }
        const types = {
            transfers: { name: '转账记录', add: '记录转账', placeholder: '搜索对方、账户、备注', empty: '把重要转账记在这里', description: '记录转入、转出和自己的账户间转账。填上对方与备注，日后查找更方便。', icon: 'arrow-left-right', filters: [['', '全部类型'], ['in', '转入'], ['out', '转出'], ['internal', '账户间转账']] },
            loans: { name: '借贷往来', add: '记录借贷', placeholder: '搜索姓名、备注', empty: '清楚谁还欠谁', description: '记录你借给别人的钱，或你向别人借的钱。每次还款都能单独保存，余额会随之更新。', icon: 'people', filters: [['', '全部借贷'], ['lent', '我借给别人'], ['borrowed', '我向别人借'], ['open', '待还款'], ['partial', '部分结清'], ['settled', '已结清']] },
            movements: { name: '进出货记录', add: '记录进出货', placeholder: '搜索商品、对方、备注', empty: '从第一件商品开始', description: '先添加商品，再记录进货、出货或期初库存。已付款、未付款与分次收款都可以记录。', icon: 'box-seam', filters: [['', '全部类型'], ['purchase', '进货'], ['sale', '出货'], ['opening', '期初库存'], ['unpaid', '未收付'], ['partial', '部分收付'], ['paid', '已结清']] },
            exchanges: { name: '换汇记录', add: '记录换汇', placeholder: '搜索币种、对方、账户、备注', empty: '记下每次换汇的实际支出与到账', description: '填写换出与换入金额，记录成交汇率、手续费与账户。人民币换美元，或美元换人民币，都能清楚回看。', icon: 'currency-exchange', filters: [['', '全部换汇']] },
        };
        function render() {
            const type = types[section], p = privateMode();
            renderOverview();
            $('financeSearch').placeholder = type.placeholder;
            $('financeSearch').disabled = p;
            $('financeAdd').disabled = p || !loaded || busy;
            $('financeProducts').disabled = p || !loaded || busy;
            $('financeAdd').querySelector('span').textContent = type.add;
            $('financeProducts').classList.toggle('d-none', section !== 'movements');
            $('financeInventoryNote').classList.toggle('d-none', section !== 'movements');
            $('financeExchangeNote').classList.toggle('d-none', section !== 'exchanges');
            $('financeStatus').classList.toggle('d-none', section === 'exchanges');
            $('financeListCaption').textContent = type.name;
            const currentCurrency = $('financeCurrency').value;
            $('financeCurrency').innerHTML = '<option value="">全部币种</option>' + currencies.map(c => `<option value="${c}">${c}</option>`).join('');
            $('financeCurrency').value = currentCurrency;
            const filter = { search: p ? '' : $('financeSearch').value, currency: $('financeCurrency').value, status: $('financeStatus').value, showVoided: $('financeShowVoided').checked };
            const records = filterRecords(state[section], filter, state.products);
            $('financeCount').textContent = `${records.length} 笔`;
            if (records.length) $('financeList').innerHTML = renderRows(records, section, state.products, p);
            else {
                const filtered = Boolean(filter.search || filter.currency || filter.status);
                const title = filtered ? '没有符合筛选条件的记录' : type.empty;
                const description = filtered ? '试试其他关键词，或清除筛选条件。' : type.description;
                $('financeList').innerHTML = `<div class="finance-empty"><i class="bi bi-${type.icon}" aria-hidden="true"></i><h3>${title}</h3><p>${description}</p>${filtered ? '<button type="button" data-finance-clear class="btn btn-outline-secondary">清除筛选</button>' : `<button type="button" data-finance-new class="btn btn-primary"${p || !loaded ? ' disabled' : ''}>${section === 'movements' && !state.products.some(r => !r.voided && currencies.includes(r.currency)) ? '添加商品' : type.add}</button>`}</div>`;
            }
            if (p) $('financeCount').textContent = '隐私模式';
        }
        function changeSection(next) {
            section = next;
            document.querySelectorAll('[data-finance-section]').forEach(el => { el.classList.toggle('active', el.dataset.financeSection === section); el.setAttribute('aria-pressed', String(el.dataset.financeSection === section)); });
            $('financeStatus').innerHTML = types[section].filters.map(([value, text]) => `<option value="${value}">${text}</option>`).join('');
            $('financeSearch').value = '';
            render();
        }
        function input(name, label, value = '', options = {}) {
            const attributes = `${options.required ? ' required' : ''}${options.min !== undefined ? ` min="${escape(options.min)}"` : ''}${options.max !== undefined ? ` max="${escape(options.max)}"` : ''}${options.step ? ` step="${escape(options.step)}"` : ''}${options.disabled ? ' disabled' : ''}`;
            return `<div class="${options.wide ? 'col-12' : 'col-12 col-sm-6'}"><label class="form-label" for="financeField-${name}">${escape(label)}${options.required ? ' <span aria-hidden="true">*</span>' : ''}</label><input class="form-control" type="${options.type || 'text'}" id="financeField-${name}" name="${name}" value="${escape(value)}"${attributes}${options.type === 'text' || !options.type ? ' maxlength="500"' : ''}>${options.help ? `<div class="form-text">${escape(options.help)}</div>` : ''}</div>`;
        }
        function select(name, label, value, options, disabled = false) {
            return `<div class="col-12 col-sm-6"><label class="form-label" for="financeField-${name}">${escape(label)}</label><select class="form-select" id="financeField-${name}" name="${name}"${disabled ? ' disabled' : ''}>${options.map(([v, text]) => `<option value="${escape(v)}"${String(v) === String(value) ? ' selected' : ''}>${escape(text)}</option>`).join('')}</select></div>`;
        }
        const note = value => `<div class="col-12"><label class="form-label" for="financeField-note">备注</label><textarea class="form-control" id="financeField-note" name="note" maxlength="4000">${escape(value || '')}</textarea></div>`;
        const dateField = (value, min) => input('date', '记录日期', value || today(), { type: 'date', required: true, min, max: today() });
        const amountField = (name, label, value = '', max) => input(name, label, value, { type: 'number', min: name === 'paid_amount' || name === 'unit_price' ? 0 : '0.000001', step: 'any', required: true, max });
        const currencyField = (value = 'USD', disabled = false, label = '币种') => select('currency', label, value, currencies.map(c => [c, c]), disabled);
        const inventoryRateField = (labelId, value) => `<div class="col-12"><label class="form-label" id="${labelId}" for="financeField-exchange_rate">折算汇率</label><input class="form-control" id="financeField-exchange_rate" name="exchange_rate" type="number" step="any" min="0" required value="${escape(value ?? '')}"><div class="form-text">不同币种请填写本次约定的汇率，最多 12 位小数。</div></div>`;
        function openEditor(type, record = null, parent = null) {
            if (privateMode() || busy) return;
            const recordCurrencies = record ? type === 'exchanges' ? [record.from_currency, record.to_currency, record.fee_currency] : [record.currency, record.base_currency, type === 'movements' ? state.products.find(p => p.id === record.product_id)?.currency : null] : [];
            if (recordCurrencies.some(currency => currency && !currencies.includes(currency))) {
                getModal('financeDetailsModal').hide();
                getModal('financeEditModal').hide();
                editor = null;
                $('financeFormFields').innerHTML = '';
                $('financeFormIntro').textContent = '';
                notice('这笔历史记录含其他币种，暂不支持编辑。原币种与金额保留，可继续查看或作废。');
                return;
            }
            getModal('financeDetailsModal').hide();
            const r = record || {};
            editor = { type, record, parent, requestId: createRequestTracker(() => root.crypto.randomUUID()) };
            let fields = '', title, intro;
            if (type === 'transfers') {
                title = record ? '编辑转账' : '记录转账'; intro = '记录重要的资金往来。自己的账户间转账不计入净转入金额。';
                fields = dateField(r.date) + select('direction', '转账类型', r.direction || 'out', [['out', '转出'], ['in', '转入'], ['internal', '自己的账户间转账']]) + amountField('amount', '转账金额', r.amount) + currencyField(r.currency) + input('counterparty', '对方姓名或名称', r.counterparty) + input('method', '转账方式', r.method, { help: '例如银行转账、Zelle、现金、微信' }) + input('from_account', '转出账户', r.from_account) + input('to_account', '转入账户', r.to_account) + input('reference', '凭证或参考编号', r.reference, { wide: true }) + note(r.note);
            } else if (type === 'loans') {
                title = record ? '编辑借贷' : '记录借贷'; intro = '这里只记录本金往来。后续还款请在详情中单独记录，保留每次还款的历史。';
                const locked = Boolean(r.repayments?.length);
                fields = dateField(r.date) + select('direction', '借贷方向', r.direction || 'lent', [['lent', '我借给别人'], ['borrowed', '我向别人借']], locked) + input('counterparty', '对方姓名', r.counterparty, { required: true }) + amountField('principal', '借款本金', r.principal) + currencyField(r.currency, locked) + input('due_date', '约定还款日期（可不填）', r.due_date || '', { type: 'date' }) + note(r.note);
            } else if (type === 'products') {
                title = record ? '编辑商品' : '添加商品'; intro = record ? '商品已有进出货历史后，库存核算币种与数量单位不能修改。数量通过进出货记录维护。' : '选择商品库存与毛利的核算币种。每笔进出货的货款和后续收付款可以使用不同币种。';
                const locked = Boolean(record && state.movements.some(m => m.product_id === r.id));
                fields = input('name', '商品名称', r.name, { required: true }) + input('sku', '商品编号（可不填）', r.sku) + input('unit', '数量单位', r.unit || '件', { required: true, disabled: locked }) + currencyField(r.currency, locked, '库存核算币种') + input('location', '存放位置（可不填）', r.location, { wide: true }) + note(r.note);
            } else if (type === 'movements') {
                const availableProducts = state.products.filter(p => !p.voided && currencies.includes(p.currency));
                if (!availableProducts.length) { openEditor('products'); return; }
                title = record ? '编辑进出货' : '记录进出货'; intro = '单价与最初已收付金额使用货款币种。库存与毛利折算到商品的库存核算币种；后续分次收付款保留在详情历史中。';
                const product = availableProducts.find(p => p.id === r.product_id) || availableProducts[0];
                const locked = Boolean(r.payments?.length);
                if (locked) intro += ' 已有收付款历史，货款币种不可修改，库存折算汇率仍可更正。';
                const invoiceCurrency = r.currency || product.currency;
                const rate = r.exchange_rate ?? (invoiceCurrency === product.currency ? '1' : '');
                fields = dateField(r.date) + select('kind', '记录类型', r.kind || 'purchase', [['purchase', '进货'], ['sale', '出货'], ['opening', '期初库存']], locked) + select('product_id', '商品', r.product_id || product.id, availableProducts.map(p => [p.id, `${p.name} · 核算 ${p.currency} / ${p.unit}`]), locked) + amountField('quantity', '数量', r.quantity) + currencyField(invoiceCurrency, locked, '货款币种') + amountField('unit_price', '每单位价格 / 成本（货款币种）', r.unit_price) + amountField('paid_amount', record ? '最初已收付金额（货款币种）' : '已收付金额（货款币种）', record ? r.initial_paid_amount : 0) + inventoryRateField('financeMovementRateLabel', rate) +
                    '<div class="col-12"><div class="finance-inventory-preview" aria-live="polite"><div><span>原币种货款总额</span><strong id="financeMovementTotal">—</strong></div><div><span>折算库存核算金额</span><strong id="financeMovementBaseTotal">—</strong></div><p id="financeMovementHint"></p></div></div>' + input('counterparty', '供应商或客户（可不填）', r.counterparty) + note(r.note);
            } else if (type === 'exchanges') {
                title = record ? '编辑换汇' : '记录换汇';
                intro = '填写两笔成交金额，自动得到汇率；也可填写换出金额与汇率，自动计算换入金额。手续费单独记录，避免重复扣费。';
                const from = r.from_currency || 'USD', to = r.to_currency || 'CNY';
                editor.rateMode = false;
                fields = dateField(r.date) + input('counterparty', '换汇对方或机构（可不填）', r.counterparty) +
                    select('from_currency', '换出币种', from, currencies.map(c => [c, c])) + amountField('from_amount', '换出金额（不含手续费）', r.from_amount) +
                    select('to_currency', '换入币种', to, currencies.map(c => [c, c])) + amountField('to_amount', '换入金额（扣费前）', r.to_amount) +
                    '<div class="col-12"><label class="finance-exchange-rate-label" for="financeField-exchange_rate" id="financeExchangeRateLabel">成交汇率</label><input class="form-control" type="number" step="any" min="0" id="financeField-exchange_rate" name="exchange_rate"><div class="finance-exchange-rate-help" id="financeExchangeRateHelp"></div></div>' +
                    input('fee_amount', '手续费（可为 0）', r.fee_amount ?? 0, { type: 'number', min: 0, step: 'any', required: true }) +
                    select('fee_currency', '手续费币种', r.fee_currency || from, [[from, from], [to, to]]) +
                    '<div class="col-12"><div class="finance-exchange-preview" aria-live="polite"><div><span>实际支出</span><strong id="financeExchangeDebit">—</strong></div><div><span>实际到账</span><strong id="financeExchangeReceipt">—</strong></div><p id="financeExchangeEffectiveRate"></p></div></div>' +
                    input('from_account', '换出账户（可不填）', r.from_account) + input('to_account', '换入账户（可不填）', r.to_account) +
                    input('method', '换汇方式（可不填）', r.method, { help: '例如银行换汇、现金、线上换汇' }) + input('reference', '凭证或参考编号（可不填）', r.reference) + note(r.note);
            } else {
                const isLoan = type === 'repayments', isReceiving = isLoan ? parent.direction === 'lent' : parent.kind === 'sale';
                title = isLoan ? (isReceiving ? '记录收到的还款' : '记录我的还款') : (isReceiving ? '记录收款' : '记录付款');
                const remaining = isLoan ? parent.outstanding : parent.remaining_payment;
                intro = `尚未结清 ${money(remaining, parent.currency)}。填写本次金额，可以记录部分或全部结清。`;
                if (!isLoan && currencies.includes(parent.currency)) {
                    intro = `尚未结清的货款为 ${money(remaining, parent.currency)}。实际收付款可以使用另一币种，按本次汇率折抵货款。`;
                    fields = dateField(today(), parent.date) + currencyField(parent.currency, false, '实际收付款币种') + amountField('amount', `本次实际${isReceiving ? '收到' : '支付'}金额`, remaining) + inventoryRateField('financePaymentRateLabel', '1') + '<div class="col-12"><div class="finance-inventory-preview finance-payment-preview" aria-live="polite"><div><span>折抵货款金额</span><strong id="financePaymentInvoiceAmount">—</strong></div><p id="financePaymentHint"></p></div></div>' + note('');
                } else fields = dateField(today(), parent.date) + amountField('amount', `本次${isReceiving ? '收到' : '支付'}金额（${parent.currency}）`, remaining, remaining) + note('');
            }
            $('financeEditTitle').textContent = title;
            $('financeFormIntro').textContent = intro;
            $('financeFormFields').innerHTML = fields;
            $('financeSave').textContent = record ? '保存修改' : '保存记录';
            $('financeSave').disabled = false;
            showError('financeFormError', '');
            if (type === 'movements') updateMovementTotal();
            if (type === 'exchanges') updateExchangePreview();
            if (type === 'payments') updatePaymentPreview();
            getModal('financeEditModal').show();
        }
        function updateMovementTotal(event) {
            if (editor?.type !== 'movements') return;
            const read = name => $('financeForm').elements.namedItem(name)?.value;
            const product = state.products.find(p => p.id === Number(read('product_id')));
            const invoiceCurrency = read('currency');
            const quote = $('financeForm').elements.namedItem('exchange_rate');
            if (product && ['currency', 'product_id'].includes(event?.target?.name)) quote.value = invoiceCurrency === product.currency ? '1' : '';
            quote.disabled = invoiceCurrency === product?.currency;
            if (quote.disabled) quote.value = '1';
            const originalTotal = inventoryAmount(read('quantity'), read('unit_price'));
            const baseTotal = validInventoryRate(quote.value, quote.disabled) ? inventoryAmount(originalTotal, quote.value) : null;
            $('financeMovementTotal').textContent = originalTotal !== null ? money(originalTotal, invoiceCurrency) : '—';
            $('financeMovementBaseTotal').textContent = product && baseTotal !== null ? money(baseTotal, product.currency) : '待填写汇率';
            $('financeMovementRateLabel').textContent = `库存折算汇率：1 ${invoiceCurrency} = 多少 ${product?.currency || '库存核算币种'}`;
            const opening = read('kind') === 'opening';
            const paid = $('financeForm').elements.namedItem('paid_amount');
            paid.disabled = opening;
            if (opening) paid.value = 0;
            $('financeMovementHint').textContent = `${product ? `库存核算币种 ${product.currency}；当前库存 ${quantity(product.quantity)} ${product.unit}。` : ''}${opening ? '期初库存只记录数量与成本，不记录货款收付。' : `货款与最初已收付金额使用 ${invoiceCurrency}；${read('kind') === 'sale' ? '出货毛利按库存核算币种的移动平均成本计算。' : '后续收付款可在详情中继续记录。'}`}`;
        }
        function updatePaymentPreview(event) {
            if (editor?.type !== 'payments' || !currencies.includes(editor.parent.currency)) return;
            const field = name => $('financeForm').elements.namedItem(name);
            const paymentCurrency = field('currency').value, invoiceCurrency = editor.parent.currency;
            const quote = field('exchange_rate');
            if (event?.target?.name === 'currency') quote.value = paymentCurrency === invoiceCurrency ? '1' : '';
            quote.disabled = paymentCurrency === invoiceCurrency;
            if (quote.disabled) quote.value = '1';
            const converted = validInventoryRate(quote.value, quote.disabled) ? inventoryAmount(field('amount').value, quote.value) : null;
            $('financePaymentRateLabel').textContent = `货款折抵汇率：1 ${paymentCurrency} = 多少 ${invoiceCurrency}`;
            $('financePaymentInvoiceAmount').textContent = converted !== null ? money(converted, invoiceCurrency) : '待填写汇率';
            $('financePaymentHint').textContent = `本次实际收付使用 ${paymentCurrency}；只按折算后的 ${invoiceCurrency} 金额抵扣待收或待付货款。尚未结清 ${money(editor.parent.remaining_payment, invoiceCurrency)}。`;
        }
        function updateExchangePreview(event) {
            if (editor?.type !== 'exchanges') return;
            const field = name => $('financeForm').elements.namedItem(name);
            const from = field('from_currency').value, to = field('to_currency').value;
            const changed = event?.target?.name;
            const quoteField = field('exchange_rate');
            if (changed === 'exchange_rate') editor.rateMode = true;
            if (['to_amount', 'from_currency', 'to_currency'].includes(changed)) editor.rateMode = false;
            if (editor.rateMode && ['exchange_rate', 'from_amount'].includes(changed)) {
                const computed = amountFromRate(field('from_amount').value, quoteField.value);
                if (computed !== null) field('to_amount').value = computed;
            }
            const feeField = field('fee_currency');
            const previousFeeCurrency = feeField.value;
            feeField.innerHTML = [...new Set([from, to])].map(c => `<option value="${escape(c)}">${escape(c)}</option>`).join('');
            feeField.value = [from, to].includes(previousFeeCurrency) ? previousFeeCurrency : from;
            const values = { from_currency: from, to_currency: to, from_amount: field('from_amount').value, to_amount: field('to_amount').value, fee_amount: field('fee_amount').value, fee_currency: feeField.value };
            const derived = exchangeAmounts(values);
            if (!editor.rateMode) quoteField.value = derived.exchange_rate > 0 ? String(Number(derived.exchange_rate.toPrecision(12))) : '';
            $('financeExchangeRateLabel').textContent = `成交汇率：1 ${from} = 多少 ${to}`;
            $('financeExchangeRateHelp').textContent = derived.exchange_rate > 0 ? `1 ${from} = ${formatRate(derived.exchange_rate)} ${to}；反向：1 ${to} = ${formatRate(derived.inverse_rate)} ${from}。以上汇率不含手续费。` : `按 ${from} 换成 ${to} 的方向填写。也可以直接填写两笔金额，计算成交汇率。`;
            $('financeExchangeDebit').textContent = cleanNumber(values.from_amount) > 0 ? money(derived.debited_amount, from) : '—';
            $('financeExchangeReceipt').textContent = cleanNumber(values.to_amount) > 0 ? money(derived.received_amount, to) : '—';
            $('financeExchangeEffectiveRate').textContent = derived.exchange_rate > 0 && derived.received_amount > 0 ? `含手续费的实际汇率：1 ${from} = ${formatRate(derived.effective_rate)} ${to}。${feeField.value === from ? '手续费加在换出金额上。' : '手续费从换入金额中扣除。'}` : '实际支出与实际到账只计一次手续费。';
        }
        function updateEditorPreview(event) { updateMovementTotal(event); updateExchangePreview(event); updatePaymentPreview(event); }
        function payloadForEditor() {
            const f = new FormData($('financeForm'));
            const get = key => String(f.get(key) || '').trim();
            const { type, record, parent } = editor;
            if (type === 'exchanges' && editor.rateMode && (!Number.isFinite(Number(get('exchange_rate'))) || Number(get('exchange_rate')) <= 0)) throw new Error('汇率必须大于 0；也可以直接填写换入金额。');
            let payload;
            if (type === 'transfers') payload = Object.fromEntries(['date', 'direction', 'currency', 'counterparty', 'from_account', 'to_account', 'method', 'reference', 'note'].map(k => [k, get(k)]));
            else if (type === 'loans') payload = Object.fromEntries(['date', 'direction', 'counterparty', 'currency', 'note'].map(k => [k, get(k)]));
            else if (type === 'products') payload = Object.fromEntries(['name', 'sku', 'unit', 'location', 'note'].map(k => [k, get(k)]));
            else if (type === 'movements') payload = Object.fromEntries(['date', 'kind', 'counterparty', 'note'].map(k => [k, get(k)]));
            else if (type === 'exchanges') payload = Object.fromEntries(['date', 'from_currency', 'to_currency', 'from_amount', 'to_amount', 'fee_amount', 'fee_currency', 'from_account', 'to_account', 'counterparty', 'method', 'reference', 'note'].map(k => [k, get(k)]));
            else payload = { date: get('date'), amount: get('amount'), note: get('note') };
            if (type === 'transfers') payload.amount = get('amount');
            if (type === 'loans') { payload.principal = get('principal'); payload.due_date = get('due_date') || null; payload.direction = get('direction') || record?.direction; payload.currency = get('currency') || record?.currency; }
            if (type === 'products') { payload.currency = get('currency') || record?.currency || 'USD'; payload.unit = get('unit') || record?.unit || '件'; }
            if (type === 'movements') { payload.kind = get('kind') || record?.kind; payload.product_id = Number(get('product_id') || record?.product_id); payload.quantity = get('quantity'); payload.unit_price = get('unit_price'); payload.paid_amount = payload.kind === 'opening' ? '0' : get('paid_amount'); payload.currency = get('currency') || record?.currency; payload.exchange_rate = get('exchange_rate') || ($('financeForm').elements.namedItem('exchange_rate')?.disabled ? '1' : ''); }
            if (type === 'payments' && currencies.includes(parent.currency)) { payload.currency = get('currency'); payload.exchange_rate = get('exchange_rate') || ($('financeForm').elements.namedItem('exchange_rate')?.disabled ? '1' : ''); }
            const validationRecord = type === 'movements' ? { ...record, base_currency: state.products.find(p => p.id === payload.product_id)?.currency } : parent || record;
            const error = validatePayload(type, payload, validationRecord);
            if (error) throw new Error(error);
            if (record) payload.version = record.version;
            else payload.request_id = editor.requestId(payload);
            return payload;
        }
        async function save(event) {
            event.preventDefault();
            if (busy || !editor || privateMode()) return;
            let payload;
            try { payload = payloadForEditor(); } catch (error) { showError('financeFormError', error.message); return; }
            const current = editor;
            const path = current.type === 'repayments' ? `/loans/${current.parent.id}/repayments` : current.type === 'payments' ? `/movements/${current.parent.id}/payments` : `/${current.type}${current.record ? `/${current.record.id}` : ''}`;
            busy = true; $('financeSave').disabled = true; $('financeSave').textContent = '正在保存…'; showError('financeFormError', '');
            try {
                const data = await api(path, payload, current.record ? 'PUT' : 'POST');
                busy = false;
                applyState(data);
                getModal('financeEditModal').hide();
                editor = null; $('financeFormFields').innerHTML = ''; $('financeFormIntro').textContent = '';
                notice(''); toast(current.record ? '修改已保存' : '记录已保存');
            } catch (error) {
                if (privateMode()) { showError('financeFormError', ''); notice('保存结果暂未确认，请刷新记录后检查。'); }
                else showError('financeFormError', error.message);
            } finally {
                busy = false; $('financeSave').disabled = false; $('financeSave').textContent = current.record ? '保存修改' : '保存记录'; render();
            }
        }
        function detailField(label, value, wide = false) { return `<div${wide ? ' class="finance-wide"' : ''}><dt>${escape(label)}</dt><dd>${value}</dd></div>`; }
        function showDetails(type, id) {
            if (privateMode()) return;
            const r = state[type]?.find(r => r.id === id);
            if (!r) return;
            const p = privateMode(), text = value => sensitive(value, p), cash = value => money(value, r.currency, p);
            const movementStatus = type === 'movements' && !r.voided ? r.kind === 'opening' ? '期初库存' : r.status === 'unpaid' ? (r.kind === 'sale' ? '未收款' : '未付款') : r.status === 'partial' ? (r.kind === 'sale' ? '部分收款' : '部分付款') : (r.kind === 'sale' ? '已收清' : '已付清') : undefined;
            let fields = [detailField('日期', text(r.date)), detailField('状态', badge(r.voided ? 'void' : r.status || r.direction, movementStatus))];
            if (type === 'transfers') {
                fields.push(detailField('转账类型', escape(labels[r.direction])), detailField('金额', cash(r.amount)), detailField('对方', text(r.counterparty)), detailField('转账方式', text(r.method)), detailField('转出账户', text(r.from_account)), detailField('转入账户', text(r.to_account)), detailField('凭证或参考编号', text(r.reference), true));
            } else if (type === 'loans') {
                fields.push(detailField('借贷方向', escape(labels[r.direction])), detailField('对方', text(r.counterparty)), detailField('本金', cash(r.principal)), detailField('已还本金', cash(r.repaid)), detailField(r.direction === 'lent' ? '别人还欠我' : '我还欠别人', cash(r.outstanding)), detailField('约定还款日期', text(r.due_date)));
            } else if (type === 'exchanges') {
                fields[1] = detailField('状态', badge(r.voided ? 'void' : 'recorded'));
                fields.push(detailField('换汇方向', `${escape(r.from_currency)} → ${escape(r.to_currency)}`),
                    detailField('换汇对方或机构', text(r.counterparty)),
                    detailField('换出金额（不含手续费）', money(r.from_amount, r.from_currency, p)), detailField('换入金额（扣费前）', money(r.to_amount, r.to_currency, p)),
                    detailField('手续费', money(r.fee_amount, r.fee_currency, p)), detailField('实际支出', money(r.debited_amount, r.from_currency, p)), detailField('实际到账', money(r.received_amount, r.to_currency, p)),
                    detailField('成交汇率（不含费）', `1 ${escape(r.from_currency)} = ${formatRate(r.exchange_rate, p)} ${escape(r.to_currency)}`),
                    detailField('反向成交汇率（不含费）', `1 ${escape(r.to_currency)} = ${formatRate(r.inverse_rate, p)} ${escape(r.from_currency)}`),
                    detailField('实际汇率（含手续费）', `1 ${escape(r.from_currency)} = ${formatRate(r.effective_rate, p)} ${escape(r.to_currency)}`),
                    detailField('换出账户', text(r.from_account)), detailField('换入账户', text(r.to_account)), detailField('换汇方式', text(r.method)), detailField('凭证或参考编号', text(r.reference)));
            } else {
                const product = state.products.find(p => p.id === r.product_id);
                const baseCurrency = r.base_currency || product?.currency || r.currency;
                const baseCash = value => money(value, baseCurrency, p);
                fields.push(detailField('记录类型', escape(labels[r.kind])), detailField('商品', text(product?.name)), detailField('数量', `${quantity(r.quantity, p)} ${text(product?.unit)}`), detailField('单位价格 / 成本（货款币种）', cash(r.unit_price)), detailField('原币种货款总额', cash(r.total)), detailField('库存核算币种', escape(baseCurrency)), detailField('库存折算汇率', `1 ${escape(r.currency)} = ${formatRate(r.exchange_rate ?? 1, p)} ${escape(baseCurrency)}`), detailField('折算库存核算金额', baseCash(r.base_total ?? r.total)), detailField('最初已收付（货款币种）', cash(r.initial_paid_amount)), detailField(r.kind === 'sale' ? '累计已收款（折抵货款）' : '累计已付款（折抵货款）', cash(r.paid_amount)), detailField(r.kind === 'sale' ? '待收货款' : '待付货款', cash(r.remaining_payment)), detailField('供应商或客户', text(r.counterparty)));
                if (r.kind === 'sale') fields.push(detailField('出货成本（库存核算币种）', baseCash(r.cost_of_goods)), detailField('出货毛利（库存核算币种）', baseCash(r.realized_profit)));
            }
            fields.push(detailField('备注', text(r.note), true));
            let history = '';
            if (type === 'loans' || type === 'movements') {
                const nested = type === 'loans' ? 'repayments' : 'payments';
                const title = type === 'loans' ? '还款历史' : '分次收付款历史';
                history = `<div class="finance-history"><h6>${title}</h6>${(r[nested] || []).length ? r[nested].map(payment => {
                    const paymentCurrency = payment.currency || r.currency;
                    const conversion = type === 'movements' ? `<small class="finance-history-conversion">折抵 ${money(payment.invoice_amount ?? payment.amount, payment.invoice_currency || r.currency, p)}；1 ${escape(paymentCurrency)} = ${formatRate(payment.exchange_rate ?? 1, p)} ${escape(payment.invoice_currency || r.currency)}</small>` : '';
                    return `<div class="finance-history-row"><span>${text(payment.date)}</span><span>${text(payment.note)}${payment.voided ? ` ${badge('void')}` : ''}${conversion}</span><strong>${money(payment.amount, type === 'movements' ? paymentCurrency : r.currency, p)}</strong>${!r.voided && !payment.voided ? `<button type="button" class="btn btn-outline-secondary" data-finance-void="${nested}" data-id="${payment.id}" data-parent="${r.id}">作废</button>` : '<span></span>'}</div>`;
                }).join('') : '<p class="small text-muted mb-0">尚未记录分次收付款。</p>'}${type === 'movements' ? '<p class="finance-private-note mt-3 mb-0">折抵金额只计入一次货款余额。出货毛利不包含后续收付款产生的汇兑损益。</p>' : ''}</div>`;
            }
            $('financeDetailsTitle').textContent = `${types[type].name}详情`;
            $('financeDetailsBody').innerHTML = `<dl class="finance-detail-grid">${fields.join('')}</dl>${history}${r.voided ? '<p class="finance-private-note mt-4 mb-0">这笔记录已作废，保留在历史中，不计入余额与汇总。</p>' : ''}`;
            const remaining = type === 'loans' ? r.outstanding : r.remaining_payment;
            const receiptLabel = type === 'loans' ? '记录还款' : r.kind === 'sale' ? '记录收款' : '记录付款';
            $('financeDetailsActions').innerHTML = r.voided ? '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>' : `<button type="button" class="btn btn-outline-danger me-auto" data-finance-void="${type}" data-id="${r.id}">作废记录</button><button type="button" class="btn btn-outline-secondary" data-finance-edit="${type}" data-id="${r.id}">编辑</button>${remaining > 0 && (type === 'loans' || (type === 'movements' && r.kind !== 'opening')) ? `<button type="button" class="btn btn-primary" data-finance-payment="${type}" data-id="${r.id}">${receiptLabel}</button>` : ''}`;
            getModal('financeDetailsModal').show();
        }
        function showProducts() {
            if (privateMode() || busy) return;
            const records = state.products.filter(p => $('financeShowVoided').checked || !p.voided);
            $('financeDetailsTitle').textContent = '商品库存';
            $('financeDetailsBody').innerHTML = '<div class="finance-product-toolbar"><p class="small text-muted mb-0">平均成本与库存成本均使用商品的库存核算币种。</p><button type="button" class="btn btn-sm btn-primary" data-finance-product-new>添加商品</button></div>' + (records.length ? records.map(p => {
                const hasHistory = state.movements.some(m => m.product_id === p.id);
                const actions = p.voided ? '' : `<div class="d-flex gap-1"><button type="button" class="btn btn-outline-secondary" data-finance-edit="products" data-id="${p.id}">编辑</button>${hasHistory ? '' : `<button type="button" class="btn btn-outline-secondary" data-finance-void="products" data-id="${p.id}">作废</button>`}</div>`;
                return `<section class="finance-product-row"><div class="finance-product-title"><strong>${escape(p.name)} ${p.voided ? badge('void') : ''}</strong>${actions}</div><p>库存核算币种 ${escape(p.currency)} · ${escape(p.sku || '未填写编号')} · ${escape(p.location || '未填写位置')}${p.note ? ` · ${escape(p.note)}` : ''}</p><div class="finance-product-values"><span>库存 <strong>${quantity(p.quantity)} ${escape(p.unit)}</strong></span><span>平均成本 <strong>${money(p.average_cost, p.currency)}</strong></span><span>库存成本 <strong>${money(p.inventory_cost, p.currency)}</strong></span></div>${!currencies.includes(p.currency) ? '<p class="mb-0">历史商品保留供查账，不新增进出货。</p>' : hasHistory ? '<p class="mb-0">已有进出货历史，保留商品供日后查账。</p>' : ''}</section>`;
            }).join('') : '<div class="finance-empty"><i class="bi bi-box-seam" aria-hidden="true"></i><h3>还没有商品</h3><p>添加商品后，就能记录进出货并查看库存。</p></div>');
            $('financeDetailsActions').innerHTML = '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>';
            getModal('financeDetailsModal').show();
        }
        function findVoid(type, id, parentId) {
            if (type === 'repayments' || type === 'payments') {
                const parentType = type === 'repayments' ? 'loans' : 'movements';
                const parent = state[parentType].find(r => r.id === parentId);
                return { record: parent?.[type]?.find(p => p.id === id), parent, parentType };
            }
            return { record: state[type]?.find(r => r.id === id) };
        }
        function openVoid(type, id, parentId) {
            if (privateMode() || busy) return;
            const target = findVoid(type, id, parentId);
            if (!target.record || target.record.voided) return;
            voidTarget = { ...target, type, id };
            getModal('financeDetailsModal').hide();
            const explanations = {
                transfers: '作废后，这笔转账不再计入转入、转出与净额。原记录仍保存在历史中。',
                exchanges: '作废后，这笔换汇不再计入各币种的换入、换出、手续费与净流动。原记录与成交汇率仍保存在历史中。',
                loans: '请先在还款历史中作废尚有效的还款，再作废这笔借贷。作废后的借贷不计入待还余额，原记录与还款历史仍会保留。',
                products: '商品作废后不再出现在可选商品中。已有任何进出货历史的商品不能作废，可以编辑名称、位置与备注。',
                movements: '请先作废尚有效的分次收付款。作废后会重新计算库存、货款余额与出货毛利。如果造成库存不足，需要先处理后续出货。所有历史仍会保留。',
                repayments: '作废这次还款后，尚未偿还的本金会增加。原还款仍保存在历史中。',
                payments: '作废这次收付款后，待收或待付的货款会增加。原收付款仍保存在历史中。',
            };
            $('financeVoidMessage').textContent = explanations[type];
            showError('financeVoidError', ''); $('financeVoidConfirm').disabled = false;
            getModal('financeVoidModal').show();
        }
        async function confirmVoid() {
            if (busy || !voidTarget || privateMode()) return;
            const target = voidTarget;
            busy = true; $('financeVoidConfirm').disabled = true; $('financeVoidConfirm').textContent = '正在作废…';
            try {
                const path = target.parent ? `/${target.parentType}/${target.parent.id}/${target.type}/${target.id}` : `/${target.type}/${target.id}`;
                const data = await api(`${path}?version=${target.record.version}`, null, 'DELETE');
                busy = false; applyState(data); getModal('financeVoidModal').hide(); voidTarget = null;
                notice('');
                toast('记录已作废，历史已保留');
            } catch (error) {
                if (privateMode()) { showError('financeVoidError', ''); notice('作废结果暂未确认，请刷新记录后检查。'); }
                else showError('financeVoidError', error.message);
            }
            finally { busy = false; $('financeVoidConfirm').disabled = false; $('financeVoidConfirm').textContent = '确认作废'; render(); }
        }
        function handleAction(event) {
            const button = event.target.closest('button');
            if (!button || button.disabled) return;
            const d = button.dataset, id = Number(d.id);
            if (d.financeSection) changeSection(d.financeSection);
            else if (d.financeDetail) showDetails(d.financeDetail, id);
            else if (d.financeEdit) openEditor(d.financeEdit, state[d.financeEdit].find(r => r.id === id));
            else if (d.financePayment) openEditor(d.financePayment === 'loans' ? 'repayments' : 'payments', null, state[d.financePayment].find(r => r.id === id));
            else if (d.financeVoid) openVoid(d.financeVoid, id, Number(d.parent));
            else if ('financeProductNew' in d) openEditor('products');
            else if ('financeNew' in d) openEditor(section === 'movements' && !state.products.some(r => !r.voided && currencies.includes(r.currency)) ? 'products' : section);
            else if ('financeClear' in d) { $('financeSearch').value = ''; $('financeCurrency').value = ''; $('financeStatus').value = ''; render(); }
        }
        function refreshPrivacy() {
            if (privateMode()) {
                $('financeSearch').value = '';
                for (const id of ['financeEditModal', 'financeDetailsModal', 'financeVoidModal']) getModal(id).hide();
                $('financeFormFields').innerHTML = ''; $('financeFormIntro').textContent = ''; $('financeDetailsBody').innerHTML = ''; $('financeDetailsActions').innerHTML = '';
                showError('financeFormError', ''); showError('financeVoidError', '');
                $('financeVoidMessage').textContent = '';
                editor = null; voidTarget = null;
                notice('');
            }
            render();
        }
        document.querySelector('.finance-workspace').addEventListener('click', handleAction);
        $('financeDetailsModal').addEventListener('click', handleAction);
        $('financeReload').addEventListener('click', () => load(true));
        $('financeProducts').addEventListener('click', showProducts);
        $('financeAdd').addEventListener('click', () => openEditor(section));
        ['financeSearch', 'financeCurrency', 'financeStatus', 'financeShowVoided'].forEach(id => $(id).addEventListener(id === 'financeSearch' ? 'input' : 'change', render));
        $('financeForm').addEventListener('submit', save);
        $('financeForm').addEventListener('input', updateEditorPreview);
        $('financeForm').addEventListener('change', updateEditorPreview);
        $('financeVoidConfirm').addEventListener('click', confirmVoid);
        ['financeEditModal', 'financeVoidModal'].forEach(id => $(id).addEventListener('hide.bs.modal', event => { if (busy && !privateMode()) event.preventDefault(); }));
        changeSection('transfers');
        return { load, refreshPrivacy, setPrivate(value) { privateOverride = Boolean(value); refreshPrivacy(); } };
    }
    const api = { init, escape, money, quantity, formatRate, amountFromRate, inventoryAmount, decimalSum, decimalGreater, exchangeAmounts, filterRecords, renderRows, validatePayload, createRequestTracker, errorMessage };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FinanceUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
