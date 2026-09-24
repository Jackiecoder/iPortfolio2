"""Opt-in persistence tests using an explicitly disposable localhost database."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
import threading
import unittest
from unittest.mock import MagicMock, patch
import uuid

import pandas as pd
import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from app import db
from app.ticker_technicals import DailyTechnicalsStore, TickerTechnicals, CALCULATION_VERSION


@unittest.skipUnless(os.environ.get('IPORTFOLIO_TEST_DATABASE_URL'), 'Requires disposable localhost Postgres')
class PostgresTechnicalCacheTests(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
        if conninfo_to_dict(self.dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('These tests require an explicit disposable localhost database')
        self.schema = 'technical_test_' + uuid.uuid4().hex
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.pool = ConnectionPool(self.dsn, min_size=1, max_size=4,
                                   kwargs={'options': f'-c search_path={self.schema}'})
        self.pool.wait()
        self.pool_patch = patch.object(db, '_pool', self.pool)
        self.pool_patch.start()
        db.init_schema()
        db.init_schema()
        self.now = datetime(2026, 9, 24, 15, tzinfo=timezone.utc)
        self.ticker = MagicMock()
        self.ticker.history.side_effect = self.provider_history
        self.provider = patch('app.ticker_technicals.yf.Ticker', return_value=self.ticker)
        self.provider.start()

    def tearDown(self):
        self.provider.stop()
        self.pool_patch.stop()
        self.pool.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def provider_history(self, **kwargs):
        if kwargs['interval'] == '1d':
            return pd.DataFrame({'Close': range(1, 221)},
                index=pd.bdate_range(end='2026-09-23', periods=220, tz='America/New_York'))
        return pd.DataFrame({'Close': [250]}, index=pd.DatetimeIndex([self.now]))

    def service(self):
        return TickerTechnicals(clock=lambda: self.now)

    def daily_calls(self):
        return sum(call.kwargs['interval'] == '1d' for call in self.ticker.history.call_args_list)

    def rows(self):
        with self.pool.connection() as conn:
            return conn.execute('SELECT cache_date, snapshot FROM ticker_technical_snapshots').fetchall()

    def test_restart_reads_persisted_snapshot_without_fetching_daily_history(self):
        first = self.service().get('AAPL')
        self.now += timedelta(hours=2)
        second = self.service().get('AAPL')
        self.assertEqual(self.daily_calls(), 1)
        self.assertEqual(first['history_fetched_at'], second['history_fetched_at'])
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1]['averages'][0]['value'], 195.5)
        self.assertNotIn('current_price', rows[0][1])
        self.assertNotEqual(first['quote_time'], second['quote_time'])

    def test_simultaneous_first_requests_fetch_daily_history_only_once(self):
        barrier = threading.Barrier(2)
        def request():
            service = self.service()
            barrier.wait(timeout=5)
            return service.get('AAPL')
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: request(), range(2)))
        self.assertEqual(self.daily_calls(), 1)
        self.assertEqual(results[0]['averages'], results[1]['averages'])
        self.assertEqual(len(self.rows()), 1)

    def test_next_day_replaces_only_the_daily_cache_row(self):
        self.service().get('AAPL')
        self.now += timedelta(days=1)
        self.service().get('AAPL')
        self.assertEqual(self.daily_calls(), 2)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0].isoformat(), '2026-09-25')

    def test_failed_fetch_rolls_back_and_can_retry_from_a_fresh_service(self):
        self.ticker.history.side_effect = RuntimeError('provider unavailable')
        with self.assertRaises(RuntimeError):
            self.service().get('AAPL')
        self.assertEqual(self.rows(), [])
        self.ticker.history.side_effect = self.provider_history
        self.service().get('AAPL')
        self.assertEqual(len(self.rows()), 1)

    def test_old_request_cannot_overwrite_a_newer_day(self):
        store = DailyTechnicalsStore()
        newer_day = self.now.date() + timedelta(days=1)
        store.get_or_create('AAPL', newer_day, lambda: {'day': 'newer'})
        store.get_or_create('AAPL', self.now.date(), lambda: {'day': 'older'})
        self.assertEqual(self.rows(), [(newer_day, {'day': 'newer'})])

    def test_calculation_version_change_recomputes_instead_of_reusing_old_math(self):
        self.service().get('AAPL')
        with patch('app.ticker_technicals.CALCULATION_VERSION', CALCULATION_VERSION + '-test'):
            self.service().get('AAPL')
        self.assertEqual(self.daily_calls(), 2)
        self.assertEqual(len(self.rows()), 2)


if __name__ == '__main__':
    unittest.main()
