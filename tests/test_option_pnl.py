"""Deterministic short-call accounting and reference-price boundary tests."""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import threading
import time
import unittest
from unittest.mock import patch

from app.option_pnl_service import (OptionPnlService, contract_key, decorate_option_points,
                                    session_schedule, snapshots_from_chain)

UTC = timezone.utc
DAY = date(2026, 9, 30)
NOW = datetime(2026, 9, 30, 14, 0, 23, tzinfo=UTC)
SCHEDULE = {'previous': {'date': date(2026, 9, 29), 'open': datetime(2026, 9, 29, 13, 30, tzinfo=UTC), 'close': datetime(2026, 9, 29, 20, tzinfo=UTC)},
            'current': {'date': DAY, 'open': datetime(2026, 9, 30, 13, 30, tzinfo=UTC), 'close': datetime(2026, 9, 30, 20, tzinfo=UTC)}}


def call(call_id=1, **updates):
    op = {'asset': 'MRVL', 'broker': 'Fidelity', 'date': '2026-09-25', 'transaction_time': '10:00:00',
          'expiration': '2026-10-30', 'strike': '280', 'contracts': 1, 'premium': '15', 'fees': '.65'}
    op.update(updates)
    return {'id': call_id, 'opening': op, 'events': []}


def event(action='CLOSE', **updates):
    row = {'action': action, 'date': '2026-09-30', 'transaction_time': '09:45:00', 'contracts': 1, 'premium': '14', 'fees': '.65'}
    row.update(updates)
    return row


def snapshot(mid=13.5, at='2026-09-30T14:00:00+00:00', **updates):
    row = {'asset': 'MRVL', 'expiration': '2026-10-30', 'strike': 280.0, 'contract_symbol': 'MRVL261030C00280000',
           'captured_at': at, 'bid': mid-.1, 'ask': mid+.1, 'mid': mid, 'source': 'Yahoo Finance'}
    row.update(updates)
    return row


def baseline(mid=12, **updates):
    return snapshot(mid, '2026-09-29T20:35:00+00:00', **updates)


def point(at='10:00', stock=1000):
    return {'time': at, 'daily_pnl': stock, 'daily_pnl_percent': 2.0, 'asset_changes': [{'symbol': 'MRVL', 'pnl': stock}]}


def calculate(calls, snapshots=None, points=None, **kwargs):
    return decorate_option_points(points or [point()], DAY, calls,
                                  [baseline(), snapshot()] if snapshots is None else snapshots, SCHEDULE, **kwargs)


