"""Independent financial ledger, validated with exact decimal arithmetic.

Inventory uses chronological moving-average cost. These records never become
investment transactions or contribute to the portfolio's cash or performance.
"""
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal, ROUND_FLOOR, localcontext
import re
from typing import List, Literal, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Currency choices for new/edit request fields. Persisted historical payloads
# are replayed directly, retaining their original currency and balances.
CURRENCIES = ('USD', 'CNY')
D = Decimal
ZERO = D(0)
PRECISION = D('0.000001')
RATE_PRECISION = D('0.000000000001')


class FinanceError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def money(value):
    return D(str(value))


def rounded(value):
    with localcontext() as ctx:
        ctx.prec = 48
        return value.quantize(PRECISION)


class FinanceModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    @field_validator('date', 'due_date', mode='before', check_fields=False)
    @classmethod
    def iso_date(cls, value):
        if value is None:
            return None
        if isinstance(value, date):
            return value
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError('Date must use YYYY-MM-DD')
        return value

    @field_validator('date', check_fields=False)
    @classmethod
    def historical_date(cls, value):
        if value > datetime.now(ZoneInfo('America/New_York')).date():
            raise ValueError('Record date cannot be in the future')
        return value

    @field_validator('currency', 'from_currency', 'to_currency', 'fee_currency', check_fields=False)
    @classmethod
    def supported_currency(cls, value):
        if value is None:
            return None
        value = value.upper()
        if value not in CURRENCIES:
            raise ValueError('Unsupported currency')
        return value

    @field_validator('amount', 'principal', 'quantity', 'unit_price', 'paid_amount',
                     'from_amount', 'to_amount', 'fee_amount', 'expected_profit',
                     'contribution_amount', 'dividend_percent',
                     mode='before', check_fields=False)
    @classmethod
    def exact_number(cls, value, info):
        if value is None and info.field_name == 'expected_profit':
            return None
        if isinstance(value, bool):
            raise ValueError('Amount must be a number')
        try:
            result = D(str(value))
        except Exception as exc:
            raise ValueError('Amount must be a finite number') from exc
        if not result.is_finite():
            raise ValueError('Amount must be a finite number')
        if abs(result) > D('1000000000000'):
            raise ValueError('Amount is too large')
        if result != result.quantize(PRECISION):
            raise ValueError('Use at most 6 decimal places')
        if result < 0 or (result == 0 and info.field_name not in (
                'unit_price', 'paid_amount', 'fee_amount', 'expected_profit',
                'contribution_amount', 'dividend_percent')):
            raise ValueError('Amount must be positive')
        return result

    @field_validator('exchange_rate', mode='before', check_fields=False)
    @classmethod
    def exact_exchange_rate(cls, value):
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError('Exchange rate must be a positive finite number')
        try:
            result = D(str(value))
        except Exception as exc:
            raise ValueError('Exchange rate must be a positive finite number') from exc
        if not result.is_finite() or result <= 0:
            raise ValueError('Exchange rate must be a positive finite number')
        if result > D('1000000000000'):
            raise ValueError('Exchange rate is too large')
        if result != result.quantize(RATE_PRECISION):
            raise ValueError('Use at most 12 decimal places for the exchange rate')
        return result


class TransferFields(FinanceModel):
    date: date
    direction: Literal['in', 'out', 'internal']
    amount: Decimal
    currency: str = 'USD'
    counterparty: str = Field(default='', max_length=200)
    from_account: str = Field(default='', max_length=200)
    to_account: str = Field(default='', max_length=200)
    method: str = Field(default='', max_length=100)
    reference: str = Field(default='', max_length=200)
    note: str = Field(default='', max_length=2000)


class TransferCreate(TransferFields):
    request_id: UUID


class TransferUpdate(TransferFields):
    version: int = Field(ge=1, strict=True)


