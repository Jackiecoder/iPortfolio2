"""Covered-call cash flow and estimated intraday short-option P&L.

Yahoo supplies no bid/ask timestamp. Every mark here is a *retrieved reference
midpoint*, never an exchange close or an actual fill. Nothing writes trades.
"""
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import logging
import threading
import time as monotonic_time
from zoneinfo import ZoneInfo

from .db import get_pool
from .option_price_service import option_price_service

ET = ZoneInfo('America/New_York')
UTC = timezone.utc
D = Decimal
logger = logging.getLogger(__name__)
MAX_AGE = timedelta(seconds=120)
MARK_MAX_AGE = timedelta(minutes=6)
BASIS = 'Estimated from recorded reference midpoints; Yahoo quotes may be delayed 15 minutes and have no bid/ask timestamp.'


def instant(value):
    value = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('A quote timestamp must include a timezone')
    return value.astimezone(UTC)


def trade_at(row):
    return datetime.combine(date.fromisoformat(str(row['date'])), time.fromisoformat(str(row.get('transaction_time') or '09:30')), ET)


def money(value):
    return float(D(value).quantize(D('.01'), rounding=ROUND_HALF_UP))


def contract_key(opening):
    return (opening['asset'].upper(), str(opening['expiration']), format(D(str(opening['strike'])).normalize(), 'f'))


def session_schedule(day):
    """NYSE calendar supplies actual holidays and early closes without network."""
    import pandas_market_calendars as calendars
    day = day if isinstance(day, date) else date.fromisoformat(day)
    schedule = calendars.get_calendar('NYSE').schedule(start_date=day-timedelta(days=20), end_date=day)
    prior, current = None, None
    for index, row in schedule.iterrows():
        item = {'date': index.date(), 'open': row['market_open'].to_pydatetime(), 'close': row['market_close'].to_pydatetime()}
        if item['date'] < day:
            prior = item
        elif item['date'] == day:
            current = item
    return {'previous': prior, 'current': current}


def _valid_snapshot(row):
    try:
        bid, ask, mid = (D(str(row[name])) for name in ('bid', 'ask', 'mid'))
        if not all(v.is_finite() and v > 0 for v in (bid, ask, mid)) or bid > ask:
            return False
        if abs(mid-(bid+ask)/2) > D('.000001'):
            return False
        instant(row['captured_at'])
        return bool(row.get('source')) and row.get('quote_at') is None
    except (ValueError, TypeError, KeyError, InvalidOperation):
        return False


def snapshots_from_chain(chain, now):
    """Keep original retrieval time; cached/stale data can never acquire a new one."""
    if chain.get('cache_status') == 'stale':
        return []
    try:
        captured = instant(chain['fetched_at'])
        if not timedelta(0) <= instant(now)-captured <= MAX_AGE:
            return []
        result = []
        for quote in chain.get('calls', []):
            row = {'asset': chain['symbol'], 'expiration': chain['expiration'], 'strike': quote['strike'],
                   'contract_symbol': quote['contract_symbol'], 'bid': quote.get('bid'), 'ask': quote.get('ask'),
                   'mid': quote.get('mid'), 'source': chain.get('source'), 'captured_at': captured.isoformat(),
                   'quote_at': quote.get('quote_at')}
            if quote.get('quote_status') == 'two_sided' and _valid_snapshot(row):
                result.append(row)
        return result
    except (ValueError, TypeError, KeyError):
        return []