class OptionPnlReplayTests(unittest.TestCase):
    def test_prior_short_daily_loss_is_not_opening_lifetime_profit(self):
        original = point()
        result = calculate([call()], points=[original])[0]
        self.assertEqual(result['option_daily_pnl'], -150)
        self.assertEqual(result['combined_daily_pnl'], 850)
        self.assertEqual(result['option_cash_flow'], 0)
        self.assertEqual(result['daily_pnl'], original['daily_pnl'])
        self.assertEqual(result['asset_changes'], original['asset_changes'])
        self.assertNotIn('option_daily_pnl', original)
        self.assertEqual(result['option_details'][0]['baseline_mid'], 12)

    def test_open_today_cash_received_is_not_daily_profit(self):
        result = calculate([call(date='2026-09-30', transaction_time='09:35:00', premium='13')], [snapshot(12)])[0]
        self.assertEqual(result['option_daily_pnl'], 99.35)
        self.assertEqual(result['option_cash_flow'], 1299.35)
        self.assertEqual(result['option_premium_received'], 1300)
        self.assertEqual(result['option_fees'], .65)
        self.assertIsNone(result['option_details'][0]['baseline_mid'])

    def test_partial_buyback_replays_contracts_fees_and_cash(self):
        op = call(contracts=2)
        op['events'] = [event()]
        result = calculate([op], [baseline(), snapshot(13)])[0]
        self.assertEqual(result['option_daily_pnl'], -300.65)
        self.assertEqual(result['option_cash_flow'], -1400.65)
        self.assertEqual(result['option_details'][0]['contracts'], 1)

    def test_roll_is_two_legs_and_preserves_loss(self):
        old = call()
        old['events'] = [event('ROLL')]
        new = call(2, date='2026-09-30', transaction_time='09:45:00', strike='290', premium='16')
        result = calculate([old, new], [baseline(), snapshot(15, strike=290)])[0]
        self.assertEqual(result['option_daily_pnl'], -101.30)
        self.assertEqual(result['option_cash_flow'], 198.70)
        self.assertEqual(result['option_buyback_cost'], 1400)
        self.assertEqual(result['option_fees'], 1.3)

    def test_assignment_has_no_second_intrinsic_cash_debit(self):
        op = call()
        op['events'] = [event('ASSIGN', premium='0', fees='0', stock_transaction_id=42)]
        result = calculate([op], [baseline()], [point(stock=-1000)])[0]
        self.assertEqual(result['option_daily_pnl'], 1200)
        self.assertEqual(result['combined_daily_pnl'], 200)
        self.assertEqual(result['option_cash_flow'], 0)
        self.assertIsNone(result['option_details'][0]['current_mid'])

    def test_assignment_without_linked_stock_sale_is_not_a_complete_total(self):
        op = call(); op['events'] = [event('ASSIGN', premium='0')]
        result = calculate([op])[0]
        self.assertIsNone(result['combined_daily_pnl'])
        self.assertIn('assignment_stock_sale_unconfirmed', result['options_reasons'])

    def test_confirmed_expiry_releases_liability_and_fees(self):
        op = call(expiration='2026-09-30')
        op['events'] = [event('EXPIRE', transaction_time='16:00', premium='0', fees='.15')]
        result = calculate([op], [baseline(1, expiration='2026-09-30')], [point('16:01')])[0]
        self.assertEqual(result['option_daily_pnl'], 99.85)

    def test_expired_unresolved_position_never_assumes_zero_liability(self):
        result = calculate([call(expiration='2026-09-29')], [baseline(expiration='2026-09-29')])[0]
        self.assertIsNone(result['option_daily_pnl'])
        self.assertIn('expired_outcome_pending', result['options_reasons'])

    def test_same_day_fully_closed_needs_no_quote_or_prior_baseline(self):
        op = call(date='2026-09-30', transaction_time='09:35', premium='13')
        op['events'] = [event(premium='12')]
        result = calculate([op], [])[0]
        self.assertEqual(result['option_daily_pnl'], 98.70)
        self.assertEqual(result['option_cash_flow'], 98.70)

    def test_prior_day_fully_closed_still_requires_prior_session_reference(self):
        op = call(); op['events'] = [event()]
        result = calculate([op], [])[0]
        self.assertIsNone(result['option_daily_pnl'])
        self.assertEqual(result['option_cash_flow'], -1400.65)

    def test_partial_close_before_today_reduces_baseline_quantity(self):
        op = call(contracts=3, fees='6')
        op['events'] = [event(date='2026-09-29', contracts=2)]
        result = calculate([op])[0]
        self.assertEqual(result['option_daily_pnl'], -150)
        self.assertEqual(result['option_fees'], 0)
        self.assertEqual(result['option_details'][0]['opening_contracts'], 1)

    def test_no_options_is_complete_zero_contribution(self):
        result = calculate([])[0]
        self.assertFalse(result['options_present'])
        self.assertTrue(result['options_complete'])
        self.assertEqual(result['combined_daily_pnl'], 1000)

    def test_future_open_and_future_event_cannot_change_earlier_points(self):
        op = call(date='2026-09-30', transaction_time='10:01')
        self.assertFalse(calculate([op])[0]['options_present'])
        op = call(); op['events'] = [event(transaction_time='10:01')]
        self.assertEqual(calculate([op])[0]['option_daily_pnl'], -150)

    def test_no_future_backfill_and_no_stale_carry_during_market(self):
        points = [point('09:59'), point('10:00'), point('10:06'), point('10:07')]
        result = calculate([call()], points=points)
        self.assertIsNone(result[0]['option_daily_pnl'])
        self.assertEqual(result[1]['option_daily_pnl'], -150)
        self.assertEqual(result[2]['option_daily_pnl'], -150)
        self.assertIsNone(result[3]['option_daily_pnl'])

    def test_baseline_is_previous_real_session_and_after_delayed_close_window(self):
        for row in [snapshot(12, '2026-09-29T19:59:00+00:00'), snapshot(12, '2026-09-29T20:29:59+00:00'),
                    snapshot(12, '2026-09-29T20:45:01+00:00'), snapshot(12, '2026-09-28T20:35:00+00:00')]:
            self.assertIsNone(calculate([call()], [row, snapshot()])[0]['option_daily_pnl'])

    def test_partial_unknown_total_is_null_with_known_subtotal(self):
        result = calculate([call(), call(2, strike='290')])[0]
        self.assertIsNone(result['combined_daily_pnl'])
        self.assertEqual(result['option_known_daily_pnl'], -150)
        self.assertEqual(len(result['option_details']), 2)

    def test_accounts_remain_distinct_even_same_contract(self):
        result = calculate([call(), call(2, broker='Schwab')])[0]
        self.assertEqual(result['option_daily_pnl'], -300)
        self.assertEqual({r['broker'] for r in result['option_details']}, {'Fidelity', 'Schwab'})

    def test_adjusted_contract_is_incomplete(self):
        result = calculate([call()], adjusted_call_ids=[1])[0]
        self.assertIn('adjusted_contract', result['options_reasons'])
        self.assertIsNone(result['combined_daily_pnl'])

    def test_explicit_asof_supports_latest_seconds_without_future_leak(self):
        points = [point('09:59'), {**point(), 'as_of': NOW.isoformat()}]
        result = calculate([call()], [baseline(), snapshot(at=NOW.isoformat())], points)
        self.assertIsNone(result[0]['option_daily_pnl'])
        self.assertEqual(result[1]['option_daily_pnl'], -150)
        self.assertEqual(result[1]['options_asof'], NOW.isoformat())

    def test_closed_market_carry_requires_recorded_session_reference(self):
        before = calculate([call()], [baseline()], [point('08:00')])[0]
        self.assertEqual(before['option_daily_pnl'], 0)
        self.assertTrue(before['options_market_closed'])
        after = calculate([call()], [baseline(), snapshot(13, '2026-09-30T20:35:00+00:00')], [point('18:00')])[0]
        self.assertEqual(after['option_daily_pnl'], -100)
        after_gap = calculate([call()], [baseline(), snapshot(13, '2026-09-30T19:59:00+00:00')], [point('18:00')])[0]
        self.assertIsNone(after_gap['option_daily_pnl'])

    def test_early_close_window_uses_calendar_close(self):
        early = deepcopy(SCHEDULE)
        early['previous']['close'] = datetime(2026, 9, 29, 17, tzinfo=UTC)
        result = decorate_option_points([point()], DAY, [call()], [snapshot(12, '2026-09-29T17:35:00+00:00'), snapshot()], early)[0]
        self.assertEqual(result['option_daily_pnl'], -150)

    def test_holiday_and_early_close_calendar(self):
        # Thanksgiving Friday; previous market session is Wednesday, not Thursday.
        schedule = session_schedule(date(2026, 11, 27))
        self.assertEqual(schedule['previous']['date'], date(2026, 11, 25))
        self.assertEqual(schedule['current']['close'].hour, 18)  # 13:00 Eastern standard time
        self.assertIsNone(session_schedule(date(2026, 11, 26))['current'])


