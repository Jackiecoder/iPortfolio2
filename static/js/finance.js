(function (root) {
    'use strict';
    const currencies = ['USD', 'CNY'];
    const actorTypes = new Set(['transfers', 'loans', 'movements', 'exchanges', 'repayments', 'payments']);
    const labels = { in: '转入', out: '转出', internal: '账户间转账', lent: '我借给别人', borrowed: '我向别人借',
        purchase: '进货', sale: '销售', expense: '费用', opening: '期初库存', exchange: '换汇', recorded: '已记录', planned: '分红计划', open: '待还款', partial: '部分结清', settled: '已结清', unpaid: '未付款', paid: '已付清', void: '已作废' };
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
    function decimalUnits(value, precision = 6) {
        const parts = decimalParts(value);
        if (!parts) return null;
        if (parts.scale <= precision) return parts.coefficient * 10n ** BigInt(precision - parts.scale);
        const divisor = 10n ** BigInt(parts.scale - precision), remainder = parts.coefficient % divisor;
        let units = parts.coefficient / divisor;
        if (remainder * 2n > divisor || remainder * 2n === divisor && units % 2n === 1n) units += 1n;
        return units;
    }
    function decimalFromUnits(units, precision = 6) {
        if (units === null) return null;
        const negative = units < 0n;
        const digits = (negative ? -units : units).toString().padStart(precision + 1, '0');
        return (negative ? '-' : '') + (precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}`.replace(/\.?0+$/, '') : digits);
    }
    function inventoryUnitPrice(total, amount) {
        const a = decimalParts(total), b = decimalParts(amount);
        if (!a || !b || b.coefficient === 0n) return null;
        const numerator = a.coefficient * 10n ** BigInt(b.scale + 6);
        const denominator = b.coefficient * 10n ** BigInt(a.scale);
        let units = numerator / denominator;
        const remainder = numerator % denominator;
        if (remainder * 2n > denominator || remainder * 2n === denominator && units % 2n === 1n) units += 1n;
        return decimalFromUnits(units);
    }
    function allocateDecimal(total, weights) {
        const units = decimalUnits(total), portions = weights.map(v => decimalUnits(v));
        if (units === null || portions.some(v => v === null)) return null;
        const denominator = portions.reduce((sum, value) => sum + value, 0n);
        if (denominator === 0n) return portions.map(() => '0');
        const shares = portions.map((weight, index) => ({ index, amount: units * weight / denominator, remainder: units * weight % denominator }));
        const remaining = units - shares.reduce((sum, share) => sum + share.amount, 0n);
        const ranked = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
        for (let i = 0; i < Number(remaining); i += 1) ranked[i].amount += 1n;
        return shares.map(share => decimalFromUnits(share.amount));
    }
    function projectPreview(project) {
        const participants = project.participants || [];
        const baseAmounts = participants.map(p => validInventoryRate(p.exchange_rate ?? ((p.currency || project.currency) === project.currency ? '1' : ''), (p.currency || project.currency) === project.currency) ? inventoryAmount(p.contribution_amount, p.exchange_rate ?? '1') : null);
        const total = baseAmounts.some(v => v === null) ? null : decimalSum(baseAmounts);
        const contributionPercents = total === null ? baseAmounts.map(() => null) : allocateDecimal('100', baseAmounts);
        const dividendTotal = decimalSum(participants.map(p => p.dividend_percent));
        const remainder = dividendTotal === null ? null : 100000000n - decimalUnits(dividendTotal);
        const unallocatedPercent = decimalFromUnits(remainder);
        const knownProfit = project.expected_profit !== null && project.expected_profit !== undefined && project.expected_profit !== '';
        const dividends = knownProfit && remainder !== null && remainder >= 0n ? allocateDecimal(project.expected_profit, [...participants.map(p => p.dividend_percent), unallocatedPercent]) : null;
        return { total_contribution: total, dividend_percent_total: dividendTotal, unallocated_percent: unallocatedPercent,
            unallocated_profit: dividends ? dividends.at(-1) : null, allocation_complete: remainder === 0n,
            participants: participants.map((p, i) => ({ ...p, base_amount: baseAmounts[i], contribution_percent: contributionPercents?.[i] ?? null, expected_dividend: dividends?.[i] ?? null })) };
    }
    function validProjectDecimal(value) {
        const parts = decimalParts(value);
        if (!parts) return false;
        while (parts.scale > 0 && parts.coefficient % 10n === 0n) { parts.coefficient /= 10n; parts.scale -= 1; }
        return parts.scale <= 6;
    }
    function projectNumber(value, minimumFractionDigits = 0, privateMode = false) {
        if (privateMode) return '***';
        const negative = String(value ?? '').startsWith('-');
        const units = decimalUnits(negative ? String(value).slice(1) : value);
        if (units === null) return '—';
        const digits = units.toString().padStart(7, '0');
        const whole = digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        const fraction = digits.slice(-6).replace(/0+$/, '').padEnd(minimumFractionDigits, '0');
        return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
    }
    const projectMoney = (value, currency, privateMode = false) => privateMode ? '***' : `${escape(currency)} ${projectNumber(value, 2)}`;
    function projectSnapshot(record) {
        const inputs = record.request_fields || record;
        const fallback = projectPreview(inputs), calculated = record.calculation_fields || {};
        return { ...record, ...inputs, ...fallback, ...calculated,
            participants: fallback.participants.map((participant, index) => ({ ...participant, ...(calculated.participants?.[index] || {}) })) };
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
    function actorLine(record, privateMode, scope = '') {
        if (!record.payer && !record.recipient) return '';
        return `${escape(scope)}付款人 ${sensitive(record.payer || '未填写', privateMode)} → 收款人 ${sensitive(record.recipient || '未填写', privateMode)}`;
    }
    function filterRecords(records, filter = {}, products = [], projects = []) {
        const names = new Map(products.map(p => [Number(p.id), p.name]));
        const projectNames = new Map(projects.map(p => [Number(p.id), p.name]));
        const query = String(filter.search || '').trim().toLocaleLowerCase();
        return records.filter(record => {
            if (!filter.showVoided && record.voided) return false;
            if (filter.currency && ![record.currency, record.base_currency, record.from_currency, record.to_currency, ...(record.participants || []).map(p => p.currency)].includes(filter.currency)) return false;
            if (filter.status && record.status !== filter.status && record.direction !== filter.status && record.kind !== filter.status) return false;
            if (!query) return true;
            return [record.name, record.counterparty, record.payer, record.recipient, record.handler, record.category, record.from_account, record.to_account, record.reference, record.method, record.note,
                record.date, record.currency, record.base_currency, record.from_currency, record.to_currency, names.get(Number(record.product_id)), record.project_name, projectNames.get(Number(record.project_id)), ...(record.participants || []).flatMap(p => [p.name, p.note, p.currency]), ...[...(record.repayments || []), ...(record.payments || [])].flatMap(payment => [payment.payer, payment.recipient, payment.handler, payment.note])].some(v => String(v || '').toLocaleLowerCase().includes(query));
        }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id));
    }
    function filterProducts(products, movements, filter = {}, projects = []) {
        const query = String(filter.search || '').trim().toLocaleLowerCase();
        return products.filter(product => {
            if (!filter.showVoided && product.voided) return false;
            const related = movements.filter(record => Number(record.product_id) === Number(product.id));
            const active = related.filter(record => !record.voided);
            if (filter.currency && product.currency !== filter.currency && !active.some(record => record.currency === filter.currency)) return false;
            if (filter.status === 'stocked' && !(cleanNumber(product.quantity) > 0)) return false;
            if (filter.status === 'empty' && cleanNumber(product.quantity) > 0) return false;
            if (['purchase', 'sale', 'expense'].includes(filter.status) && !active.some(record => record.kind === filter.status)) return false;
            if (!query) return true;
            return [product.name, product.sku, product.location, product.note, product.currency].some(value => String(value || '').toLocaleLowerCase().includes(query)) || filterRecords(related, { search: query, showVoided: filter.showVoided }, products, projects).length > 0;
        }).sort((a, b) => Number(b.id) - Number(a.id));
    }
    function renderProductCards(products, privateMode = false) {
        return products.map(product => {
            const value = name => money(product[name], product.currency, privateMode);
            const unitCost = product.acquired_quantity !== undefined && !cleanNumber(product.acquired_quantity) ? (privateMode ? '***' : '待进货') : value('average_cost');
            return `<article class="finance-product-card ${product.voided ? 'is-void' : ''}"><div class="finance-product-card-heading"><div><h3>${sensitive(product.name, privateMode)}</h3><p>${sensitive(product.sku || '未填写编号', privateMode)}${product.location ? ` · ${sensitive(product.location, privateMode)}` : ''} · 核算 ${escape(product.currency)}</p></div>${product.voided ? badge('void') : ''}</div><dl class="finance-product-card-values"><div><dt>当前库存</dt><dd>${quantity(product.quantity, privateMode)} ${sensitive(product.unit || '件', privateMode)}</dd></div><div><dt>累计成本</dt><dd>${value('total_cost')}</dd></div><div><dt>等效单位成本</dt><dd>${unitCost}</dd></div><div><dt>已售利润</dt><dd class="${cleanNumber(product.realized_profit) >= 0 ? 'is-income' : ''}">${value('realized_profit')}</dd></div></dl><button type="button" class="btn btn-outline-secondary finance-profile-button" data-finance-detail="products" data-id="${Number(product.id)}"${privateMode ? ' disabled' : ''}>查看商品与交易<i class="bi bi-chevron-right" aria-hidden="true"></i></button></article>`;
        }).join('');
    }
    function isZeroPriceSale(record) {
        return record.kind === 'sale' && decimalParts(record.unit_price)?.coefficient === 0n;
    }
    function renderRows(records, section, products = [], privateMode = false, projects = []) {
        const names = new Map(products.map(p => [Number(p.id), p]));
        const projectNames = new Map(projects.map(p => [Number(p.id), p.name]));
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
            } else if (section === 'projects') {
                const project = projectSnapshot(record);
                status = record.voided ? 'void' : 'planned';
                title = sensitive(project.name, privateMode);
                subtitle = `${(project.participants || []).map(p => sensitive(p.name, privateMode)).join(' · ')}<span class="finance-row-base">计划分红 ${projectNumber(project.dividend_percent_total, 0, privateMode)}%；待分配 ${projectNumber(project.unallocated_percent, 0, privateMode)}%</span>`;
                amount = `总出资 ${projectMoney(project.total_contribution, project.currency, privateMode)}`;
                secondary = project.expected_profit === null || project.expected_profit === undefined ? '预计利润未填写' : `预计利润 ${projectMoney(project.expected_profit, project.currency, privateMode)}`;
            } else {
                const product = names.get(Number(record.product_id));
                title = sensitive(record.kind === 'expense' ? record.category || '费用' : product?.name || '商品', privateMode);
                subtitle = `${record.kind === 'expense' ? '计入商品成本' : `${quantity(record.quantity, privateMode)} ${sensitive(product?.unit || '件', privateMode)} · 均价 ${money(record.unit_price, record.currency, privateMode)}`}${record.counterparty ? ` · ${sensitive(record.counterparty, privateMode)}` : ''}${record.note ? ` · ${sensitive(record.note, privateMode)}` : ''}`;
                amount = money(record.total, record.currency, privateMode);
                secondary = isZeroPriceSale(record) && !privateMode ? '无需收款' : record.kind === 'opening' ? '期初成本' : record.remaining_payment > 0 ? `${record.kind === 'sale' ? '待收' : '待付'} ${money(record.remaining_payment, record.currency, privateMode)}` : '已结清';
                income = type === 'sale';
                const baseCurrency = record.base_currency || product?.currency || record.currency;
                const baseTotal = record.base_total ?? record.total;
                subtitle += `<span class="finance-row-base">库存核算 ${money(baseTotal, baseCurrency, privateMode)}${income ? ` · 毛利 ${money(record.realized_profit, baseCurrency, privateMode)}` : ''}</span>`;
                if (record.project_id) subtitle += `<span class="finance-row-project">项目 ${sensitive(record.project_name || projectNames.get(Number(record.project_id)), privateMode)}</span>`;
                if (record.handler) subtitle += `<span class="finance-row-actors">经手人 ${sensitive(record.handler, privateMode)}</span>`;
            }
            const actors = actorTypes.has(section) ? actorLine(record, privateMode, section === 'loans' ? '本金：' : section === 'movements' ? '最初收付：' : section === 'exchanges' ? '换出 / 换入：' : '') : '';
            if (actors) subtitle += `<span class="finance-row-actors">${actors}</span>`;
            const statusLabel = section === 'movements' && !record.voided ? (isZeroPriceSale(record) && !privateMode ? '无需收款' : record.kind === 'opening' ? '期初库存' : record.status === 'unpaid' ? (income ? '未收款' : '未付款') : record.status === 'partial' ? (income ? '部分收款' : '部分付款') : income ? '已收清' : '已付清') : undefined;
            return `<article class="finance-row ${record.voided ? 'is-void' : ''}">
                <div class="finance-row-date">${sensitive(record.date, privateMode)}</div>
                <div class="finance-row-main"><div class="finance-row-title"><strong>${title}</strong>${badge(status, statusLabel)}${section === 'movements' && record.kind !== 'opening' ? badge(type, isZeroPriceSale(record) && !privateMode ? '赠送 / 零价出货' : undefined) : ''}</div><div class="finance-row-note">${subtitle}</div></div>
                <div class="finance-row-money ${income ? 'is-income' : ''}"><strong>${amount}</strong><small>${secondary}</small></div>
                <button type="button" class="btn finance-detail-button" data-finance-detail="${escape(section)}" data-id="${Number(record.id)}"${privateMode ? ' disabled' : ''}>详情</button>
            </article>`;
        }).join('');
    }
    function validatePayload(type, payload, record) {
        if (type !== 'products' && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '')) return '请填写有效的记录日期。';
        if (actorTypes.has(type) && ['payer', 'recipient'].some(field => Array.from(String(payload[field] || '')).length > 200)) return '付款人与收款人姓名最多填写 200 个字符。';
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
        if (type === 'projects') {
            if (!String(payload.name || '').trim()) return '请填写项目名称。';
            if (!currencies.includes(payload.currency)) return '请选择美元或人民币作为项目核算币种。';
            if (payload.expected_profit !== null && !validProjectDecimal(payload.expected_profit)) return '预计可分配利润必须是非负数字，最多保留 6 位小数。';
            if (!Array.isArray(payload.participants) || !payload.participants.length || payload.participants.length > 50) return '每个项目需要 1 至 50 位参与人。';
            const names = new Set();
            for (const p of payload.participants) {
                const name = String(p.name || '').trim().toLocaleLowerCase();
                if (!name) return '请填写每位参与人的姓名。';
                if (names.has(name)) return '参与人姓名不能重复。';
                names.add(name);
                if (!validProjectDecimal(p.contribution_amount)) return '出资金额必须是非负数字，最多保留 6 位小数。';
                if (!currencies.includes(p.currency)) return '请选择每位参与人的出资币种。';
                if (!validInventoryRate(p.exchange_rate, p.currency === payload.currency)) return '请填写正确的出资折算汇率，最多保留 12 位小数；同币种为 1。';
                if (decimalGreater(p.contribution_amount, '0') && !decimalGreater(inventoryAmount(p.contribution_amount, p.exchange_rate), '0')) return '折算后的出资金额必须大于 0，请检查金额与汇率。';
                if (!validProjectDecimal(p.dividend_percent) || decimalGreater(p.dividend_percent, '100')) return '计划分红比例必须在 0% 至 100% 之间，最多保留 6 位小数。';
            }
            if (decimalGreater(decimalSum(payload.participants.map(p => p.dividend_percent)), '100')) return '所有参与人的计划分红比例合计不能超过 100%。';
        }
        if (type === 'movements') {
            if (!payload.product_id) return '请先添加并选择商品。';
            if (Array.from(String(payload.handler || '')).length > 200) return '经手人姓名最多填写 200 个字符。';
            if (payload.kind === 'expense') {
                if (!String(payload.category || '').trim()) return '请填写费用类别，例如物流、包装或其他自定义类别。';
                if (Array.from(String(payload.category)).length > 100) return '费用类别最多填写 100 个字符。';
                if (!positive('total_amount')) return '费用金额必须大于 0。';
            } else {
                if (!positive('quantity')) return '数量必须大于 0。';
                if (payload.total_amount !== undefined ? !nonnegative('total_amount') : !nonnegative('unit_price')) return payload.total_amount !== undefined ? '总价不能为负数。' : '单价不能为负数。';
            }
            if (!nonnegative('paid_amount')) return '已收付金额不能为负数。';
            if (payload.currency !== undefined && !currencies.includes(payload.currency)) return '请选择美元或人民币作为货款币种。';
            if (payload.exchange_rate !== undefined && !validInventoryRate(payload.exchange_rate, payload.currency === (payload.base_currency || record?.base_currency))) return '折算汇率必须大于 0，最多保留 12 位小数；同币种汇率必须为 1。';
            if (payload.kind === 'opening' && Number(payload.paid_amount) !== 0) return '期初库存不记录付款，请将已收付金额设为 0。';
            const historicalPayments = record?.payments ? record.payments.filter(p => !p.voided).map(p => p.invoice_amount ?? p.amount) : [record ? cleanNumber(record.paid_amount) - cleanNumber(record.initial_paid_amount) : '0'];
            const total = payload.total_amount !== undefined ? payload.total_amount : inventoryAmount(payload.quantity, payload.unit_price);
            if (payload.kind !== 'opening' && decimalGreater(decimalSum([payload.paid_amount, ...historicalPayments]), total)) return '已收付金额与后续收付款之和不能超过总金额。';
        }
        if (type === 'repayments' || type === 'payments') {
            if (type === 'payments' && Array.from(String(payload.handler || '')).length > 200) return '经手人姓名最多填写 200 个字符。';
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
            'Expenses use a total amount without quantity or unit price': '费用只填写金额，不填写数量与均价。',
            'Expense amount must be positive': '费用金额必须大于 0。',
            'Enter an expense category': '请填写费用类别。',
            'Enter an expense category and total amount': '请填写费用类别与费用金额。',
            'Enter the transaction quantity': '请填写商品交易数量。',
            'Enter a unit price or total amount': '请填写均价或总价。',
            'Unit price and total amount do not match': '均价与总价不一致，请选择一种金额填写方式。',
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
            'Participant names must be unique': '参与人姓名不能重复。',
            'Dividend percentages cannot exceed 100 in total': '所有参与人的计划分红比例合计不能超过 100%。',
            'Converted contribution amount must be positive': '折算后的出资金额必须大于 0，请检查金额与汇率。',
            'Project currency cannot change after creation': '项目核算币种保存后固定，不能修改。',
            'Unlink or void the active movements before voiding this project': '请先解除关联或作废项目下仍有效的进出货，再作废项目。',
            'Choose an active project': '请选择尚未作废的项目。',
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
        let state = { transfers: [], loans: [], products: [], movements: [], exchanges: [], projects: [], summary: [] };
        let section = 'transfers', loaded = false, loading = null, busy = false, editor = null, voidTarget = null, stateRevision = 0, returnProductId = null;
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
        function updateSummaryHint() {
            const hint = $('financeSummaryHint');
            if (hint) hint.textContent = $('financeSummary')?.open ? '收起' : '展开';
        }
        function applyState(data) {
            for (const key of ['transfers', 'loans', 'products', 'movements', 'exchanges', 'projects', 'summary']) state[key] = Array.isArray(data[key]) ? data[key] : [];
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
            if (section === 'projects') {
                const active = state.projects.filter(project => !project.voided).map(projectSnapshot);
                if (!active.length) { $('financeOverview').innerHTML = '<div class="finance-overview-empty">记录合资项目后，这里会分别显示各币种的出资与预计利润。</div>'; return; }
                $('financeOverview').innerHTML = [...new Set(active.map(project => project.currency))].map(currency => {
                    const projects = active.filter(project => project.currency === currency);
                    const supplied = projects.filter(project => project.expected_profit !== null && project.expected_profit !== undefined);
                    const missing = projects.length - supplied.length;
                    const amounts = [['项目总出资', projectMoney(decimalSum(projects.map(project => project.total_contribution)), currency, p)],
                        [supplied.length && missing ? '已填预计利润（不含本金）' : '预计利润（不含本金）', supplied.length ? projectMoney(decimalSum(supplied.map(project => project.expected_profit)), currency, p) : '未填写']];
                    return `<div class="finance-currency-ledger"><div class="finance-currency-code">${escape(currency)}</div><div class="finance-currency-values">${amounts.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}<p class="finance-project-overview-note">${missing ? `${p ? '***' : missing} 个项目未填写预计利润。` : ''}分红计划是估算，不计入已实现收益。</p></div></div>`;
                }).join('');
                return;
            }
            if (!state.summary.length) {
                $('financeOverview').innerHTML = '<div class="finance-overview-empty">第一笔记录保存后，这里会按币种显示往来与余额。</div>';
                return;
            }
            const exchangeCurrencies = new Set(state.exchanges.filter(e => !e.voided).flatMap(e => [e.from_currency, e.to_currency]));
            const summaries = section === 'exchanges' ? state.summary.filter(s => exchangeCurrencies.has(s.currency)) : state.summary;
            if (!summaries.length) { $('financeOverview').innerHTML = '<div class="finance-overview-empty">保存换汇记录后，这里会按币种分别显示换入、换出与手续费。</div>'; return; }
            $('financeOverview').innerHTML = summaries.map(s => {
                const values = section === 'exchanges' ? [['换出本金（不含费）', s.exchange_out], ['换入金额（扣费前）', s.exchange_in], ['换汇手续费', s.exchange_fees], ['换汇净流动（含费）', s.exchange_net]] :
                    section === 'movements' ? [['库存成本', s.inventory_cost], ['采购及费用待付', s.payable], ['销售待收', s.receivable], ['已售利润', s.realized_profit]] :
                    section === 'loans' ? [['别人待还给我', s.lent_outstanding], ['我待还给别人', s.borrowed_outstanding]] :
                        [['记录的转入', s.transfer_in], ['记录的转出', s.transfer_out], ['净转入', s.transfer_net], ['库存成本', s.inventory_cost]];
                return `<div class="finance-currency-ledger"><div class="finance-currency-code">${escape(s.currency)}</div><div class="finance-currency-values">${values.map(([label, amount]) => `<div><span>${label}</span><strong>${money(amount, s.currency, p)}</strong></div>`).join('')}</div></div>`;
            }).join('');
        }
        const types = {
            transfers: { name: '转账记录', add: '记录转账', placeholder: '搜索对方、付款人、收款人、账户', empty: '把重要转账记在这里', description: '记录转入、转出和自己的账户间转账。填上对方与备注，日后查找更方便。', icon: 'arrow-left-right', filters: [['', '全部类型'], ['in', '转入'], ['out', '转出'], ['internal', '账户间转账']] },
            loans: { name: '借贷往来', add: '记录借贷', placeholder: '搜索姓名、付款人、收款人、备注', empty: '清楚谁还欠谁', description: '记录你借给别人的钱，或你向别人借的钱。每次还款都能单独保存，余额会随之更新。', icon: 'people', filters: [['', '全部借贷'], ['lent', '我借给别人'], ['borrowed', '我向别人借'], ['open', '待还款'], ['partial', '部分结清'], ['settled', '已结清']] },
            products: { name: '商品', add: '创建商品', icon: 'box-seam' },
            movements: { name: '商品与交易', add: '创建商品', placeholder: '搜索商品、费用类别、经手人、收付人', empty: '先创建一个商品', description: '在商品下记录进货、物流与其他费用，再记录销售。成本、库存与利润会自动汇总。', icon: 'box-seam', filters: [['', '全部商品'], ['stocked', '有库存'], ['empty', '暂无库存'], ['purchase', '含进货交易'], ['sale', '含销售交易'], ['expense', '含费用交易']] },
            exchanges: { name: '换汇记录', add: '记录换汇', placeholder: '搜索付款人、收款人、对方、账户', empty: '记下每次换汇的实际支出与到账', description: '填写换出与换入金额，记录成交汇率、手续费与账户。人民币换美元，或美元换人民币，都能清楚回看。', icon: 'currency-exchange', filters: [['', '全部换汇']] },
            projects: { name: '合资项目', add: '添加项目', placeholder: '搜索项目、参与人、备注', empty: '一起出资，把分红计划记清楚', description: '分别记录每位参与人的出资与约定分红比例。可以先留出待分配份额，预计利润也可以暂不填写。', icon: 'diagram-3', filters: [['', '全部项目']] },
        };
        function render() {
            const type = types[section], p = privateMode();
            renderOverview();
            $('financeSearch').placeholder = type.placeholder;
            $('financeSearch').disabled = p;
            $('financeAdd').disabled = p || !loaded || busy;
            $('financeProducts').disabled = p || !loaded || busy;
            $('financeAdd').querySelector('span').textContent = type.add;
            $('financeProducts').classList.toggle('d-none', true);
            $('financeList').classList.toggle('finance-product-list', section === 'movements');
            $('financeInventoryNote').classList.toggle('d-none', section !== 'movements');
            $('financeExchangeNote').classList.toggle('d-none', section !== 'exchanges');
            $('financeProjectNote').classList.toggle('d-none', section !== 'projects');
            $('financeStatus').classList.toggle('d-none', ['exchanges', 'projects'].includes(section));
            $('financeListCaption').textContent = type.name;
            const currentCurrency = $('financeCurrency').value;
            $('financeCurrency').innerHTML = '<option value="">全部币种</option>' + currencies.map(c => `<option value="${c}">${c}</option>`).join('');
            $('financeCurrency').value = currentCurrency;
            const filter = { search: p ? '' : $('financeSearch').value, currency: $('financeCurrency').value, status: $('financeStatus').value, showVoided: $('financeShowVoided').checked };
            const records = section === 'movements' ? filterProducts(state.products, state.movements, filter, state.projects) : filterRecords(state[section], filter, state.products, state.projects);
            $('financeCount').textContent = `${records.length} ${['projects', 'movements'].includes(section) ? '个' : '笔'}`;
            if (records.length) $('financeList').innerHTML = section === 'movements' ? renderProductCards(records, p) : renderRows(records, section, state.products, p, state.projects);
            else {
                const filtered = Boolean(filter.search || filter.currency || filter.status);
                const title = filtered ? '没有符合筛选条件的记录' : type.empty;
                const description = filtered ? '试试其他关键词，或清除筛选条件。' : type.description;
                $('financeList').innerHTML = `<div class="finance-empty"><i class="bi bi-${type.icon}" aria-hidden="true"></i><h3>${title}</h3><p>${description}</p>${filtered ? '<button type="button" data-finance-clear class="btn btn-outline-secondary">清除筛选</button>' : `<button type="button" data-finance-new class="btn btn-primary"${p || !loaded ? ' disabled' : ''}>${type.add}</button>`}</div>`;
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
            return `<div class="${options.wide ? 'col-12' : 'col-12 col-sm-6'}"><label class="form-label" for="financeField-${name}">${escape(label)}${options.required ? ' <span aria-hidden="true">*</span>' : ''}</label><input class="form-control" type="${options.type || 'text'}" id="financeField-${name}" name="${name}" value="${escape(value)}"${attributes}${options.type === 'text' || !options.type ? ` maxlength="${options.maxLength ?? 500}"` : ''}>${options.help ? `<div class="form-text">${escape(options.help)}</div>` : ''}</div>`;
        }
        function select(name, label, value, options, disabled = false) {
            return `<div class="col-12 col-sm-6"><label class="form-label" for="financeField-${name}">${escape(label)}</label><select class="form-select" id="financeField-${name}" name="${name}"${disabled ? ' disabled' : ''}>${options.map(([v, text]) => `<option value="${escape(v)}"${String(v) === String(value) ? ' selected' : ''}>${escape(text)}</option>`).join('')}</select></div>`;
        }
        const note = value => `<div class="col-12"><label class="form-label" for="financeField-note">备注</label><textarea class="form-control" id="financeField-note" name="note" maxlength="4000">${escape(value || '')}</textarea></div>`;
        const dateField = (value, min) => input('date', '记录日期', value || today(), { type: 'date', required: true, min, max: today() });
        const amountField = (name, label, value = '', max) => input(name, label, value, { type: 'number', min: name === 'paid_amount' || name === 'unit_price' ? 0 : '0.000001', step: 'any', required: true, max });
        const currencyField = (value = 'USD', disabled = false, label = '币种') => select('currency', label, value, currencies.map(c => [c, c]), disabled);
        const inventoryRateField = (labelId, value) => `<div class="col-12"><label class="form-label" id="${labelId}" for="financeField-exchange_rate">折算汇率</label><input class="form-control" id="financeField-exchange_rate" name="exchange_rate" type="number" step="any" min="0" required value="${escape(value ?? '')}"><div class="form-text">不同币种请填写本次约定的汇率，最多 12 位小数。</div></div>`;
        function actorFields(record, type) {
            const introductions = { transfers: '分别记录这笔转账是谁付款、谁收款，可以与对方名称不同。', loans: '这里记录借款本金的付款人与收款人；后续每次还款单独填写。', movements: '这里记录最初已收付金额的付款人与收款人；后续分次收付款单独填写。期初库存没有付款，可不填。', exchanges: '付款人对应换出金额，收款人对应换入金额，可以与换汇对方或机构不同。', repayments: '这里记录本次还款是谁付款、谁收款，可与最初本金往来不同。', payments: '这里记录本次实际收付款是谁付款、谁收款，可与最初收付不同。' };
            return `<div class="col-12"><p class="finance-actors-intro mb-0" id="financeActorsIntro">${introductions[type]}</p></div>` + input('payer', type === 'exchanges' ? '付款人（换出币种）' : '付款人（谁付的）', record.payer, { maxLength: 200 }) + input('recipient', type === 'exchanges' ? '收款人（换入币种）' : '收款人（谁收的）', record.recipient, { maxLength: 200 }) + (type === 'payments' ? input('handler', '本次收付款经手人（可不填）', record.handler, { maxLength: 200, wide: true }) : '');
        }
        function projectFormValues() {
            const read = name => String($('financeForm').elements.namedItem(name)?.value ?? '').trim();
            const currency = read('currency');
            return { date: read('date'), name: read('name'), currency, expected_profit: read('expected_profit') || null, note: read('note'),
                participants: Array.from({ length: editor.participantCount }, (_, index) => Object.fromEntries(['name', 'contribution_amount', 'currency', 'exchange_rate', 'dividend_percent', 'note'].map(field => [field, read(`participant-${index}-${field}`)]))) };
        }
        function renderParticipants(participants) {
            editor.participantCount = participants.length;
            $('financeProjectParticipants').innerHTML = participants.map((participant, index) => {
                const field = (name, label, value, options = {}) => input(`participant-${index}-${name}`, label, value, options).replace('<input ', `<input data-project-field="${name}" data-project-index="${index}" `);
                const currency = participant.currency || $('financeForm').elements.namedItem('currency').value;
                return `<section class="finance-participant" data-project-participant="${index}"><div class="finance-participant-heading"><h6>参与人 ${index + 1}</h6><button type="button" class="btn btn-sm btn-outline-secondary" data-project-remove="${index}"${participants.length === 1 ? ' disabled' : ''}>移除</button></div><div class="row g-3">` +
                    field('name', '参与人姓名', participant.name, { required: true }) + field('contribution_amount', '出资金额（原币种）', participant.contribution_amount ?? '0', { type: 'number', min: 0, step: 'any', required: true }) +
                    select(`participant-${index}-currency`, '出资币种', currency, currencies.map(c => [c, c])).replace('<select ', `<select data-project-field="currency" data-project-index="${index}" `) +
                    `<div class="col-12 col-sm-6"><label class="form-label" id="financeParticipantRateLabel-${index}" for="financeField-participant-${index}-exchange_rate">出资折算汇率</label><input class="form-control" data-project-field="exchange_rate" data-project-index="${index}" id="financeField-participant-${index}-exchange_rate" name="participant-${index}-exchange_rate" type="number" min="0" step="any" required value="${escape(participant.exchange_rate ?? (currency === $('financeForm').elements.namedItem('currency').value ? '1' : ''))}"></div>` +
                    field('dividend_percent', '计划分红比例（%）', participant.dividend_percent ?? '0', { type: 'number', min: 0, max: 100, step: 'any', required: true, help: '按约定填写，可以与出资比例不同。' }) + field('note', '参与人备注（可不填）', participant.note) +
                    `</div><div class="finance-participant-preview" id="financeParticipantPreview-${index}" aria-live="polite"></div></section>`;
            }).join('');
            $('financeProjectAddParticipant').disabled = participants.length >= 50;
            updateProjectPreview();
        }
        function updateProjectPreview(event) {
            if (editor?.type !== 'projects') return;
            const field = name => $('financeForm').elements.namedItem(name);
            const currency = field('currency').value;
            for (let index = 0; index < editor.participantCount; index += 1) {
                const native = field(`participant-${index}-currency`).value, quote = field(`participant-${index}-exchange_rate`);
                if (event?.target?.name === 'currency' || event?.target?.name === `participant-${index}-currency`) quote.value = native === currency ? '1' : '';
                quote.disabled = native === currency;
                if (quote.disabled) quote.value = '1';
                $('financeParticipantRateLabel-' + index).textContent = `出资折算：1 ${native} = 多少 ${currency}`;
            }
            const values = projectFormValues(), preview = projectPreview(values);
            const available = value => value !== null ? projectMoney(value, currency) : '待填写金额与汇率';
            $('financeProjectTotal').textContent = available(preview.total_contribution);
            $('financeProjectDividendTotal').textContent = preview.dividend_percent_total !== null ? `${projectNumber(preview.dividend_percent_total)}%` : '待填写';
            $('financeProjectUnallocated').textContent = preview.unallocated_percent !== null ? `${projectNumber(preview.unallocated_percent)}%` : '待填写';
            $('financeProjectProfit').textContent = values.expected_profit === null ? '未填写' : validProjectDecimal(values.expected_profit) ? projectMoney(values.expected_profit, currency) : '待填写有效金额';
            $('financeProjectUnallocatedProfit').textContent = values.expected_profit === null ? '未填写' : preview.unallocated_profit !== null ? projectMoney(preview.unallocated_profit, currency) : '待填写有效分红比例';
            $('financeProjectPreviewHint').textContent = preview.unallocated_percent !== null && decimalGreater(preview.dividend_percent_total, '100') ? '计划分红比例合计超过 100%，请调整后保存。' : preview.allocation_complete ? '分红计划已分配 100%。预计分红仅分配利润，不含返还本金。' : '允许保留待分配份额。出资比例自动计算，分红比例按你们的约定填写。';
            preview.participants.forEach((participant, index) => {
                $('financeParticipantPreview-' + index).innerHTML = `<span>折算出资 <strong>${available(participant.base_amount)}</strong></span><span>出资比例 <strong>${participant.contribution_percent !== null ? projectNumber(participant.contribution_percent) + '%' : '待计算'}</strong></span><span>预计分红 <strong>${values.expected_profit === null ? '未填写' : participant.expected_dividend !== null ? projectMoney(participant.expected_dividend, currency) : '待计算'}</strong></span>`;
            });
        }
        function handleProjectAction(event) {
            if (editor?.type !== 'projects' || busy || privateMode()) return;
            const button = event.target.closest('button');
            if (!button || button.disabled) return;
            const values = projectFormValues(), participants = values.participants;
            if ('projectAdd' in button.dataset && participants.length < 50) {
                participants.push({ name: '', currency: values.currency, contribution_amount: '0', exchange_rate: '1', dividend_percent: '0', note: '' });
                renderParticipants(participants);
            } else if ('projectRemove' in button.dataset && participants.length > 1) {
                participants.splice(Number(button.dataset.projectRemove), 1); renderParticipants(participants);
            } else if ('projectProportional' in button.dataset) {
                const preview = projectPreview(values);
                if (preview.total_contribution === null || !decimalGreater(preview.total_contribution, '0')) { showError('financeFormError', '先填写有效的出资金额与汇率，再按出资比例填写分红。'); return; }
                preview.participants.forEach((participant, index) => { $('financeForm').elements.namedItem(`participant-${index}-dividend_percent`).value = participant.contribution_percent; });
                showError('financeFormError', ''); updateProjectPreview();
            }
        }
        function openEditor(type, record = null, parent = null) {
            if (privateMode() || busy) return;
            const recordCurrencies = record ? type === 'exchanges' ? [record.from_currency, record.to_currency, record.fee_currency] : [record.currency, record.base_currency, type === 'movements' ? state.products.find(p => p.id === record.product_id)?.currency : null, ...(type === 'projects' ? (record.participants || []).map(p => p.currency) : [])] : [];
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
            const r = ['projects', 'movements'].includes(type) && record?.request_fields ? { ...record, ...record.request_fields } : record || {};
            editor = { type, record, parent, productId: type === 'movements' ? Number(record?.product_id || parent?.id) : type === 'products' ? record?.id : type === 'payments' ? parent?.product_id : null, requestId: createRequestTracker(() => root.crypto.randomUUID()) };
            returnProductId = editor.productId || null;
            let fields = '', title, intro;
            if (type === 'transfers') {
                title = record ? '编辑转账' : '记录转账'; intro = '记录重要的资金往来。自己的账户间转账不计入净转入金额。';
                fields = dateField(r.date) + select('direction', '转账类型', r.direction || 'out', [['out', '转出'], ['in', '转入'], ['internal', '自己的账户间转账']]) + amountField('amount', '转账金额', r.amount) + currencyField(r.currency) + input('counterparty', '对方姓名或名称', r.counterparty) + input('method', '转账方式', r.method, { help: '例如银行转账、Zelle、现金、微信' }) + input('from_account', '转出账户', r.from_account) + input('to_account', '转入账户', r.to_account) + input('reference', '凭证或参考编号', r.reference, { wide: true }) + (actorTypes.has(type) ? actorFields(r, type) : '') + note(r.note);
            } else if (type === 'loans') {
                title = record ? '编辑借贷' : '记录借贷'; intro = '这里只记录本金往来。后续还款请在详情中单独记录，保留每次还款的历史。';
                const locked = Boolean(r.repayments?.length);
                fields = dateField(r.date) + select('direction', '借贷方向', r.direction || 'lent', [['lent', '我借给别人'], ['borrowed', '我向别人借']], locked) + input('counterparty', '对方姓名', r.counterparty, { required: true }) + amountField('principal', '借款本金', r.principal) + currencyField(r.currency, locked) + input('due_date', '约定还款日期（可不填）', r.due_date || '', { type: 'date' }) + (actorTypes.has(type) ? actorFields(r, type) : '') + note(r.note);
            } else if (type === 'products') {
                title = record ? '编辑商品' : '创建商品'; intro = record ? '商品已有交易历史后，核算币种与数量单位不能修改。数量、成本与利润通过商品下的交易维护。' : '先建立商品档案，再在商品下添加进货、物流与其他费用、销售交易。不同批次如需单独核算，可以分别创建商品。';
                const locked = Boolean(record && state.movements.some(m => m.product_id === r.id));
                fields = input('name', '商品名称', r.name, { required: true }) + input('sku', '商品编号（可不填）', r.sku) + input('unit', '数量单位', r.unit || '件', { required: true, disabled: locked }) + currencyField(r.currency, locked, '库存核算币种') + input('location', '存放位置（可不填）', r.location, { wide: true }) + (actorTypes.has(type) ? actorFields(r, type) : '') + note(r.note);
            } else if (type === 'projects') {
                title = record ? '编辑合资项目' : '添加合资项目';
                intro = '出资比例自动按折算金额计算，计划分红比例按约定填写。预计利润只分配利润，不含返还本金；项目核算币种保存后固定。';
                fields = dateField(r.date) + input('name', '项目名称', r.name, { required: true }) + currencyField(r.currency, Boolean(record), '项目核算币种') + input('expected_profit', '预计可分配利润（不含本金）', r.expected_profit ?? '', { type: 'number', min: 0, step: 'any', help: '可不填写；填 0 表示预计利润为零。这里只记录分红计划。' }) + note(r.note) +
                    '<div class="col-12"><div class="finance-participant-toolbar"><div><h6>参与人与分红计划</h6><p>不同币种需要填写约定汇率，最多 12 位小数。</p></div><button type="button" class="btn btn-sm btn-outline-primary" data-project-proportional>按出资比例填写分红</button></div><div id="financeProjectParticipants"></div><button type="button" class="btn btn-outline-secondary finance-add-participant" id="financeProjectAddParticipant" data-project-add><i class="bi bi-plus-lg" aria-hidden="true"></i> 添加参与人</button></div>' +
                    '<div class="col-12"><div class="finance-project-preview" aria-live="polite"><div><span>折算总出资</span><strong id="financeProjectTotal">—</strong></div><div><span>预计可分配利润（不含本金）</span><strong id="financeProjectProfit">未填写</strong></div><div><span>计划分红合计</span><strong id="financeProjectDividendTotal">—</strong></div><div><span>待分配比例</span><strong id="financeProjectUnallocated">—</strong></div><div><span>预计待分配利润</span><strong id="financeProjectUnallocatedProfit">未填写</strong></div><p id="financeProjectPreviewHint"></p></div></div>';
            } else if (type === 'movements') {
                const product = state.products.find(p => p.id === editor.productId);
                if (!product || product.voided || !currencies.includes(product.currency)) { openEditor('products'); return; }
                title = record ? '编辑商品交易' : '添加商品交易';
                intro = `${product.name}：进货和费用计入商品总成本，销售扣减库存并计算利润。赠送时选择「销售」，单价和已收付金额都填 0。`;
                const locked = Boolean(r.payments?.length);
                if (locked) intro += ' 已有收付款历史，类型与货款币种不可修改。';
                const invoiceCurrency = r.currency || product.currency;
                const rate = r.exchange_rate ?? (invoiceCurrency === product.currency ? '1' : '');
                const priceMode = record?.price_basis === 'total' || r.total_amount !== undefined && r.kind !== 'expense' ? 'total' : 'unit';
                const wrap = (html, id) => html.replace('<div ', `<div id="${id}" `);
                fields = select('product_id', '商品', product.id, [[product.id, product.name]], true) + dateField(r.date) +
                    select('kind', '交易类型', r.kind || 'purchase', [['purchase', '进货'], ['expense', '费用（物流 / 自定义）'], ['sale', '销售 / 赠送'], ['opening', '期初库存']], locked) +
                    wrap(input('category', '费用类别', r.category || '', { maxLength: 100, help: '例如物流、包装、仓储；可以自行填写类别。' }), 'financeMovementCategoryWrap') +
                    wrap(amountField('quantity', '数量', r.quantity), 'financeMovementQuantityWrap') + currencyField(invoiceCurrency, locked, '本笔交易币种') +
                    wrap(select('price_mode', '金额填写方式', priceMode, [['unit', '填写均价'], ['total', '填写总价']]), 'financeMovementPriceModeWrap') +
                    wrap(amountField('unit_price', '均价（本笔交易币种）', r.unit_price), 'financeMovementUnitPriceWrap') +
                    wrap(input('total_amount', '总价 / 费用金额', r.total_amount ?? record?.total ?? '', { type: 'number', min: 0, step: 'any', required: true }), 'financeMovementTotalAmountWrap') +
                    inventoryRateField('financeMovementRateLabel', rate) + input('handler', '经手人（可不填）', r.handler, { maxLength: 200, help: '负责这笔交易的人，和实际付款人、收款人分别记录。' }) +
                    '<div class="col-12"><div class="finance-inventory-preview" aria-live="polite"><div><span>本笔交易总额</span><strong id="financeMovementTotal">—</strong></div><div><span>折算商品核算金额</span><strong id="financeMovementBaseTotal">—</strong></div><p id="financeMovementHint"></p></div></div>' +
                    '<div class="col-12"><details class="finance-extra-fields" id="financeMovementExtra"><summary>收付、对方与合资项目（可选）</summary><div class="row g-3">' +
                    amountField('paid_amount', record ? '最初已收付金额（本笔交易币种）' : '已收付金额（本笔交易币种）', record ? record.request_fields?.paid_amount ?? record.initial_paid_amount : 0) +
                    select('project_id', '合资项目（可不选）', r.project_id || '', [['', '不关联项目'], ...state.projects.filter(project => !project.voided || project.id === r.project_id).map(project => [project.id, `${project.name}${project.voided ? '（已作废，历史关联）' : ''}`])]) +
                    input('counterparty', '供应商、客户或费用收取方（可不填）', r.counterparty) + actorFields(r, type) + '</div></details></div>' + note(r.note);
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
                    input('method', '换汇方式（可不填）', r.method, { help: '例如银行换汇、现金、线上换汇' }) + input('reference', '凭证或参考编号（可不填）', r.reference) + (actorTypes.has(type) ? actorFields(r, type) : '') + note(r.note);
            } else {
                const isLoan = type === 'repayments', isReceiving = isLoan ? parent.direction === 'lent' : parent.kind === 'sale';
                title = isLoan ? (isReceiving ? '记录收到的还款' : '记录我的还款') : (isReceiving ? '记录收款' : '记录付款');
                const remaining = isLoan ? parent.outstanding : parent.remaining_payment;
                intro = `尚未结清 ${money(remaining, parent.currency)}。填写本次金额，可以记录部分或全部结清。`;
                if (!isLoan && currencies.includes(parent.currency)) {
                    intro = `尚未结清的货款为 ${money(remaining, parent.currency)}。实际收付款可以使用另一币种，按本次汇率折抵货款。`;
                    fields = dateField(today(), parent.date) + currencyField(parent.currency, false, '实际收付款币种') + amountField('amount', `本次实际${isReceiving ? '收到' : '支付'}金额`, remaining) + inventoryRateField('financePaymentRateLabel', '1') + '<div class="col-12"><div class="finance-inventory-preview finance-payment-preview" aria-live="polite"><div><span>折抵货款金额</span><strong id="financePaymentInvoiceAmount">—</strong></div><p id="financePaymentHint"></p></div></div>' + actorFields(r, type) + note('');
                } else fields = dateField(today(), parent.date) + amountField('amount', `本次${isReceiving ? '收到' : '支付'}金额（${parent.currency}）`, remaining, remaining) + actorFields(r, type) + note('');
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
            if (type === 'projects') renderParticipants(r.participants?.length ? r.participants : [{ currency: r.currency || 'USD' }, { currency: r.currency || 'USD' }]);
            getModal('financeEditModal').show();
        }
        function updateMovementTotal(event) {
            if (editor?.type !== 'movements') return;
            const field = name => $('financeForm').elements.namedItem(name);
            const read = name => field(name)?.value;
            const product = state.products.find(p => p.id === editor.productId);
            const kind = read('kind'), expense = kind === 'expense', opening = kind === 'opening';
            const totalMode = expense || read('price_mode') === 'total';
            const invoiceCurrency = read('currency');
            const quote = field('exchange_rate');
            if (product && event?.target?.name === 'currency') quote.value = invoiceCurrency === product.currency ? '1' : '';
            quote.disabled = invoiceCurrency === product?.currency;
            if (quote.disabled) quote.value = '1';
            field('quantity').disabled = expense;
            field('category').disabled = !expense; field('category').required = expense;
            field('unit_price').disabled = totalMode;
            field('total_amount').disabled = !totalMode;
            field('price_mode').disabled = expense;
            for (const [id, hidden] of [['financeMovementQuantityWrap', expense], ['financeMovementCategoryWrap', !expense], ['financeMovementPriceModeWrap', expense], ['financeMovementUnitPriceWrap', totalMode], ['financeMovementTotalAmountWrap', !totalMode]]) $(id).classList.toggle('d-none', hidden);
            if (event?.target?.name === 'price_mode' && !expense) {
                if (totalMode) field('total_amount').value = inventoryAmount(read('quantity'), read('unit_price')) ?? '';
                else field('unit_price').value = inventoryUnitPrice(read('total_amount'), read('quantity')) ?? '';
            }
            const originalTotal = totalMode ? (decimalParts(read('total_amount')) ? read('total_amount') : null) : inventoryAmount(read('quantity'), read('unit_price'));
            if (!totalMode) field('total_amount').value = originalTotal ?? '';
            else if (!expense) field('unit_price').value = inventoryUnitPrice(originalTotal, read('quantity')) ?? '';
            const baseTotal = validInventoryRate(quote.value, quote.disabled) ? inventoryAmount(originalTotal, quote.value) : null;
            $('financeMovementTotal').textContent = originalTotal !== null ? money(originalTotal, invoiceCurrency) : '—';
            $('financeMovementBaseTotal').textContent = product && baseTotal !== null ? money(baseTotal, product.currency) : '待填写汇率';
            $('financeMovementRateLabel').textContent = `商品折算汇率：1 ${invoiceCurrency} = 多少 ${product?.currency || '商品核算币种'}`;
            const paid = field('paid_amount'); paid.disabled = opening;
            if (opening) paid.value = 0;
            const zeroSale = kind === 'sale' && decimalParts(originalTotal)?.coefficient === 0n;
            const unitHint = totalMode && !expense ? `参考均价 ${money(read('unit_price'), invoiceCurrency)}，保存时以所填总价为准。` : '';
            const costHint = product ? `商品核算币种 ${product.currency}；当前库存 ${quantity(product.quantity)} ${product.unit}。` : '';
            $('financeMovementHint').textContent = costHint + unitHint + (expense ? '这笔费用计入商品累计成本，不改变数量。费用类别可以自定义；后续补记费用会更新等效单位成本及此前销售利润。' : opening ? '期初库存只记录数量与成本，不记录收付款。' : zeroSale ? '赠送 / 零价出货：已收付金额请填 0，不产生待收款；库存照常扣减，利润为这批商品等效成本的负数。' : kind === 'sale' ? `销售单价允许为 0。${baseTotal !== null && product?.acquired_quantity > 0 ? `按当前等效成本预估利润 ${money(Number(baseTotal) - Number(read('quantity')) * Number(product.average_cost), product.currency)}。` : ''}保存后按商品累计成本核算，后续新增成本会更新利润。` : `进货金额计入累计成本；物流及其他费用可另加交易。后续分次收付款在交易详情中记录。`);
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
            $('financeActorsIntro').textContent = `付款人支付换出的 ${from}，收款人收到换入的 ${to}；可以与换汇对方或机构不同。`;
            $('financeExchangeRateHelp').textContent = derived.exchange_rate > 0 ? `1 ${from} = ${formatRate(derived.exchange_rate)} ${to}；反向：1 ${to} = ${formatRate(derived.inverse_rate)} ${from}。以上汇率不含手续费。` : `按 ${from} 换成 ${to} 的方向填写。也可以直接填写两笔金额，计算成交汇率。`;
            $('financeExchangeDebit').textContent = cleanNumber(values.from_amount) > 0 ? money(derived.debited_amount, from) : '—';
            $('financeExchangeReceipt').textContent = cleanNumber(values.to_amount) > 0 ? money(derived.received_amount, to) : '—';
            $('financeExchangeEffectiveRate').textContent = derived.exchange_rate > 0 && derived.received_amount > 0 ? `含手续费的实际汇率：1 ${from} = ${formatRate(derived.effective_rate)} ${to}。${feeField.value === from ? '手续费加在换出金额上。' : '手续费从换入金额中扣除。'}` : '实际支出与实际到账只计一次手续费。';
        }
        function updateEditorPreview(event) { updateMovementTotal(event); updateExchangePreview(event); updatePaymentPreview(event); updateProjectPreview(event); }
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
            else if (type === 'projects') payload = projectFormValues();
            else payload = { date: get('date'), amount: get('amount'), note: get('note') };
            if (type === 'transfers') payload.amount = get('amount');
            if (type === 'loans') { payload.principal = get('principal'); payload.due_date = get('due_date') || null; payload.direction = get('direction') || record?.direction; payload.currency = get('currency') || record?.currency; }
            if (type === 'products') { payload.currency = get('currency') || record?.currency || 'USD'; payload.unit = get('unit') || record?.unit || '件'; }
            if (type === 'movements') {
                payload.kind = get('kind') || record?.kind; payload.product_id = editor.productId;
                if (payload.kind === 'expense') { payload.category = get('category'); payload.total_amount = get('total_amount'); }
                else { payload.quantity = get('quantity'); if (get('price_mode') === 'total') payload.total_amount = get('total_amount'); else payload.unit_price = get('unit_price'); }
                payload.paid_amount = payload.kind === 'opening' ? '0' : get('paid_amount');
                payload.currency = get('currency') || record?.currency;
                payload.exchange_rate = get('exchange_rate') || ($('financeForm').elements.namedItem('exchange_rate')?.disabled ? '1' : '');
            }
            if (type === 'movements' && (record || get('project_id'))) payload.project_id = get('project_id') ? Number(get('project_id')) : null;
            if (type === 'payments' && currencies.includes(parent.currency)) { payload.currency = get('currency'); payload.exchange_rate = get('exchange_rate') || ($('financeForm').elements.namedItem('exchange_rate')?.disabled ? '1' : ''); }
            if (actorTypes.has(type)) for (const field of ['payer', 'recipient']) if (record || get(field)) payload[field] = get(field);
            if (['movements', 'payments'].includes(type) && (record || get('handler'))) payload.handler = get('handler');
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
            const current = editor, existingProductIds = new Set(state.products.map(product => product.id));
            const path = current.type === 'repayments' ? `/loans/${current.parent.id}/repayments` : current.type === 'payments' ? `/movements/${current.parent.id}/payments` : `/${current.type}${current.record ? `/${current.record.id}` : ''}`;
            busy = true; $('financeSave').disabled = true; $('financeSave').textContent = '正在保存…'; showError('financeFormError', '');
            try {
                const data = await api(path, payload, current.record ? 'PUT' : 'POST');
                busy = false;
                applyState(data);
                if (current.type === 'products' && !current.record) returnProductId = state.products.find(product => !existingProductIds.has(product.id))?.id || null;
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
        function showProductProfile(id) {
            if (privateMode() || busy) return;
            const product = state.products.find(record => record.id === Number(id));
            if (!product) return;
            const records = filterRecords(state.movements.filter(record => record.product_id === product.id), { showVoided: $('financeShowVoided').checked }, state.products, state.projects);
            const hasHistory = state.movements.some(record => record.product_id === product.id);
            const cash = name => money(product[name], product.currency);
            const unitCost = cleanNumber(product.acquired_quantity) > 0 ? cash('average_cost') : '待进货';
            const allowNew = !product.voided && currencies.includes(product.currency);
            $('financeDetailsTitle').textContent = product.name;
            $('financeDetailsBody').innerHTML = `<div class="finance-profile-meta"><span>${escape(product.sku || '未填写编号')}</span><span>核算币种 ${escape(product.currency)}</span>${product.location ? `<span>${escape(product.location)}</span>` : ''}${product.voided ? badge('void') : ''}</div><dl class="finance-profile-summary">${[
                detailField('当前库存', `${quantity(product.quantity)} ${escape(product.unit)}`), detailField('累计成本', cash('total_cost')),
                detailField('等效单位成本', unitCost), detailField('累计销售数量', `${quantity(product.sold_quantity)} ${escape(product.unit)}`),
                detailField('累计销售额', cash('sales_revenue')), detailField('已售利润', cash('realized_profit'))
            ].join('')}</dl><div class="finance-profile-costs"><span>进货 / 期初成本 <strong>${cash('purchase_cost')}</strong></span><span>费用成本 <strong>${cash('expense_cost')}</strong></span><span>剩余库存成本 <strong>${cash('inventory_cost')}</strong></span></div>${cleanNumber(product.unallocated_cost) > 0 ? `<p class="finance-private-note">尚未进货的费用 ${cash('unallocated_cost')} 已计入累计成本，进货后计算等效单位成本。</p>` : ''}${(product.expense_categories || []).length ? `<details class="finance-profile-expenses"><summary>按类别查看费用</summary>${product.expense_categories.map(item => `<div><span>${escape(item.category)}</span><strong>${money(item.total, product.currency)}</strong></div>`).join('')}</details>` : ''}${product.note ? `<p class="finance-profile-note">${escape(product.note)}</p>` : ''}<p class="finance-profile-method">等效单位成本 =（进货及期初成本 + 所有费用）÷ 累计进货数量。新增进货或费用会更新此前销售的利润；需要分批核算时，请分别创建商品。</p><div class="finance-profile-transactions-heading"><h6>商品交易</h6>${allowNew ? `<button type="button" class="btn btn-primary btn-sm" data-finance-product-transaction data-id="${product.id}"><i class="bi bi-plus-lg" aria-hidden="true"></i> 添加交易</button>` : ''}</div><div class="finance-profile-transactions">${records.length ? renderRows(records, 'movements', state.products, false, state.projects) : '<div class="finance-empty"><h3>添加第一笔商品交易</h3><p>进货记录数量与价格；物流和其他费用按自定义类别计入成本；销售记录数量、均价或总价。</p></div>'}</div>${!currencies.includes(product.currency) ? '<p class="finance-private-note mt-3">历史商品保留供查账，不新增进出货。</p>' : ''}`;
            $('financeDetailsActions').innerHTML = `${!product.voided ? `<button type="button" class="btn btn-outline-secondary" data-finance-edit="products" data-id="${product.id}">编辑商品</button>${!hasHistory ? `<button type="button" class="btn btn-outline-danger" data-finance-void="products" data-id="${product.id}">作废商品</button>` : ''}` : ''}<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>`;
            getModal('financeDetailsModal').show();
        }
        function showDetails(type, id) {
            if (type === 'products') { showProductProfile(id); return; }
            if (privateMode()) return;
            const record = state[type]?.find(r => r.id === id);
            if (!record) return;
            const r = type === 'projects' ? projectSnapshot(record) : record;
            const p = privateMode(), text = value => sensitive(value, p), cash = value => (type === 'projects' ? projectMoney : money)(value, r.currency, p);
            const movementStatus = type === 'movements' && !r.voided ? isZeroPriceSale(r) ? '无需收款' : r.kind === 'opening' ? '期初库存' : r.status === 'unpaid' ? (r.kind === 'sale' ? '未收款' : '未付款') : r.status === 'partial' ? (r.kind === 'sale' ? '部分收款' : '部分付款') : (r.kind === 'sale' ? '已收清' : '已付清') : undefined;
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
            } else if (type === 'projects') {
                fields[1] = detailField('状态', badge(r.voided ? 'void' : 'planned'));
                const knownProfit = r.expected_profit !== null && r.expected_profit !== undefined;
                fields.push(detailField('项目名称', text(r.name)), detailField('项目核算币种', escape(r.currency)), detailField('折算总出资', cash(r.total_contribution)),
                    detailField('预计可分配利润（不含本金）', knownProfit ? cash(r.expected_profit) : '未填写'), detailField('计划分红比例合计', `${projectNumber(r.dividend_percent_total, 0, p)}%`), detailField('待分配比例', `${projectNumber(r.unallocated_percent, 0, p)}%`), detailField('预计待分配利润', knownProfit ? cash(r.unallocated_profit) : '未填写'));
            } else {
                const product = state.products.find(p => p.id === r.product_id);
                const baseCurrency = r.base_currency || product?.currency || r.currency;
                const baseCash = value => money(value, baseCurrency, p);
                fields.push(detailField('交易类型', escape(isZeroPriceSale(r) ? '赠送 / 零价出货' : labels[r.kind])), detailField('商品', `<button type="button" class="btn finance-project-link" data-finance-profile data-id="${Number(product?.id)}">${text(product?.name)}</button>`));
                if (r.kind === 'expense') fields.push(detailField('费用类别', text(r.category)));
                else fields.push(detailField('数量', `${quantity(r.quantity, p)} ${text(product?.unit)}`), detailField('均价（本笔交易币种）', cash(r.unit_price)));
                fields.push(detailField(r.kind === 'expense' ? '费用金额' : '本笔交易总价', cash(r.total)), detailField('商品核算币种', escape(baseCurrency)), detailField('商品折算汇率', `1 ${escape(r.currency)} = ${formatRate(r.exchange_rate ?? 1, p)} ${escape(baseCurrency)}`), detailField('折算商品核算金额', baseCash(r.base_total ?? r.total)), detailField('最初已收付（本笔交易币种）', cash(r.initial_paid_amount)), detailField(r.kind === 'sale' ? '累计已收款（折抵交易金额）' : '累计已付款（折抵交易金额）', cash(r.paid_amount)), detailField(r.kind === 'sale' ? '待收金额' : '待付金额', cash(r.remaining_payment)), detailField('供应商、客户或费用收取方', text(r.counterparty)), detailField('经手人', text(r.handler)));
                if (r.kind === 'sale') fields.push(detailField('销售等效成本（商品核算币种）', baseCash(r.cost_of_goods)), detailField('销售利润（商品核算币种）', baseCash(r.realized_profit)));
                if (r.project_id) fields.push(detailField('关联项目', `<button type="button" class="btn finance-project-link" data-finance-detail="projects" data-id="${Number(r.project_id)}">${text(r.project_name || state.projects.find(project => project.id === r.project_id)?.name)}</button>`));
            }
            if (actorTypes.has(type)) {
                const scope = type === 'loans' ? '本金' : type === 'movements' ? '最初收付的' : '';
                fields.push(detailField(type === 'exchanges' ? `付款人（换出 ${r.from_currency}）` : `${scope}付款人（谁付的）`, text(r.payer)), detailField(type === 'exchanges' ? `收款人（换入 ${r.to_currency}）` : `${scope}收款人（谁收的）`, text(r.recipient)));
            }
            fields.push(detailField('备注', text(r.note), true));
            let history = '';
            if (type === 'projects') {
                const knownProfit = r.expected_profit !== null && r.expected_profit !== undefined;
                const movements = state.movements.filter(movement => movement.project_id === r.id || (r.movement_ids || []).includes(movement.id));
                history = `<div class="finance-history"><h6>参与人与分红计划</h6>${(r.participants || []).map(participant => {
                    const native = participant.currency || r.currency;
                    return `<section class="finance-participant-detail"><h6>${text(participant.name)}</h6><dl class="finance-detail-grid">${[
                        detailField('原币种出资', projectMoney(participant.contribution_amount, native, p)), detailField('出资折算汇率', `1 ${escape(native)} = ${formatRate(participant.exchange_rate ?? 1, p)} ${escape(r.currency)}`),
                        detailField('折算出资', cash(participant.base_amount)), detailField('出资比例（自动计算）', `${projectNumber(participant.contribution_percent, 0, p)}%`),
                        detailField('计划分红比例（约定）', `${projectNumber(participant.dividend_percent, 0, p)}%`), detailField('预计分红（不含本金）', knownProfit ? cash(participant.expected_dividend) : '未填写'), detailField('参与人备注', text(participant.note), true)
                    ].join('')}</dl></section>`;
                }).join('')}<p class="finance-private-note mt-3">出资比例与约定分红比例分别记录。预计分红仅分配利润，不含返还本金；进出货关联不会自动改变分红计划。</p></div><div class="finance-history"><h6>关联进出货与历史</h6>${movements.length ? movements.map(movement => `<button type="button" class="finance-linked-movement btn" data-finance-detail="movements" data-id="${Number(movement.id)}"><span>${text(movement.date)} · ${escape(labels[movement.kind])} · ${text(state.products.find(product => product.id === movement.product_id)?.name)} ${movement.voided ? badge('void') : ''}</span><strong>${money(movement.total, movement.currency, p)}</strong><i class="bi bi-chevron-right" aria-hidden="true"></i></button>`).join('') : '<p class="small text-muted mb-0">尚未关联进出货。记录进出货时可以选择这个项目。</p>'}</div>`;
            }
            if (type === 'loans' || type === 'movements') {
                const nested = type === 'loans' ? 'repayments' : 'payments';
                const title = type === 'loans' ? '还款历史' : '分次收付款历史';
                history = `<div class="finance-history"><h6>${title}</h6>${(r[nested] || []).length ? r[nested].map(payment => {
                    const paymentCurrency = payment.currency || r.currency;
                    const conversion = type === 'movements' ? `<small class="finance-history-conversion">折抵 ${money(payment.invoice_amount ?? payment.amount, payment.invoice_currency || r.currency, p)}；1 ${escape(paymentCurrency)} = ${formatRate(payment.exchange_rate ?? 1, p)} ${escape(payment.invoice_currency || r.currency)}</small>` : '';
                    const actors = actorLine(payment, p);
                    return `<div class="finance-history-row"><span>${text(payment.date)}</span><span>${text(payment.note)}${payment.voided ? ` ${badge('void')}` : ''}${actors ? `<small class="finance-history-actors">本次${actors}</small>` : ''}${payment.handler ? `<small class="finance-history-actors">本次经手人 ${text(payment.handler)}</small>` : ''}${conversion}</span><strong>${money(payment.amount, type === 'movements' ? paymentCurrency : r.currency, p)}</strong>${!r.voided && !payment.voided ? `<button type="button" class="btn btn-outline-secondary" data-finance-void="${nested}" data-id="${payment.id}" data-parent="${r.id}">作废</button>` : '<span></span>'}</div>`;
                }).join('') : '<p class="small text-muted mb-0">尚未记录分次收付款。</p>'}${type === 'movements' ? '<p class="finance-private-note mt-3 mb-0">折抵金额只计入一次货款余额。商品利润按累计进货与费用成本核算，不包含后续收付款产生的汇兑损益。</p>' : ''}</div>`;
            }
            $('financeDetailsTitle').textContent = type === 'movements' ? '商品交易详情' : `${types[type].name}详情`;
            $('financeDetailsBody').innerHTML = `<dl class="finance-detail-grid">${fields.join('')}</dl>${history}${r.voided ? '<p class="finance-private-note mt-4 mb-0">这笔记录已作废，保留在历史中，不计入余额与汇总。</p>' : ''}`;
            const remaining = type === 'loans' ? r.outstanding : r.remaining_payment;
            const receiptLabel = type === 'loans' ? '记录还款' : r.kind === 'sale' ? '记录收款' : '记录付款';
            const profileBack = type === 'movements' ? `<button type="button" class="btn btn-outline-secondary" data-finance-profile data-id="${Number(r.product_id)}">返回商品</button>` : '';
            $('financeDetailsActions').innerHTML = r.voided ? '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">关闭</button>' : `<button type="button" class="btn btn-outline-danger me-auto" data-finance-void="${type}" data-id="${r.id}">作废记录</button><button type="button" class="btn btn-outline-secondary" data-finance-edit="${type}" data-id="${r.id}">编辑</button>${remaining > 0 && (type === 'loans' || (type === 'movements' && r.kind !== 'opening')) ? `<button type="button" class="btn btn-primary" data-finance-payment="${type}" data-id="${r.id}">${receiptLabel}</button>` : ''}`;
            $('financeDetailsActions').innerHTML += profileBack;
            getModal('financeDetailsModal').show();
        }
        function showProducts() {
            if (privateMode() || busy) return;
            getModal('financeDetailsModal').hide();
            changeSection('movements');
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
            returnProductId = type === 'movements' ? target.record.product_id : type === 'payments' ? target.parent?.product_id : type === 'products' ? target.record.id : null;
            getModal('financeDetailsModal').hide();
            const explanations = {
                transfers: '作废后，这笔转账不再计入转入、转出与净额。原记录仍保存在历史中。',
                exchanges: '作废后，这笔换汇不再计入各币种的换入、换出、手续费与净流动。原记录与成交汇率仍保存在历史中。',
                projects: '请先解除关联或作废项目下仍有效的进出货。作废后不再显示为可选项目，出资、分红计划与关联历史仍保留供查账。',
                loans: '请先在还款历史中作废尚有效的还款，再作废这笔借贷。作废后的借贷不计入待还余额，原记录与还款历史仍会保留。',
                products: '商品作废后不再出现在可选商品中。已有任何进出货历史的商品不能作废，可以编辑名称、位置与备注。',
                movements: '请先作废尚有效的分次收付款。作废后会重新计算商品累计成本、库存、余额与销售利润。如果造成库存不足，需要先处理后续销售。所有历史仍会保留。',
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
            else if ('financeProfile' in d) showProductProfile(id);
            else if ('financeProductTransaction' in d) openEditor('movements', null, state.products.find(product => product.id === id));
            else if (d.financeDetail) showDetails(d.financeDetail, id);
            else if (d.financeEdit) openEditor(d.financeEdit, state[d.financeEdit].find(r => r.id === id));
            else if (d.financePayment) openEditor(d.financePayment === 'loans' ? 'repayments' : 'payments', null, state[d.financePayment].find(r => r.id === id));
            else if (d.financeVoid) openVoid(d.financeVoid, id, Number(d.parent));
            else if ('financeProductNew' in d) openEditor('products');
            else if ('financeNew' in d) openEditor(section === 'movements' ? 'products' : section);
            else if ('financeClear' in d) { $('financeSearch').value = ''; $('financeCurrency').value = ''; $('financeStatus').value = ''; render(); }
        }
        function refreshPrivacy() {
            if (privateMode()) {
                if ($('financeSummary')) $('financeSummary').open = false;
                updateSummaryHint();
                $('financeSearch').value = '';
                for (const id of ['financeEditModal', 'financeDetailsModal', 'financeVoidModal']) getModal(id).hide();
                $('financeFormFields').innerHTML = ''; $('financeFormIntro').textContent = ''; $('financeDetailsBody').innerHTML = ''; $('financeDetailsActions').innerHTML = '';
                showError('financeFormError', ''); showError('financeVoidError', '');
                $('financeVoidMessage').textContent = '';
                editor = null; voidTarget = null; returnProductId = null;
                notice('');
            }
            render();
        }
        document.querySelector('.finance-workspace').addEventListener('click', handleAction);
        $('financeDetailsModal').addEventListener('click', handleAction);
        $('financeReload').addEventListener('click', () => load(true));
        $('financeProducts').addEventListener('click', showProducts);
        $('financeAdd').addEventListener('click', () => openEditor(section === 'movements' ? 'products' : section));
        ['financeSearch', 'financeCurrency', 'financeStatus', 'financeShowVoided'].forEach(id => $(id).addEventListener(id === 'financeSearch' ? 'input' : 'change', render));
        $('financeForm').addEventListener('submit', save);
        $('financeForm').addEventListener('input', updateEditorPreview);
        $('financeForm').addEventListener('change', updateEditorPreview);
        $('financeForm').addEventListener('click', handleProjectAction);
        $('financeVoidConfirm').addEventListener('click', confirmVoid);
        if ($('financeSummary')) { $('financeSummary').open = false; $('financeSummary').addEventListener('toggle', updateSummaryHint); updateSummaryHint(); }
        ['financeEditModal', 'financeVoidModal'].forEach(id => {
            $(id).addEventListener('hide.bs.modal', event => { if (busy && !privateMode()) event.preventDefault(); });
            $(id).addEventListener('hidden.bs.modal', () => {
                const productId = returnProductId; returnProductId = null;
                if (id === 'financeEditModal') { editor = null; $('financeFormFields').innerHTML = ''; $('financeFormIntro').textContent = ''; }
                if (productId && !privateMode()) showProductProfile(productId);
            });
        });
        $('financeForm').addEventListener('invalid', event => { const details = event.target.closest?.('details'); if (details) details.open = true; }, true);
        changeSection('transfers');
        return { load, refreshPrivacy, setPrivate(value) { privateOverride = Boolean(value); refreshPrivacy(); } };
    }
    const api = { init, escape, money, quantity, formatRate, amountFromRate, inventoryAmount, inventoryUnitPrice, decimalSum, decimalGreater, allocateDecimal, projectPreview, projectMoney, exchangeAmounts, filterRecords, filterProducts, renderProductCards, renderRows, validatePayload, createRequestTracker, errorMessage };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FinanceUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