class ExchangeFields(FinanceModel):
    """One recorded exchange, whose fee is charged in exactly one currency.

    from_amount excludes the fee; to_amount is the gross receipt before any
    target-currency fee. Derived actual debit/receipt must not deduct fees twice.
    """
    date: date
    from_currency: str
    to_currency: str
    from_amount: Decimal
    to_amount: Decimal
    fee_amount: Decimal = D(0)
    fee_currency: Optional[str] = None
    from_account: str = Field(default='', max_length=200)
    to_account: str = Field(default='', max_length=200)
    counterparty: str = Field(default='', max_length=200)
    method: str = Field(default='', max_length=100)
    reference: str = Field(default='', max_length=200)
    note: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def valid_exchange(self):
        if self.from_currency == self.to_currency:
            raise ValueError('Exchange currencies must be different')
        if self.fee_currency is None:
            self.fee_currency = self.from_currency
        if self.fee_currency not in (self.from_currency, self.to_currency):
            raise ValueError('Fee currency must match the source or target currency')
        if self.fee_currency == self.to_currency and self.fee_amount >= self.to_amount:
            raise ValueError('Target-currency fee must be less than the gross received amount')
        return self


class ExchangeCreate(ExchangeFields):
    request_id: UUID


class ExchangeUpdate(ExchangeFields):
    version: int = Field(ge=1, strict=True)


class LoanFields(FinanceModel):
    date: date
    direction: Literal['lent', 'borrowed']
    counterparty: str = Field(min_length=1, max_length=200)
    principal: Decimal
    currency: str = 'USD'
    due_date: Optional[date] = None
    note: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def valid_due_date(self):
        if self.due_date and self.due_date < self.date:
            raise ValueError('Due date cannot be earlier than the loan date')
        return self


class LoanCreate(LoanFields):
    request_id: UUID


class LoanUpdate(LoanFields):
    version: int = Field(ge=1, strict=True)


class ProductFields(FinanceModel):
    name: str = Field(min_length=1, max_length=200)
    sku: str = Field(default='', max_length=100)
    unit: str = Field(default='件', min_length=1, max_length=30)
    currency: str = 'USD'
    location: str = Field(default='', max_length=200)
    note: str = Field(default='', max_length=2000)


class ProductCreate(ProductFields):
    request_id: UUID


class ProductUpdate(ProductFields):
    version: int = Field(ge=1, strict=True)


class ProjectParticipant(FinanceModel):
    name: str = Field(min_length=1, max_length=200)
    contribution_amount: Decimal
    currency: Optional[str] = None
    exchange_rate: Optional[Decimal] = None
    dividend_percent: Decimal = Field(ge=0, le=100)
    note: str = Field(default='', max_length=2000)


class ProjectFields(FinanceModel):
    date: date
    name: str = Field(min_length=1, max_length=200)
    currency: str = 'USD'
    expected_profit: Optional[Decimal] = None
    participants: List[ProjectParticipant] = Field(min_length=1, max_length=50)
    note: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def valid_plan(self):
        names = [p.name.casefold() for p in self.participants]
        if len(set(names)) != len(names):
            raise ValueError('Participant names must be unique')
        with localcontext() as ctx:
            ctx.prec = 48
            if sum((p.dividend_percent for p in self.participants), ZERO) > 100:
                raise ValueError('Dividend percentages cannot exceed 100 in total')
            for participant in self.participants:
                currency, rate = resolve_currency_rate(participant.model_dump(), self.currency)
                if participant.contribution_amount > 0 and rounded(participant.contribution_amount * rate) <= 0:
                    raise ValueError('Converted contribution amount must be positive')
                participant.currency = currency
                participant.exchange_rate = rate
        return self


class ProjectCreate(ProjectFields):
    request_id: UUID


class ProjectUpdate(ProjectFields):
    version: int = Field(ge=1, strict=True)


class MovementFields(FinanceModel):
    date: date
    product_id: int = Field(ge=1, strict=True)
    kind: Literal['purchase', 'sale', 'opening']
    quantity: Decimal
    unit_price: Decimal
    paid_amount: Decimal = D(0)
    currency: Optional[str] = None
    exchange_rate: Optional[Decimal] = None
    project_id: Optional[int] = Field(default=None, ge=1, strict=True)
    counterparty: str = Field(default='', max_length=200)
    note: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def valid_initial_payment(self):
        if self.paid_amount > rounded(self.quantity * self.unit_price):
            raise ValueError('Paid amount cannot exceed the movement total')
        if self.kind == 'opening' and self.paid_amount:
            raise ValueError('Opening inventory cannot have a payment')
        return self


