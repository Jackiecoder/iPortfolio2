"""Transactional PostgreSQL persistence for the independent financial ledger."""
from copy import deepcopy
import json

from .db import get_pool
from .finance import (FinanceError, empty_state, find_record, replay, request_data,
                      require_version, validate_edit, validate_void)

# Fixed, separate from the investment ledger's lock. Every writer participates.
FINANCE_LOCK = 738190241
TABLES = {kind: 'finance_' + kind for kind in (
    'transfers', 'loans', 'products', 'movements', 'repayments', 'payments', 'exchanges', 'projects')}
CHILDREN = {'loans': 'repayments', 'movements': 'payments'}


def _read_state(conn):
    state = empty_state()
    for kind in state:
        rows = conn.execute(f'SELECT id, payload, version, voided FROM {TABLES[kind]} ORDER BY id').fetchall()
        state[kind] = [{**row[1], 'id': row[0], 'version': row[2], 'voided': row[3]}
                       for row in rows]
    for parent_kind, child_kind in CHILDREN.items():
        parents = {r['id']: r for r in state[parent_kind]}
        for parent in parents.values():
            parent[child_kind] = []
        rows = conn.execute(f'SELECT id, parent_id, payload, version, voided FROM {TABLES[child_kind]} ORDER BY id').fetchall()
        for row in rows:
            parents[row[1]][child_kind].append({**row[2], 'id': row[0], 'version': row[3], 'voided': row[4]})
    return state


def list_finance():
    with get_pool().connection() as conn:
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
        return replay(_read_state(conn))


def _lock(conn):
    conn.execute('SELECT pg_advisory_xact_lock(%s)', (FINANCE_LOCK,))


def _next_id(conn, kind):
    return conn.execute('SELECT nextval(pg_get_serial_sequence(%s, %s))',
                        (TABLES[kind], 'id')).fetchone()[0]


def _payload(record):
    return {key: value for key, value in record.items()
            if key not in ('id', 'version', 'voided', 'repayments', 'payments')}


def _audit(conn, kind, record_id, action, before, after):
    conn.execute('''INSERT INTO finance_audit (entity_kind, entity_id, action, before_data, after_data)
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb)''',
                 (kind, record_id, action, json.dumps(before), json.dumps(after)))


def _idempotent(conn, request_id, kind, parent_id, payload):
    found = False
    for table in ('finance_requests', 'finance_project_requests'):
        prior = conn.execute(f'SELECT entity_kind, parent_id, request_payload FROM {table} WHERE request_id = %s',
                             (request_id,)).fetchone()
        if prior is not None:
            if prior[0] != kind or prior[1] != parent_id or prior[2] != payload:
                raise FinanceError('This request was already saved with different values; refresh and try again', 409)
            found = True
    return found


def _remember(conn, kind, parent_id, record_id, payload):
    table = 'finance_project_requests' if kind == 'projects' else 'finance_requests'
    conn.execute(f'''INSERT INTO {table}
                    (request_id, entity_kind, parent_id, entity_id, request_payload)
                    VALUES (%s, %s, %s, %s, %s::jsonb)''',
                 (payload['request_id'], kind, parent_id, record_id, json.dumps(payload)))


def create_record(kind, request):
    payload = request_data(request)
    with get_pool().connection() as conn:
        _lock(conn)
        state = _read_state(conn)
        if _idempotent(conn, payload['request_id'], kind, None, payload):
            return replay(state)
        record = {**payload, 'id': _next_id(conn, kind), 'version': 1, 'voided': False}
        if kind in CHILDREN:
            record[CHILDREN[kind]] = []
        state[kind].append(record)
        result = replay(state)
        conn.execute(f'INSERT INTO {TABLES[kind]} (id, payload) VALUES (%s, %s::jsonb)',
                     (record['id'], json.dumps(payload)))
        _remember(conn, kind, None, record['id'], payload)
        _audit(conn, kind, record['id'], 'create', None, record)
    return result