class SnapshotCollectorTests(unittest.TestCase):
    def chain(self):
        return {'symbol': 'MRVL', 'expiration': '2026-10-30', 'fetched_at': NOW.isoformat(), 'source': 'Yahoo Finance',
                'cache_status': 'fresh', 'calls': [{'contract_symbol': 'MRVL261030C00280000', 'strike': 280,
                 'bid': 12.9, 'ask': 13.1, 'mid': 13, 'last': 99, 'quote_at': None, 'quote_status': 'two_sided'}]}

    def test_only_valid_mid_unchanged_fetch_time_is_persistable(self):
        chain = self.chain()
        rows = snapshots_from_chain(chain, NOW)
        self.assertEqual(rows[0]['captured_at'], NOW.isoformat())
        self.assertEqual(rows[0]['mid'], 13)
        for update in [{'bid': 0}, {'ask': 12}, {'mid': None}, {'mid': 14}, {'quote_status': 'one_sided'}]:
            bad = deepcopy(chain); bad['calls'][0].update(update)
            self.assertEqual(snapshots_from_chain(bad, NOW), [])
        for age in [-1, 121]:
            self.assertEqual(snapshots_from_chain(chain, NOW+timedelta(seconds=age)), [])
        chain['cache_status'] = 'stale'
        self.assertEqual(snapshots_from_chain(chain, NOW), [])

    @patch.object(OptionPnlService, '_factor', return_value=Decimal(1))
    def test_collect_persists_completed_results_before_return(self, _):
        class Quotes:
            def get_chain(inner, *args): return self.chain()
        saved = []
        service = OptionPnlService(quotes=Quotes(), clock=lambda: NOW, writer=lambda rows: saved.extend(rows), check_writer=lambda _: None, schedule_provider=lambda _: SCHEDULE)
        result = service.collect([call()])
        self.assertTrue(result['complete'])
        self.assertEqual(len(saved), 1)
        self.assertEqual(contract_key(saved[0]), contract_key(call()['opening']))

    @patch.object(OptionPnlService, '_factor', return_value=Decimal(1))
    def test_hung_provider_is_bounded_and_has_at_most_four_workers(self, _):
        gate = threading.Event()
        class Quotes:
            def get_chain(inner, *args):
                gate.wait(3)
                raise RuntimeError('Unavailable')
        service = OptionPnlService(quotes=Quotes(), clock=lambda: NOW, writer=lambda _: None, check_writer=lambda _: None, schedule_provider=lambda _: SCHEDULE)
        calls = [call(i, asset='TICK'+str(i)) for i in range(6)]
        started = time.monotonic()
        result = service.collect(calls, timeout=.03)
        self.assertLess(time.monotonic()-started, .5)
        self.assertFalse(result['complete'])
        self.assertEqual(len(service.inflight), 4)
        service.collect(calls, timeout=0)
        self.assertEqual(len(service.inflight), 4)
        gate.set()

    def test_outside_market_collection_never_renews_old_quote_timestamps(self):
        service = OptionPnlService(clock=lambda: NOW.replace(hour=22), schedule_provider=lambda _: SCHEDULE)
        with patch.object(service.quotes, 'get_chain') as get_chain:
            self.assertTrue(service.collect([call()])['market_closed'])
            get_chain.assert_not_called()

    def test_service_latest_asof_and_history_no_collection(self):
        service = OptionPnlService(clock=lambda: NOW, reader=lambda _: [baseline(), snapshot(at=NOW.isoformat())], check_reader=lambda _: {1: Decimal(1)}, schedule_provider=lambda _: SCHEDULE)
        result = service.decorate([point('09:59'), point()], DAY, [call()], collect=False)
        self.assertIsNone(result[0]['option_daily_pnl'])
        self.assertEqual(result[-1]['option_daily_pnl'], -150)
        self.assertEqual(result[-1]['as_of'], NOW.isoformat())
        with patch.object(service, 'collect') as collect:
            service.decorate([point()], date(2026, 9, 29), [call()])
            collect.assert_not_called()

    def test_quote_db_failure_keeps_stock_numbers_and_unknown_option_total(self):
        def fail(_): raise RuntimeError('db unavailable')
        service = OptionPnlService(reader=fail, schedule_provider=lambda _: SCHEDULE, clock=lambda: NOW)
        result = service.decorate([point()], DAY, [call()], collect=False)[0]
        self.assertEqual(result['daily_pnl'], 1000)
        self.assertIsNone(result['combined_daily_pnl'])
        self.assertFalse(result['options_collection_complete'])

    def test_empty_ledger_needs_neither_quote_db_nor_calendar(self):
        def fail(_): raise AssertionError('No market lookups for empty ledger')
        service = OptionPnlService(reader=fail, schedule_provider=fail)
        result = service.decorate([point()], DAY, [])[0]
        self.assertEqual(result['combined_daily_pnl'], 1000)