class MovementCreate(MovementFields):
    request_id: UUID


class MovementUpdate(MovementFields):
    version: int = Field(ge=1, strict=True)


class PaymentCreate(FinanceModel):
    date: date
    amount: Decimal
    note: str = Field(default='', max_length=2000)
    request_id: UUID


class InventoryPaymentCreate(PaymentCreate):
    currency: Optional[str] = None
    exchange_rate: Optional[Decimal] = None


CREATE_MODELS = {'transfers': TransferCreate, 'loans': LoanCreate,
                 'products': ProductCreate, 'movements': MovementCreate,
                 'exchanges': ExchangeCreate, 'projects': ProjectCreate}
UPDATE_MODELS = {'transfers': TransferUpdate, 'loans': LoanUpdate,
                 'products': ProductUpdate, 'movements': MovementUpdate,
                 'exchanges': ExchangeUpdate, 'projects': ProjectUpdate}


def request_data(request):
    """Stable canonical JSON, including decimal strings for storage/idempotency."""
    def canonical(python_value, json_value):
        if isinstance(python_value, Decimal):
            return format(python_value.normalize(), 'f')
        if isinstance(python_value, dict):
            return {key: canonical(value, json_value[key]) for key, value in python_value.items()}
        if isinstance(python_value, list):
            return [canonical(value, item) for value, item in zip(python_value, json_value)]
        return json_value

    values = canonical(request.model_dump(), request.model_dump(mode='json'))
    for key, value in request.model_dump().items():
        if value is None and key in ('currency', 'exchange_rate'):
            values.pop(key, None)
    if values.get('project_id') is None:
        if not isinstance(request, MovementUpdate) or 'project_id' not in request.model_fields_set:
            values.pop('project_id', None)
    return values


def empty_state():
    return {kind: [] for kind in CREATE_MODELS}


def find_record(state, kind, record_id, active=False):
    record = next((r for r in state[kind] if r['id'] == record_id), None)
    if record is None:
        raise FinanceError('Record not found', 404)
    if active and record.get('voided'):
        raise FinanceError('This record has been voided', 409)
    return record


def require_version(record, version):
    if record['version'] != version:
        raise FinanceError('This record changed; refresh and try again', 409)


def validate_edit(state, kind, record, values):
    """Fields defining settled historical meaning cannot change silently."""
    if kind == 'projects' and record['currency'] != values['currency']:
        raise FinanceError('Project currency cannot change after creation', 409)
    if kind == 'products':
        history = [m for m in state['movements'] if m['product_id'] == record['id']]
        if history and any(record[f] != values[f] for f in ('currency', 'unit')):
            raise FinanceError('Currency and unit cannot change after inventory history exists', 409)
    elif kind == 'loans' and record.get('repayments'):
        if any(record[f] != values[f] for f in ('currency', 'direction')):
            raise FinanceError('Currency and direction cannot change after repayment history exists', 409)
    elif kind == 'movements' and record.get('payments'):
        if any(record[f] != values[f] for f in ('product_id', 'kind')):
            raise FinanceError('Product and kind cannot change after payment history exists', 409)
        product = find_record(state, 'products', record['product_id'])
        old_currency = record.get('currency') or product['currency']
        if (values.get('currency') or old_currency) != old_currency:
            raise FinanceError('Invoice currency cannot change after payment history exists', 409)


def validate_void(state, kind, record):
    if kind == 'projects' and any(m.get('project_id') == record['id'] and not m['voided'] for m in state['movements']):
        raise FinanceError('Unlink or void the active movements before voiding this project', 409)
    if kind == 'products' and any(m['product_id'] == record['id'] for m in state['movements']):
        raise FinanceError('A product with inventory history cannot be voided', 409)
    if kind == 'loans' and any(not p['voided'] for p in record.get('repayments', [])):
        raise FinanceError('Void the repayments before voiding this loan', 409)
    if kind == 'movements' and any(not p['voided'] for p in record.get('payments', [])):
        raise FinanceError('Void the payments before voiding this movement', 409)


