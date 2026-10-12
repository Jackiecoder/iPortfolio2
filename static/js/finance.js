(function (root) {
    'use strict';
    const currencies = ['USD', 'CNY', 'HKD', 'EUR', 'GBP', 'CAD', 'JPY', 'AUD'];
    const labels = { in: '转入', out: '转出', internal: '账户间转账', lent: '我借给别人', borrowed: '我向别人借',
        purchase: '进货', sale: '出货', opening: '期初库存', open: '待还款', partial: '部分结清', settled: '已结清', unpaid: '未付款', paid: '已付清', void: '已作废' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cleanNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const quantity = (value, privateMode = false) => privateMode ? '***' : cleanNumber(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
    const money = (value, currency = 'USD', privateMode = false) => privateMode ? '***' : `${escape(currency)} ${cleanNumber(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
    const sensitive = (value, privateMode) => privateMode ? '***' : escape(value || '—');
    function badge(status, label) {
        const style = status === 'void' ? 'is-void' : ['settled', 'paid', 'in', 'sale'].includes(status) ? 'is-good' : ['open', 'partial', 'unpaid'].includes(status) ? 'is-open' : '';
        return `<span class="finance-badge ${style}">${escape(label || labels[status] || status)}</span>`;
    }
    function filterRecords(records, filter = {}, products = []) {
        const names = new Map(products.map(p => [Number(p.id), p.name]));
        const query = String(filter.search || '').trim().toLocaleLowerCase();
        return records.filter(record => {
            if (!filter.showVoided && record.voided) return false;
            if (filter.currency && record.currency !== filter.currency) return false;
            if (filter.status && record.status !== filter.status && record.direction !== filter.status && record.kind !== filter.status) return false;
            if (!query) return true;
            return [record.counterparty, record.from_account, record.to_account, record.reference, record.method, record.note,
                record.date, record.currency, names.get(Number(record.product_id))].some(v => String(v || '').toLocaleLowerCase().includes(query));
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
            } else {
                const product = names.get(Number(record.product_id));
                title = sensitive(product?.name || '商品', privateMode);
                subtitle = `${quantity(record.quantity, privateMode)} ${sensitive(product?.unit || '件', privateMode)}${record.counterparty ? ` · ${sensitive(record.counterparty, privateMode)}` : ''}${record.note ? ` · ${sensitive(record.note, privateMode)}` : ''}`;
                amount = money(record.total, record.currency, privateMode);
                secondary = record.kind === 'opening' ? '期初成本' : record.remaining_payment > 0 ? `${record.kind === 'sale' ? '待收' : '待付'} ${money(record.remaining_payment, record.currency, privateMode)}` : '已结清';
                income = type === 'sale';
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
            if (payload.kind === 'opening' && Number(payload.paid_amount) !== 0) return '期初库存不记录付款，请将已收付金额设为 0。';
            const historicalPayments = record ? cleanNumber(record.paid_amount) - cleanNumber(record.initial_paid_amount) : 0;
            if (payload.kind !== 'opening' && Number(payload.paid_amount) + historicalPayments > Number(payload.quantity) * Number(payload.unit_price) + 0.0000001) return '已收付金额与后续收付款之和不能超过总金额。';
        }
        if (type === 'repayments' || type === 'payments') {
            if (!positive('amount')) return '收付款金额必须大于 0。';
            const outstanding = type === 'repayments' ? record?.outstanding : record?.remaining_payment;
            if (Number(payload.amount) > cleanNumber(outstanding) + 0.0000001) return '金额不能超过尚未结清的余额。';
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
        let state = { transfers: [], loans: [], products: [], movements: [], summary: [] };
        let section = 'transfers', loaded = false, loading = null, busy = false, editor = null, voidTarget = null;
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
            for (const key of ['transfers', 'loans', 'products', 'movements', 'summary']) state[key] = Array.isArray(data[key]) ? data[key] : [];
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
            loading = (async () => {
                try { applyState(await api('', null, 'GET')); notice(''); }
                catch (error) { notice(privateMode() ? '财务记录暂时无法读取，请刷新重试。' : error.message); }
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
            $('financeOverview').innerHTML = state.summary.map(s => {
                const values = section === 'movements' ? [['库存成本', s.inventory_cost], ['采购待付', s.payable], ['销售待收', s.receivable], ['出货毛利', s.realized_profit]] :
                    section === 'loans' ? [['别人待还给我', s.lent_outstanding], ['我待还给别人', s.borrowed_outstanding]] :
                        [['记录的转入', s.transfer_in], ['记录的转出', s.transfer_out], ['净转入', s.transfer_net], ['库存成本', s.inventory_cost]];
                return `<div class="finance-currency-ledger"><div class="finance-currency-code">${escape(s.currency)}</div><div class="finance-currency-values">${values.map(([label, amount]) => `<div><span>${label}</span><strong>${money(amount, s.currency, p)}</strong></div>`).join('')}</div></div>`;
            }).join('');
        }
        const types = {
            transfers: { name: '转账记录', add: '记录转账', placeholder: '搜索对方、账户、备注', empty: '把重要转账记在这里', description: '记录转入、转出和自己的账户间转账。填上对方与备注，日后查找更方便。', icon: 'arrow-left-right', filters: [['', '全部类型'], ['in', '转入'], ['out', '转出'], ['internal', '账户间转账']] },
            loans: { name: '借贷往来', add: '记录借贷', placeholder: '搜索姓名、备注', empty: '清楚谁还欠谁', description: '记录你借给别人的钱，或你向别人借的钱。每次还款都能单独保存，余额会随之更新。', icon: 'people', filters: [['', '全部借贷'], ['lent', '我借给别人'], ['borrowed', '我向别人借'], ['open', '待还款'], ['partial', '部分结清'], ['settled', '已结清']] },
            movements: { name: '进出货记录', add: '记录进出货', placeholder: '搜索商品、对方、备注', empty: '从第一件商品开始', description: '先添加商品，再记录进货、出货或期初库存。已付款、未付款与分次收款都可以记录。', icon: 'box-seam', filters: [['', '全部类型'], ['purchase', '进货'], ['sale', '出货'], ['opening', '期初库存'], ['unpaid', '未收付'], ['partial', '部分收付'], ['paid', '已结清']] },
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
                $('financeList').innerHTML = `<div class="finance-empty"><i class="bi bi-${type.icon}" aria-hidden="true"></i><h3>${title}</h3><p>${description}</p>${filtered ? '<button type="button" data-finance-clear class="btn btn-outline-secondary">清除筛选</button>' : `<button type="button" data-finance-new class="btn btn-primary"${p || !loaded ? ' disabled' : ''}>${section === 'movements' && !state.products.some(r => !r.voided) ? '添加商品' : type.add}</button>`}</div>`;
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
        const currencyField = (value = 'USD', disabled = false) => select('currency', '币种', value, currencies.map(c => [c, c]), disabled);
        function openEditor(type, record = null, parent = null) {
            if (privateMode() || busy) return;
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
                title = record ? '编辑商品' : '添加商品'; intro = record ? '商品已有进出货历史后，币种与数量单位不能修改。数量通过进出货记录维护。' : '为商品选择一个记账币种。数量与成本会根据进出货记录自动更新。';
                const locked = Boolean(record && state.movements.some(m => m.product_id === r.id));
                fields = input('name', '商品名称', r.name, { required: true }) + input('sku', '商品编号（可不填）', r.sku) + input('unit', '数量单位', r.unit || '件', { required: true, disabled: locked }) + currencyField(r.currency, locked) + input('location', '存放位置（可不填）', r.location, { wide: true }) + note(r.note);
            } else if (type === 'movements') {
                if (!state.products.some(p => !p.voided)) { openEditor('products'); return; }
                title = record ? '编辑进出货' : '记录进出货'; intro = record ? '已收付金额填写这笔记录最初的收付款。后续的分次收付款保留在详情历史中。' : '选择商品后沿用商品币种。可以先记货款，再补充每次付款或收款。';
                const product = state.products.find(p => p.id === r.product_id) || state.products.find(p => !p.voided);
                const locked = Boolean(r.payments?.length);
                fields = dateField(r.date) + select('kind', '记录类型', r.kind || 'purchase', [['purchase', '进货'], ['sale', '出货'], ['opening', '期初库存']], locked) + select('product_id', '商品', r.product_id || product.id, state.products.filter(p => !p.voided).map(p => [p.id, `${p.name} · ${p.currency} / ${p.unit}`]), locked) + amountField('quantity', '数量', r.quantity) + amountField('unit_price', '每单位价格 / 成本', r.unit_price) + amountField('paid_amount', record ? '最初已收付金额' : '已收付金额', record ? r.initial_paid_amount : 0) + input('counterparty', '供应商或客户（可不填）', r.counterparty) + '<div class="col-12 col-sm-6"><label class="form-label">总金额</label><div class="form-control bg-light" id="financeMovementTotal" aria-live="polite">—</div><div class="form-text" id="financeMovementHint"></div></div>' + note(r.note);
            } else {
                const isLoan = type === 'repayments', isReceiving = isLoan ? parent.direction === 'lent' : parent.kind === 'sale';
                title = isLoan ? (isReceiving ? '记录收到的还款' : '记录我的还款') : (isReceiving ? '记录收款' : '记录付款');
                const remaining = isLoan ? parent.outstanding : parent.remaining_payment;
                intro = `尚未结清 ${money(remaining, parent.currency)}。填写本次金额，可以记录部分或全部结清。`;
                fields = dateField(today(), parent.date) + amountField('amount', `本次${isReceiving ? '收到' : '支付'}金额（${parent.currency}）`, remaining, remaining) + note('');
            }
            $('financeEditTitle').textContent = title;
            $('financeFormIntro').textContent = intro;
            $('financeFormFields').innerHTML = fields;
            $('financeSave').textContent = record ? '保存修改' : '保存记录';
            $('financeSave').disabled = false;
            showError('financeFormError', '');
            if (type === 'movements') updateMovementTotal();
            getModal('financeEditModal').show();
        }
        function updateMovementTotal() {
            if (editor?.type !== 'movements') return;
            const read = name => $('financeForm').elements.namedItem(name)?.value;
            const product = state.products.find(p => p.id === Number(read('product_id')));
            $('financeMovementTotal').textContent = product ? money(cleanNumber(read('quantity')) * cleanNumber(read('unit_price')), product.currency) : '—';
            const opening = read('kind') === 'opening';
            const paid = $('financeForm').elements.namedItem('paid_amount');
            paid.disabled = opening;
            if (opening) paid.value = 0;
            $('financeMovementHint').textContent = opening ? '期初库存只记录数量与成本，不记录货款收付。' : `当前库存 ${quantity(product?.quantity)} ${product?.unit || '件'}；${read('kind') === 'sale' ? '出货按移动平均成本计算毛利。' : '未付的货款可以在详情中继续记录。'}`;
        }
        function payloadForEditor() {
            const f = new FormData($('financeForm'));
            const get = key => String(f.get(key) || '').trim();
            const { type, record, parent } = editor;
            let payload;
            if (type === 'transfers') payload = Object.fromEntries(['date', 'direction', 'currency', 'counterparty', 'from_account', 'to_account', 'method', 'reference', 'note'].map(k => [k, get(k)]));
            else if (type === 'loans') payload = Object.fromEntries(['date', 'direction', 'counterparty', 'currency', 'note'].map(k => [k, get(k)]));
            else if (type === 'products') payload = Object.fromEntries(['name', 'sku', 'unit', 'location', 'note'].map(k => [k, get(k)]));
            else if (type === 'movements') payload = Object.fromEntries(['date', 'kind', 'counterparty', 'note'].map(k => [k, get(k)]));
            else payload = { date: get('date'), amount: get('amount'), note: get('note') };
            if (type === 'transfers') payload.amount = get('amount');
            if (type === 'loans') { payload.principal = get('principal'); payload.due_date = get('due_date') || null; payload.direction = get('direction') || record?.direction; payload.currency = get('currency') || record?.currency; }
            if (type === 'products') { payload.currency = get('currency') || record?.currency || 'USD'; payload.unit = get('unit') || record?.unit || '件'; }
            if (type === 'movements') { payload.kind = get('kind') || record?.kind; payload.product_id = Number(get('product_id') || record?.product_id); payload.quantity = get('quantity'); payload.unit_price = get('unit_price'); payload.paid_amount = payload.kind === 'opening' ? '0' : get('paid_amount'); }
            const error = validatePayload(type, payload, parent || record);
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
            } else {
                const product = state.products.find(p => p.id === r.product_id);
                fields.push(detailField('记录类型', escape(labels[r.kind])), detailField('商品', text(product?.name)), detailField('数量', `${quantity(r.quantity, p)} ${text(product?.unit)}`), detailField('单位价格 / 成本', cash(r.unit_price)), detailField('总金额', cash(r.total)), detailField('最初已收付', cash(r.initial_paid_amount)), detailField(r.kind === 'sale' ? '累计已收款' : '累计已付款', cash(r.paid_amount)), detailField(r.kind === 'sale' ? '待收金额' : '待付金额', cash(r.remaining_payment)), detailField('供应商或客户', text(r.counterparty)));
                if (r.kind === 'sale') fields.push(detailField('出货成本', cash(r.cost_of_goods)), detailField('出货毛利', cash(r.realized_profit)));
            }
            fields.push(detailField('备注', text(r.note), true));
            let history = '';
            if (type === 'loans' || type === 'movements') {
                const nested = type === 'loans' ? 'repayments' : 'payments';
                const title = type === 'loans' ? '还款历史' : '分次收付款历史';
                history = `<div class="finance-history"><h6>${title}</h6>${(r[nested] || []).length ? r[nested].map(payment => `<div class="finance-history-row"><span>${text(payment.date)}</span><span>${text(payment.note)}${payment.voided ? ` ${badge('void')}` : ''}</span><strong>${cash(payment.amount)}</strong>${!r.voided && !payment.voided ? `<button type="button" class="btn btn-outline-secondary" data-finance-void="${nested}" data-id="${payment.id}" data-parent="${r.id}">作废</button>` : '<span></span>'}</div>`).join('') : '<p class="small text-muted mb-0">尚未记录分次收付款。</p>'}</div>`;
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
            $('financeDetailsBody').innerHTML = '<div class="finance-product-toolbar"><p class="small text-muted mb-0">数量、平均成本与库存成本随进出货更新。</p><button type="button" class="btn btn-sm btn-primary" data-finance-product-new>添加商品</button></div>' + (records.length ? records.map(p => {
                const hasHistory = state.movements.some(m => m.product_id === p.id);
                const actions = p.voided ? '' : `<div class="d-flex gap-1"><button type="button" class="btn btn-outline-secondary" data-finance-edit="products" data-id="${p.id}">编辑</button>${hasHistory ? '' : `<button type="button" class="btn btn-outline-secondary" data-finance-void="products" data-id="${p.id}">作废</button>`}</div>`;
                return `<section class="finance-product-row"><div class="finance-product-title"><strong>${escape(p.name)} ${p.voided ? badge('void') : ''}</strong>${actions}</div><p>${escape(p.sku || '未填写编号')} · ${escape(p.location || '未填写位置')}${p.note ? ` · ${escape(p.note)}` : ''}</p><div class="finance-product-values"><span>库存 <strong>${quantity(p.quantity)} ${escape(p.unit)}</strong></span><span>平均成本 <strong>${money(p.average_cost, p.currency)}</strong></span><span>库存成本 <strong>${money(p.inventory_cost, p.currency)}</strong></span></div>${hasHistory ? '<p class="mb-0">已有进出货历史，保留商品供日后查账。</p>' : ''}</section>`;
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
            else if ('financeNew' in d) openEditor(section === 'movements' && !state.products.some(r => !r.voided) ? 'products' : section);
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
        $('financeForm').addEventListener('input', updateMovementTotal);
        $('financeForm').addEventListener('change', updateMovementTotal);
        $('financeVoidConfirm').addEventListener('click', confirmVoid);
        ['financeEditModal', 'financeVoidModal'].forEach(id => $(id).addEventListener('hide.bs.modal', event => { if (busy && !privateMode()) event.preventDefault(); }));
        changeSection('transfers');
        return { load, refreshPrivacy, setPrivate(value) { privateOverride = Boolean(value); refreshPrivacy(); } };
    }
    const api = { init, escape, money, quantity, filterRecords, renderRows, validatePayload, createRequestTracker, errorMessage };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FinanceUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