def save_snapshots(rows):
    """Idempotent quote persistence only. No portfolio/transaction writes."""
    rows = [row for row in rows if _valid_snapshot(row)]
    if not rows:
        return 0
    with get_pool().connection() as conn:
        for row in rows:
            conn.execute('''INSERT INTO option_quote_snapshots
                (asset, expiration, strike, contract_symbol, captured_at, bid, ask, mid, source)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                (row['asset'], row['expiration'], row['strike'], row['contract_symbol'], row['captured_at'],
                 row['bid'], row['ask'], row['mid'], row['source']))
    return len(rows)


def load_snapshots(day):
    start = datetime.combine(day-timedelta(days=21), time(), ET)
    end = datetime.combine(day+timedelta(days=1), time(), ET)
    with get_pool().connection() as conn:
        result = conn.execute('''SELECT asset, expiration, strike, contract_symbol, captured_at, bid, ask, mid, source
            FROM option_quote_snapshots WHERE captured_at >= %s AND captured_at < %s ORDER BY captured_at''', (start, end)).fetchall()
    keys = ('asset', 'expiration', 'strike', 'contract_symbol', 'captured_at', 'bid', 'ask', 'mid', 'source')
    return [dict(zip(keys, row)) for row in result]


def save_contract_checks(rows):
    if not rows:
        return
    with get_pool().connection() as conn:
        for row in rows:
            conn.execute("""INSERT INTO option_contract_checks (call_id, market_date, adjustment_factor, checked_at)
                VALUES (%s,%s,%s,%s) ON CONFLICT (call_id, market_date) DO UPDATE
                SET adjustment_factor = EXCLUDED.adjustment_factor, checked_at = EXCLUDED.checked_at""",
                (row['call_id'], row['market_date'], row['adjustment_factor'], row['checked_at']))


def load_contract_checks(day):
    with get_pool().connection() as conn:
        rows = conn.execute('SELECT call_id, adjustment_factor FROM option_contract_checks WHERE market_date = %s', (day,)).fetchall()
    return {row[0]: D(row[1]) for row in rows}


def _reference(rows, session):
    if not session:
        return None
    # OPRA is delayed. This is explicitly a close-session reference *estimate*,
    # not a provider-certified close; never substitute Last or earlier days.
    start, end = session['close']+timedelta(minutes=30), session['close']+timedelta(minutes=45)
    return next((r for r in reversed(rows) if start <= instant(r['captured_at']) <= end), None)


def _mark(rows, at, schedule):
    current = schedule.get('current')
    # Closed-market carry uses the recorded closing-session reference only.
    # It cannot fill a trading-session hole or use a snapshot from the future.
    if not current or at < current['open']:
        ref = _reference(rows, schedule.get('previous'))
        return ref if ref and instant(ref['captured_at']) <= at else None
    if at > current['close']+timedelta(minutes=45):
        ref = _reference(rows, current)
        return ref if ref and instant(ref['captured_at']) <= at else None
    return next((r for r in reversed(rows) if timedelta(0) <= at-instant(r['captured_at']) <= MARK_MAX_AGE), None)


def decorate_option_points(points, day, raw_calls, snapshots, schedule, adjusted_call_ids=(), adjustment_unknown_ids=()):
    """Pure event replay; existing holding P&L and all old fields stay intact."""
    day = day if isinstance(day, date) else date.fromisoformat(day)
    start = datetime.combine(day, time(), ET)
    by_contract = {}
    for row in snapshots:
        if _valid_snapshot(row):
            by_contract.setdefault(contract_key(row), []).append(row)
    for rows in by_contract.values():
        rows.sort(key=lambda r: instant(r['captured_at']))
    adjusted = set(adjusted_call_ids)
    unknown_adjustment = set(adjustment_unknown_ids)
    results = []
    for point in points:
        at = instant(point['as_of']) if point.get('as_of') else datetime.combine(day, time.fromisoformat(point['time']), ET)
        if at.astimezone(ET).date() != day:
            raise ValueError('Point timestamp does not belong to its market date')
        details = []
        for call in raw_calls:
            op = call['opening']
            opened = trade_at(op)
            if opened > at:
                continue
            events = sorted(call.get('events', []), key=trade_at)
            opening_qty = int(op['contracts']) if opened < start else 0
            opening_qty -= sum(int(e['contracts']) for e in events if trade_at(e) < start)
            today_events = [e for e in events if start <= trade_at(e) <= at]
            opened_today = start <= opened <= at
            if opening_qty <= 0 and not opened_today:
                continue
            qty = opening_qty + (int(op['contracts']) if opened_today else 0) - sum(int(e['contracts']) for e in today_events)
            premium = D(str(op['premium']))*int(op['contracts'])*100 if opened_today else D(0)
            buybacks = sum((D(str(e.get('premium', 0)))*int(e['contracts'])*100 for e in today_events if e['action'] in ('CLOSE', 'ROLL')), D(0))
            fees = (D(str(op.get('fees', 0))) if opened_today else D(0)) + sum((D(str(e.get('fees', 0))) for e in today_events), D(0))
            cash = premium-buybacks-fees
            rows = by_contract.get(contract_key(op), [])
            baseline = _reference(rows, schedule.get('previous')) if opening_qty else None
            mark = _mark(rows, at, schedule) if qty else None
            if mark and instant(mark['captured_at']) < opened:
                mark = None
            expiration = date.fromisoformat(str(op['expiration']))
            expired_pending = qty and (expiration < day or (expiration == day and schedule.get('current')
                                        and at >= schedule['current']['close']))
            reason = None
            if expired_pending:
                reason = 'expired_outcome_pending'
            elif call['id'] in adjusted or call.get('adjustment_required'):
                reason = 'adjusted_contract'
            elif call['id'] in unknown_adjustment:
                reason = 'contract_adjustment_unverified'
            elif any(e['action'] == 'ASSIGN' and trade_at(e).replace(second=0, microsecond=0) <= at < trade_at(e) for e in events):
                reason = 'assignment_timing_unaligned'
            elif qty < 0 or opening_qty < 0:
                reason = 'invalid_contract_quantity'
            elif any(e['action'] == 'ASSIGN' and not e.get('stock_transaction_id') for e in today_events):
                reason = 'assignment_stock_sale_unconfirmed'
            elif opening_qty and not baseline:
                reason = 'missing_previous_session_reference'
            elif qty and not mark:
                reason = 'missing_recent_reference_quote'
            # Physical assignment removes the short obligation. Stock replay
            # already records the linked share sale at strike: no intrinsic
            # cash debit is added here (that would charge delivery twice).
            pnl = None if reason else (D(str(baseline['mid']))*opening_qty*100 if opening_qty else D(0)) + cash - (D(str(mark['mid']))*qty*100 if qty else D(0))
            details.append({'id': call['id'], 'asset': op['asset'], 'symbol': op['asset'], 'broker': op.get('broker'),
                            'expiration': str(op['expiration']), 'strike': float(op['strike']), 'contracts': qty,
                            'opening_contracts': opening_qty, 'pnl': money(pnl) if pnl is not None else None,
                            'cash_flow': money(cash), 'premium_received': money(premium), 'buyback_cost': money(buybacks),
                            'fees': money(fees), 'reason': reason,
                            'asof': instant(mark['captured_at']).isoformat() if mark else None,
                            'baseline_asof': instant(baseline['captured_at']).isoformat() if baseline else None,
                            'baseline_mid': float(baseline['mid']) if baseline else None,
                            'current_mid': float(mark['mid']) if mark else None,
                            'reference_age_seconds': int((at-instant(mark['captured_at'])).total_seconds()) if mark else None})
        complete = all(row['pnl'] is not None for row in details)
        known = sum((D(str(row['pnl'])) for row in details if row['pnl'] is not None), D(0))
        stock = point.get('daily_pnl')
        current_session = schedule.get('current')
        result = {**point, 'holdings_daily_pnl': stock,
                  'option_daily_pnl': money(known) if complete else None,
                  'option_known_daily_pnl': money(known),
                  'combined_daily_pnl': money(D(str(stock))+known) if complete and stock is not None else None,
                  'options_complete': complete, 'options_present': bool(details), 'option_details': details,
                  'option_cash_flow': money(sum((D(str(r['cash_flow'])) for r in details), D(0))),
                  'option_premium_received': money(sum((D(str(r['premium_received'])) for r in details), D(0))),
                  'option_buyback_cost': money(sum((D(str(r['buyback_cost'])) for r in details), D(0))),
                  'option_fees': money(sum((D(str(r['fees'])) for r in details), D(0))),
                  'options_reasons': sorted(set(r['reason'] for r in details if r['reason'])),
                  'options_asof': min((r['asof'] for r in details if r['asof']), default=None),
                  'option_valuation_basis': BASIS,
                  'option_reference_age_seconds': max((r['reference_age_seconds'] for r in details if r['reference_age_seconds'] is not None), default=None),
                  'option_reference_carry_limit_seconds': int(MARK_MAX_AGE.total_seconds()),
                  'options_market_closed': not current_session or not current_session['open'] <= at <= current_session['close'],
                  'options_previous_session': str(schedule['previous']['date']) if schedule.get('previous') else None}
        results.append(result)
    return results


class OptionPnlService:
    """Bounded collection; quote failures never hold stock refresh indefinitely."""
    def __init__(self, quotes=None, clock=None, reader=None, writer=None, schedule_provider=None, check_reader=None, check_writer=None):
        self.quotes = quotes or option_price_service
        self.clock = clock or (lambda: datetime.now(UTC))
        self.reader = reader or load_snapshots
        self.writer = writer or save_snapshots
        self.check_reader = check_reader or load_contract_checks
        self.check_writer = check_writer or save_contract_checks
        self.schedule_provider = schedule_provider or session_schedule
        self.lock = threading.Lock()
        self.inflight = {}
        self.completed = {}
        self.completed_calls = {}
        self.attempted = {}
        self.adjustments = {}
        self.schedules = {}

    def schedule(self, day):
        with self.lock:
            cached = self.schedules.get(day)
        if cached is not None:
            return cached
        result = self.schedule_provider(day)
        with self.lock:
            self.schedules[day] = result
            if len(self.schedules) > 64:
                self.schedules.pop(next(iter(self.schedules)))
        return result

    @staticmethod
    def read_calls():
        from .covered_call_repository import read_calls
        with get_pool().connection() as conn:
            return read_calls(conn)

    @staticmethod
    def _factor(call, day):
        """A failed split request returns {}, so require a successful cached read."""
        from .split_service import split_service
        op = call['opening']
        opened = date.fromisoformat(op['date'])
        if opened >= day:
            return D(1)
        symbol = op['asset']
        splits = split_service.get_splits(symbol)
        cached = split_service._splits_cache.get(symbol)
        if not cached:
            raise ValueError('Corporate action status unavailable')
        checked_at = datetime.fromtimestamp(cached[1].timestamp(), UTC)
        # A cache from yesterday cannot rule out an effective split today.
        if checked_at.astimezone(ET).date() < day:
            split_service._splits_cache.pop(symbol, None)
            splits = split_service.get_splits(symbol)
            cached = split_service._splits_cache.get(symbol)
            if not cached or datetime.fromtimestamp(cached[1].timestamp(), UTC).astimezone(ET).date() < day:
                raise ValueError('Corporate action status unavailable')
        factor = D(1)
        for split_day, ratio in splits.items():
            if opened < split_day <= day:
                factor *= D(str(ratio))
        return factor

    def _worker(self, key, calls, done):
        success = False
        try:
            now = self.clock()
            day = now.astimezone(ET).date()
            clean, checks = [], []
            for call in calls:
                factor = self._factor(call, day)
                checks.append({'call_id': call['id'], 'market_date': day,
                               'adjustment_factor': factor, 'checked_at': now})
                op = call['opening']
                left = int(op['contracts'])-sum(int(e['contracts']) for e in call.get('events', []) if trade_at(e) <= now)
                if factor == 1 and left > 0 and date.fromisoformat(op['expiration']) >= day:
                    clean.append(call)
            self.check_writer(checks)
            with self.lock:
                for check in checks:
                    self.adjustments[(check['call_id'], day)] = check['adjustment_factor']
            if clean:
                chain = self.quotes.get_chain(*key)
                wanted = {contract_key(c['opening']) for c in clean}
                snapshots = [row for row in snapshots_from_chain(chain, self.clock()) if contract_key(row) in wanted]
                self.writer(snapshots)
                success = {contract_key(row) for row in snapshots} >= wanted
            else:
                success = True
        except Exception as exc:
            logger.warning('Option reference collection unavailable (%s)', type(exc).__name__)
        finally:
            with self.lock:
                self.completed[key] = success
                self.completed_calls[key] = {call['id'] for call in calls} if success else set()
                self.inflight.pop(key, None)
            done.set()

    def collect(self, raw_calls=None, timeout=8):
        calls = self.read_calls() if raw_calls is None else raw_calls
        now = self.clock()
        day = now.astimezone(ET).date()
        schedule = self.schedule(day)
        current = schedule.get('current')
        if not current or not current['open'] <= now <= current['close']+timedelta(minutes=45):
            return {'complete': True, 'market_closed': True, 'attempted': 0}
        grouped = {}
        for call in calls:
            op = call['opening']
            if trade_at(op) > now or date.fromisoformat(op['expiration']) < day:
                continue
            left = int(op['contracts'])-sum(int(e['contracts']) for e in call.get('events', []) if trade_at(e) <= now)
            has_today_event = any(trade_at(e).astimezone(ET).date() == day and trade_at(e) <= now for e in call.get('events', []))
            if left > 0 or has_today_event:
                grouped.setdefault((op['asset'], str(op['expiration'])), []).append(call)
        pending = []
        with self.lock:
            ordered = sorted(grouped, key=lambda key: self.attempted.get(key, datetime.min.replace(tzinfo=UTC)))
        for key in ordered:
            group = grouped[key]
            with self.lock:
                if key in self.inflight:
                    pending.append((key, self.inflight[key])); continue
                previous = self.attempted.get(key)
                if previous and now-previous < timedelta(seconds=45):
                    continue
                if len(self.inflight) >= 4:
                    continue
                done = threading.Event()
                self.inflight[key] = done
                self.attempted[key] = now
                self.completed[key] = False
                pending.append((key, done))
                threading.Thread(target=self._worker, args=(key, group, done), daemon=True).start()
        deadline = monotonic_time.monotonic()+max(0, min(float(timeout), 12))
        for _, done in pending:
            done.wait(max(0, deadline-monotonic_time.monotonic()))
        with self.lock:
            complete = all(self.completed.get(key, False) and key not in self.inflight
                           and {call['id'] for call in grouped[key]} <= self.completed_calls.get(key, set())
                           for key in grouped)
        return {'complete': complete, 'market_closed': False, 'attempted': len(pending)}

    def decorate(self, points, day, raw_calls=None, collect=True):
        if not points:
            return points
        day = day if isinstance(day, date) else date.fromisoformat(day)
        try:
            calls = self.read_calls() if raw_calls is None else raw_calls
            if not calls:
                return [{**point, 'options_collection_complete': True} for point in
                        decorate_option_points(points, day, [], [], {})]
            schedule = self.schedule(day)
            collected = self.collect(calls) if collect and day == self.clock().astimezone(ET).date() else {'complete': True}
            rows = self.reader(day) if calls else []
            checks = self.check_reader(day)
            with self.lock:
                checks.update({call_id: factor for (call_id, checked_day), factor in self.adjustments.items() if checked_day == day})
            adjusted = [call_id for call_id, factor in checks.items() if factor != 1]
            unverified = [call['id'] for call in calls if call['id'] not in checks]
            valuation_points = points
            if day == self.clock().astimezone(ET).date():
                # Stock's latest plotted minute carries its current realtime
                # valuation. Keep every earlier point strictly historical.
                last_minute = datetime.combine(day, time.fromisoformat(points[-1]['time']), ET)
                asof = min(self.clock(), last_minute+timedelta(minutes=1)-timedelta(microseconds=1))
                valuation_points = [*points[:-1], {**points[-1], 'as_of': asof.isoformat()}]
            decorated = decorate_option_points(valuation_points, day, calls, rows, schedule, adjusted, unverified)
            for point in decorated:
                point['options_collection_complete'] = collected['complete']
            return decorated
        except Exception as exc:
            logger.warning('Option daily estimate unavailable (%s)', type(exc).__name__)
            return [{**point, 'holdings_daily_pnl': point.get('daily_pnl'), 'option_daily_pnl': None,
                     'combined_daily_pnl': None, 'options_complete': False, 'options_present': True,
                     'option_cash_flow': None, 'option_premium_received': None, 'option_buyback_cost': None,
                     'option_fees': None, 'option_details': [], 'options_reasons': ['option_data_unavailable'],
                     'options_asof': None, 'option_valuation_basis': BASIS, 'options_collection_complete': False}
                    for point in points]


option_pnl_service = OptionPnlService()