class OptionPnlDeliverableAndClockTests(unittest.TestCase):
    def service(self, now=NOW, checks=None):
        return OptionPnlService(clock=lambda: now,
            reader=lambda _: [baseline(), snapshot(at=now.isoformat())],
            check_reader=lambda _: checks or {}, schedule_provider=lambda _: SCHEDULE)

    def test_unknown_adjustment_is_never_assumed_standard_after_cold_start(self):
        result = self.service().decorate([point()], DAY, [call()], collect=False)[0]
        self.assertIsNone(result['combined_daily_pnl'])
        self.assertIn('contract_adjustment_unverified', result['options_reasons'])

    def test_persisted_check_is_available_on_a_new_instance_outside_market_hours(self):
        service = self.service(now=NOW.replace(hour=12), checks={1: Decimal(1)})
        result = service.decorate([point('08:00')], DAY, [call()], collect=False)[0]
        self.assertTrue(result['options_complete'])
        self.assertEqual(result['option_daily_pnl'], 0)

    def test_later_split_cache_does_not_poison_an_earlier_market_day(self):
        service = self.service(checks={1: Decimal(1)})
        service.adjustments[(1, date(2026, 10, 1))] = Decimal(2)
        result = service.decorate([point()], DAY, [call()], collect=False)[0]
        self.assertEqual(result['option_daily_pnl'], -150)
        service.adjustments[(1, DAY)] = Decimal(2)
        result = service.decorate([point()], DAY, [call()], collect=False)[0]
        self.assertIn('adjusted_contract', result['options_reasons'])

    def test_crossing_minute_does_not_move_new_quote_back_into_earlier_stock_point(self):
        service = self.service(now=NOW+timedelta(minutes=1), checks={1: Decimal(1)})
        result = service.decorate([point()], DAY, [call()], collect=False)[0]
        self.assertIsNone(result['option_daily_pnl'])
        self.assertEqual(datetime.fromisoformat(result['as_of']).astimezone(UTC).minute, 0)

    def test_second_precision_assignment_is_not_combined_with_minute_rounded_stock_sale(self):
        op = call(); op['events'] = [event('ASSIGN', transaction_time='10:00:30', premium='0', stock_transaction_id=9)]
        result = calculate([op])[0]
        self.assertIn('assignment_timing_unaligned', result['options_reasons'])
        self.assertIsNone(result['combined_daily_pnl'])

    def test_split_failure_empty_dictionary_is_not_a_successful_standard_check(self):
        from app.split_service import split_service
        with patch.object(split_service, 'get_splits', return_value={}), patch.object(split_service, '_splits_cache', {}):
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                OptionPnlService._factor(call(), DAY)

    def test_factor_is_computed_only_through_the_requested_market_date(self):
        from app.split_service import split_service
        splits = {date(2026, 10, 1): Decimal(2)}
        with patch.object(split_service, 'get_splits', return_value=splits), \
             patch.object(split_service, '_splits_cache', {'MRVL': (splits, datetime(2026, 10, 2, 12))}):
            self.assertEqual(OptionPnlService._factor(call(), DAY), 1)
            self.assertEqual(OptionPnlService._factor(call(), date(2026, 10, 1)), 2)

    @patch.object(OptionPnlService, '_factor', return_value=Decimal(1))
    def test_closed_today_gets_deliverable_check_without_requesting_unneeded_current_quote(self, _):
        op = call(); op['events'] = [event()]
        checks = []
        service = OptionPnlService(clock=lambda: NOW, check_writer=lambda rows: checks.extend(rows), schedule_provider=lambda _: SCHEDULE)
        with patch.object(service.quotes, 'get_chain') as quote:
            self.assertTrue(service.collect([op])['complete'])
            quote.assert_not_called()
        self.assertEqual(checks[0]['call_id'], 1)