def _active_payments(record, key):
    items = record.get(key, [])
    for payment in items:
        payment['amount'] = money(payment['amount'])
        if not payment['voided'] and payment['date'] < record['date']:
            raise FinanceError('Payment date cannot precede the original record date')
    return sum((money(p['amount']) for p in items if not p['voided']), ZERO)


def resolve_currency_rate(record, default_currency):
    """Use recorded rates only; missing legacy fields mean same-currency 1:1."""
    currency = record.get('currency') or default_currency
    raw_rate = record.get('exchange_rate')
    if currency != default_currency and raw_rate is None:
        raise FinanceError('Enter the exchange rate for a different currency')
    rate = D(1) if raw_rate is None else money(raw_rate)
    if not rate.is_finite() or rate <= 0:
        raise FinanceError('Exchange rate must be a positive finite number')
    if currency == default_currency and rate != 1:
        raise FinanceError('Same-currency exchange rate must be 1')
    return currency, rate


def _inventory_payments(movement, invoice_currency):
    total = ZERO
    for payment in movement.get('payments', []):
        payment['amount'] = money(payment['amount'])
        if not payment['voided'] and payment['date'] < movement['date']:
            raise FinanceError('Payment date cannot precede the original record date')
        currency, rate = resolve_currency_rate(payment, invoice_currency)
        converted = rounded(payment['amount'] * rate)
        if converted <= 0:
            raise FinanceError('Converted payment amount must be positive')
        payment.update(currency=currency, exchange_rate=rate,
                       invoice_currency=invoice_currency, invoice_amount=converted)
        if not payment['voided']:
            total += converted
    return total


def allocate_residual(total, weights):
    """Largest remainder at 6 decimals, with stable input-order tie breaking."""
    denominator = sum(weights, ZERO)
    if denominator == 0:
        return [ZERO for _ in weights]
    exact = [total * weight / denominator for weight in weights]
    allocated = [value.quantize(PRECISION, rounding=ROUND_FLOOR) for value in exact]
    residual = int((total - sum(allocated, ZERO)) / PRECISION)
    order = sorted(range(len(weights)), key=lambda index: (-(exact[index] - allocated[index]), index))
    for index in order[:residual]:
        allocated[index] += PRECISION
    return allocated


def project_forecast(project):
    """A planning calculation; never enters realized financial summaries."""
    weights, dividends = [], []
    for participant in project['participants']:
        amount = money(participant['contribution_amount'])
        currency, rate = resolve_currency_rate(participant, project['currency'])
        base_amount = rounded(amount * rate)
        if amount > 0 and base_amount <= 0:
            raise FinanceError('Converted contribution amount must be positive')
        dividend = money(participant['dividend_percent'])
        participant.update(contribution_amount=amount, currency=currency, exchange_rate=rate,
                           base_amount=base_amount, dividend_percent=dividend)
        weights.append(base_amount)
        dividends.append(dividend)
    percentages = allocate_residual(D(100), weights)
    dividend_total = sum(dividends, ZERO)
    if dividend_total > 100:
        raise FinanceError('Dividend percentages cannot exceed 100 in total')
    unallocated_percent = D(100) - dividend_total
    profit = project.get('expected_profit')
    forecasts = None if profit is None else allocate_residual(money(profit), dividends + [unallocated_percent])
    for index, participant in enumerate(project['participants']):
        participant.update(contribution_percent=percentages[index],
                           expected_dividend=None if forecasts is None else forecasts[index])
    # Keep exact editable inputs alongside numeric display/calculation results.
    # IEEE-754 JSON numbers cannot preserve every micro-unit near the input cap.
    request_fields = {key: project[key] for key in ('date', 'name', 'currency', 'note')}
    request_fields['expected_profit'] = None if profit is None else format(money(profit).normalize(), 'f')
    request_fields['participants'] = [{
        key: format(participant[key].normalize(), 'f') if isinstance(participant[key], Decimal) else participant[key]
        for key in ('name', 'contribution_amount', 'currency', 'exchange_rate', 'dividend_percent', 'note')
    } for participant in project['participants']]
    project.update(expected_profit=None if profit is None else money(profit),
                   total_contribution=sum(weights, ZERO), dividend_percent_total=dividend_total,
                   unallocated_percent=unallocated_percent,
                   unallocated_profit=None if forecasts is None else forecasts[-1],
                   allocation_complete=dividend_total == 100,
                   status='void' if project['voided'] else 'planned',
                   movement_ids=[], active_movement_ids=[], request_fields=request_fields)
    # Keep exact derived values too: float display amounts can lose micro-units
    # even though the allocation and stored inputs reconcile exactly.
    project['calculation_fields'] = {
        key: None if project[key] is None else format(project[key].normalize(), 'f')
        for key in ('total_contribution', 'dividend_percent_total', 'unallocated_percent', 'unallocated_profit')
    }
    project['calculation_fields']['participants'] = [{
        key: None if participant[key] is None else format(participant[key].normalize(), 'f')
        for key in ('base_amount', 'contribution_percent', 'expected_dividend')
    } for participant in project['participants']]


