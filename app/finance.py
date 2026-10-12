"""Independent financial ledger, validated with exact decimal arithmetic.

Inventory uses chronological moving-average cost. These records never become
investment transactions or contribute to the portfolio's cash or performance.
"""
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal, localcontext
import re
from typing import Literal, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CURRENCIES = ('USD', 'CNY', 'HKD', 'EUR', 'GBP', 'CAD', 'JPY', 'AUD')
D = Decimal
ZERO = D(0)
PRECISION = D('0.000001')


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
                     'from_amount', 'to_amount', 'fee_amount',
                     mode='before', check_fields=False)
    @classmethod
    def exact_number(cls, value, info):
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
        if result < 0 or (result == 0 and info.field_name not in ('unit_price', 'paid_amount', 'fee_amount')):
            raise ValueError('Amount must be positive')
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


class MovementFields(FinanceModel):
    date: date
    product_id: int = Field(ge=1, strict=True)
    kind: Literal['purchase', 'sale', 'opening']
    quantity: Decimal
    unit_price: Decimal
    paid_amount: Decimal = D(0)
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


CREATE_MODELS = {'transfers': TransferCreate, 'loans': LoanCreate,
                 'products': ProductCreate, 'movements': MovementCreate,
                 'exchanges': ExchangeCreate}
UPDATE_MODELS = {'transfers': TransferUpdate, 'loans': LoanUpdate,
                 'products': ProductUpdate, 'movements': MovementUpdate,
                 'exchanges': ExchangeUpdate}


def request_data(request):
    """Stable canonical JSON, including decimal strings for storage/idempotency."""
    values = request.model_dump(mode='json')
    for key, value in request.model_dump().items():
        if isinstance(value, Decimal):
            values[key] = format(value.normalize(), 'f')
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


def validate_void(state, kind, record):
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


def replay(state):
    """Validate the entire ledger and derive balances, stock and sales costs."""
    result = deepcopy(state)
    result.setdefault('exchanges', [])
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
            product = products.get(movement['product_id'])
            if product is None or (product['voided'] and not movement['voided']):
                raise FinanceError('Choose an active product')
            qty = money(movement['quantity'])
            price = money(movement['unit_price'])
            initial = money(movement['paid_amount'])
            extra = _active_payments(movement, 'payments')
            total = rounded(qty * price)
            paid = initial + extra
            if paid > total:
                raise FinanceError('Payments cannot exceed the movement total')
            if movement['kind'] == 'opening' and (initial or movement.get('payments')):
                raise FinanceError('Opening inventory cannot have payments')
            movement.update(currency=product['currency'], quantity=qty, unit_price=price,
                            total=total, initial_paid_amount=initial, paid_amount=paid,
                            remaining_payment=ZERO if movement['voided'] or movement['kind'] == 'opening' else total - paid,
                            cost_of_goods=ZERO, realized_profit=ZERO,
                            status='void' if movement['voided'] else 'paid' if paid == total or movement['kind'] == 'opening'
                            else 'partial' if paid else 'unpaid')
            if movement['voided']:
                continue
            values = bucket(product['currency'])
            if movement['kind'] in ('purchase', 'opening'):
                product['quantity'] += qty
                product['inventory_cost'] += total
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
                movement['realized_profit'] = total - cost
                product['quantity'] -= qty
                product['inventory_cost'] -= cost
                product['realized_profit'] += total - cost
                values['sales_total'] += total
                values['receivable'] += total - paid
                values['realized_profit'] += total - cost
            product['average_cost'] = rounded(product['inventory_cost'] / product['quantity']) if product['quantity'] else ZERO
        for product in products.values():
            if not product['voided']:
                bucket(product['currency'])['inventory_cost'] += product['inventory_cost']
    result['summary'] = [summary[c] for c in sorted(summary)]
    for collection in ('transfers', 'loans', 'movements', 'exchanges'):
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