def update_record(kind, record_id, request):
    values = request_data(request)
    version = values.pop('version')
    with get_pool().connection() as conn:
        _lock(conn)
        state = _read_state(conn)
        record = find_record(state, kind, record_id, active=True)
        require_version(record, version)
        validate_edit(state, kind, record, values)
        before = deepcopy(record)
        if kind == 'movements':
            old_product = find_record(state, 'products', record['product_id'])
            new_product = find_record(state, 'products', values['product_id'])
            old_currency = record.get('currency') or old_product['currency']
            if new_product['currency'] != old_product['currency'] and not values.get('currency'):
                record['currency'] = old_currency
            currency_changed = values.get('currency', old_currency) != old_currency
            base_changed = new_product['currency'] != old_product['currency']
            if (currency_changed or base_changed) and 'exchange_rate' not in values:
                record.pop('exchange_rate', None)
            # The update model describes a complete price input. Remove the old
            # mode before merging so total-only edits never retain a stale price.
            for field in ('quantity', 'unit_price', 'total_amount'):
                if field not in values:
                    record.pop(field, None)
        record.update(values)
        record['version'] += 1
        result = replay(state)
        conn.execute(f'UPDATE {TABLES[kind]} SET payload = %s::jsonb, version = %s, updated_at = now() WHERE id = %s',
                     (json.dumps(_payload(record)), record['version'], record_id))
        _audit(conn, kind, record_id, 'update', before, record)
    return result


def void_record(kind, record_id, version):
    with get_pool().connection() as conn:
        _lock(conn)
        state = _read_state(conn)
        record = find_record(state, kind, record_id, active=True)
        require_version(record, version)
        validate_void(state, kind, record)
        before = deepcopy(record)
        record['version'] += 1
        record['voided'] = True
        result = replay(state)
        conn.execute(f'UPDATE {TABLES[kind]} SET voided = TRUE, version = %s, updated_at = now() WHERE id = %s',
                     (record['version'], record_id))
        _audit(conn, kind, record_id, 'void', before, record)
    return result


def create_payment(parent_kind, parent_id, request):
    kind = CHILDREN[parent_kind]
    payload = request_data(request)
    with get_pool().connection() as conn:
        _lock(conn)
        state = _read_state(conn)
        if _idempotent(conn, payload['request_id'], kind, parent_id, payload):
            return replay(state)
        parent = find_record(state, parent_kind, parent_id, active=True)
        before_parent = deepcopy(parent)
        payment = {**payload, 'id': _next_id(conn, kind), 'version': 1, 'voided': False}
        parent[kind].append(payment)
        parent['version'] += 1
        result = replay(state)
        conn.execute(f'INSERT INTO {TABLES[kind]} (id, parent_id, payload) VALUES (%s, %s, %s::jsonb)',
                     (payment['id'], parent_id, json.dumps(payload)))
        conn.execute(f'UPDATE {TABLES[parent_kind]} SET version = %s, updated_at = now() WHERE id = %s',
                     (parent['version'], parent_id))
        _remember(conn, kind, parent_id, payment['id'], payload)
        _audit(conn, kind, payment['id'], 'create', None, payment)
        _audit(conn, parent_kind, parent_id, 'add_payment', before_parent, parent)
    return result


def void_payment(parent_kind, parent_id, payment_id, version):
    kind = CHILDREN[parent_kind]
    with get_pool().connection() as conn:
        _lock(conn)
        state = _read_state(conn)
        parent = find_record(state, parent_kind, parent_id, active=True)
        payment = next((p for p in parent[kind] if p['id'] == payment_id), None)
        if payment is None:
            raise FinanceError('Payment not found', 404)
        require_version(payment, version)
        if payment['voided']:
            raise FinanceError('This payment has been voided', 409)
        before_parent, before = deepcopy(parent), deepcopy(payment)
        payment['version'] += 1
        payment['voided'] = True
        parent['version'] += 1
        result = replay(state)
        conn.execute(f'UPDATE {TABLES[kind]} SET voided = TRUE, version = %s, updated_at = now() WHERE id = %s',
                     (payment['version'], payment_id))
        conn.execute(f'UPDATE {TABLES[parent_kind]} SET version = %s, updated_at = now() WHERE id = %s',
                     (parent['version'], parent_id))
        _audit(conn, kind, payment_id, 'void', before, payment)
        _audit(conn, parent_kind, parent_id, 'void_payment', before_parent, parent)
    return result