def replay(state):
    """Validate the entire ledger and derive balances, stock and sales costs."""
    result = deepcopy(state)
    result.setdefault('exchanges', [])
    result.setdefault('projects', [])
    summary = {}

    def bucket(currency):
        if currency not in summary:
            summary[currency] = dict(currency=currency, **{f: ZERO for f in (
                'transfer_in', 'transfer_out', 'transfer_net', 'lent_outstanding',
                'borrowed_outstanding', 'inventory_cost', 'purchase_total',
                'sales_total', 'payable', 'receivable', 'realized_profit',
                'exchange_in', 'exchange_out', 'exchange_fees', 'exchange_net')})
        return summary[currency]

    with localcontext() as ctx:
        ctx.prec = 48
        projects = {p['id']: p for p in result['projects']}
        for project in projects.values():
            project_forecast(project)
        for exchange in result['exchanges']:
            principal = money(exchange['from_amount'])
            gross = money(exchange['to_amount'])
            fee = money(exchange['fee_amount'])
            source_fee = fee if exchange['fee_currency'] == exchange['from_currency'] else ZERO
            target_fee = fee if exchange['fee_currency'] == exchange['to_currency'] else ZERO
            debit, receipt = principal + source_fee, gross - target_fee
            exchange.update(from_amount=principal, to_amount=gross, fee_amount=fee,
                            exchange_rate=gross / principal, inverse_rate=principal / gross,
                            debited_amount=debit, received_amount=receipt,
                            effective_rate=receipt / debit)
            if exchange['voided']:
                continue
            source, target = bucket(exchange['from_currency']), bucket(exchange['to_currency'])
            source['exchange_out'] += principal
            target['exchange_in'] += gross
            source['exchange_net'] -= principal
            target['exchange_net'] += gross
            fee_summary = bucket(exchange['fee_currency'])
            fee_summary['exchange_fees'] += fee
            fee_summary['exchange_net'] -= fee
        for transfer in result['transfers']:
            transfer['amount'] = money(transfer['amount'])
            if transfer['voided']:
                continue
            values = bucket(transfer['currency'])
            if transfer['direction'] == 'in':
                values['transfer_in'] += transfer['amount']
                values['transfer_net'] += transfer['amount']
            elif transfer['direction'] == 'out':
                values['transfer_out'] += transfer['amount']
                values['transfer_net'] -= transfer['amount']

        for loan in result['loans']:
            loan['principal'] = money(loan['principal'])
            repaid = _active_payments(loan, 'repayments')
            if repaid > loan['principal']:
                raise FinanceError('Repayments cannot exceed the loan principal')
            loan['repaid'] = repaid
            loan['outstanding'] = ZERO if loan['voided'] else loan['principal'] - repaid
            loan['status'] = ('void' if loan['voided'] else 'settled' if not loan['outstanding']
                              else 'partial' if repaid else 'open')
            if not loan['voided']:
                bucket(loan['currency'])[loan['direction'] + '_outstanding'] += loan['outstanding']

        products = {p['id']: p for p in result['products']}
        for product in products.values():
            product.update(quantity=ZERO, average_cost=ZERO, inventory_cost=ZERO,
                           realized_profit=ZERO)
            if not product['voided']:
                bucket(product['currency'])
        skus = set()
        for product in products.values():
            if product['voided'] or not product['sku']:
                continue
            sku = product['sku'].casefold()
            if sku in skus:
                raise FinanceError('An active product already uses this SKU', 409)
            skus.add(sku)

        # Same-date ordering is stable by creation ID, matching the recorded ledger.
        for movement in sorted(result['movements'], key=lambda m: (m['date'], m['id'])):
            project_id = movement.get('project_id')
            project = projects.get(project_id) if project_id is not None else None
            if project_id is not None:
                if project is None or (project['voided'] and not movement['voided']):
                    raise FinanceError('Choose an active project')
                project['movement_ids'].append(movement['id'])
                if not movement['voided']:
                    project['active_movement_ids'].append(movement['id'])
            movement.update(project_id=project_id, project_name=None if project is None else project['name'])
            product = products.get(movement['product_id'])
            if product is None or (product['voided'] and not movement['voided']):
                raise FinanceError('Choose an active product')
            qty = money(movement['quantity'])
            price = money(movement['unit_price'])
            initial = money(movement['paid_amount'])
            invoice_currency, rate = resolve_currency_rate(movement, product['currency'])
            extra = _inventory_payments(movement, invoice_currency)
            total = rounded(qty * price)
            base_total = rounded(total * rate)
            paid = initial + extra
            if paid > total:
                raise FinanceError('Payments cannot exceed the movement total')
            if movement['kind'] == 'opening' and (initial or movement.get('payments')):
                raise FinanceError('Opening inventory cannot have payments')
            movement.update(currency=invoice_currency, base_currency=product['currency'],
                            exchange_rate=rate, base_total=base_total, quantity=qty, unit_price=price,
                            total=total, initial_paid_amount=initial, paid_amount=paid,
                            remaining_payment=ZERO if movement['voided'] or movement['kind'] == 'opening' else total - paid,
                            cost_of_goods=ZERO, realized_profit=ZERO,
                            status='void' if movement['voided'] else 'paid' if paid == total or movement['kind'] == 'opening'
                            else 'partial' if paid else 'unpaid')
            if movement['voided']:
                continue
            values = bucket(invoice_currency)
            base_values = bucket(product['currency'])
            if movement['kind'] in ('purchase', 'opening'):
                product['quantity'] += qty
                product['inventory_cost'] += base_total
                if movement['kind'] == 'purchase':
                    values['purchase_total'] += total
                    values['payable'] += total - paid
            else:
                if qty > product['quantity']:
                    raise FinanceError(f'Insufficient inventory for {product["name"]} on {movement["date"]}; check earlier stock records')
                # Selling the last unit clears the full remaining cost, including rounding.
                cost = product['inventory_cost'] if qty == product['quantity'] else rounded(
                    product['inventory_cost'] * qty / product['quantity'])
                movement['cost_of_goods'] = cost
                movement['realized_profit'] = base_total - cost
                product['quantity'] -= qty
                product['inventory_cost'] -= cost
                product['realized_profit'] += base_total - cost
                values['sales_total'] += total
                values['receivable'] += total - paid
                base_values['realized_profit'] += base_total - cost
            product['average_cost'] = rounded(product['inventory_cost'] / product['quantity']) if product['quantity'] else ZERO
        for product in products.values():
            if not product['voided']:
                bucket(product['currency'])['inventory_cost'] += product['inventory_cost']
    result['summary'] = [summary[c] for c in sorted(summary)]
    for collection in ('transfers', 'loans', 'movements', 'exchanges', 'projects'):
        result[collection].sort(key=lambda r: (r['date'], r['id']), reverse=True)
    result['products'].sort(key=lambda r: (r['voided'], r['name'].casefold(), r['id']))
    return json_numbers(result)


def json_numbers(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: json_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_numbers(item) for item in value]
    return value