class OptionCollectorNewPositionTests(unittest.TestCase):
    @patch.object(OptionPnlService, '_factor', return_value=Decimal(1))
    def test_new_contract_during_throttle_cannot_reuse_another_position_success(self, _):
        closed = call(); closed['events'] = [event()]
        another = call(2); another['events'] = [event()]
        service = OptionPnlService(clock=lambda: NOW, check_writer=lambda _: None, schedule_provider=lambda _: SCHEDULE)
        self.assertTrue(service.collect([closed])['complete'])
        self.assertFalse(service.collect([closed, another])['complete'])


class OptionReferenceCarryTests(unittest.TestCase):
    def test_scheduled_snapshot_carries_at_most_six_minutes_without_backfill(self):
        rows = [baseline(), snapshot(at='2026-09-30T14:00:23+00:00')]
        results = calculate([call()], rows, [point('10:00'), point('10:05'), point('10:07')])
        self.assertIsNone(results[0]['option_daily_pnl'])
        self.assertEqual(results[1]['option_daily_pnl'], -150)
        self.assertEqual(results[1]['option_reference_age_seconds'], 277)
        self.assertEqual(results[1]['option_details'][0]['asof'], '2026-09-30T14:00:23+00:00')
        self.assertIsNone(results[2]['option_daily_pnl'])

    def test_reference_before_an_opening_is_not_carried_into_new_position(self):
        op = call(date='2026-09-30', transaction_time='10:02')
        result = calculate([op], [snapshot(at='2026-09-30T14:00:23+00:00')], [point('10:05')])[0]
        self.assertIsNone(result['option_daily_pnl'])
        self.assertEqual(result['option_cash_flow'], 1499.35)

    def test_reference_cannot_carry_past_unconfirmed_expiration(self):
        op = call(expiration='2026-09-30')
        rows = [baseline(expiration='2026-09-30'), snapshot(at='2026-09-30T20:01:00+00:00', expiration='2026-09-30')]
        result = calculate([op], rows, [point('16:03')])[0]
        self.assertIsNone(result['option_daily_pnl'])
        self.assertIn('expired_outcome_pending', result['options_reasons'])


if __name__ == '__main__': unittest.main()
