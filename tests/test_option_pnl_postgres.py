"""Persistent quote and per-day deliverable checks on disposable Postgres only."""
from datetime import date, datetime, timezone
from decimal import Decimal
import json
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from app import db
from app.option_pnl_service import (OptionPnlService, load_contract_checks, load_snapshots,
                                    save_contract_checks, save_snapshots)
from tests.test_option_pnl import DAY, SCHEDULE, baseline, call, point, snapshot


@unittest.skipUnless(os.environ.get('IPORTFOLIO_TEST_DATABASE_URL'), 'Requires disposable localhost Postgres')
class OptionPnlPostgresTests(unittest.TestCase):
    def setUp(self):
        self.dsn = os.environ['IPORTFOLIO_TEST_DATABASE_URL']
        if conninfo_to_dict(self.dsn).get('host') not in ('127.0.0.1', 'localhost', '::1'):
            raise RuntimeError('Only explicit localhost test databases are allowed')
        self.schema = 'opnl_test_' + uuid4().hex
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        self.pool = ConnectionPool(self.dsn, min_size=1, max_size=4, kwargs={'options': f'-c search_path={self.schema}'})
        self.pool.wait()
        self.pool_patch = patch.object(db, '_pool', self.pool)
        self.pool_patch.start()
        db.init_schema(); db.init_schema()
        self.raw = call()
        with self.pool.connection() as conn:
            result = conn.execute('INSERT INTO covered_calls (request_id, opening) VALUES (%s,%s::jsonb) RETURNING id',
                                  (str(uuid4()), json.dumps(self.raw['opening']))).fetchone()
            self.raw['id'] = result[0]

    def tearDown(self):
        self.pool_patch.stop(); self.pool.close()
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def check(self, day=DAY, factor=1):
        return {'call_id': self.raw['id'], 'market_date': day, 'adjustment_factor': factor,
                'checked_at': datetime(2026, 9, 30, 14, 0, tzinfo=timezone.utc)}

    def test_snapshot_retry_is_idempotent_and_keeps_original_retrieval_time(self):
        rows = [baseline(), snapshot()]
        save_snapshots(rows); save_snapshots(rows)
        stored = load_snapshots(DAY)
        self.assertEqual(len(stored), 2)
        self.assertEqual(stored[1]['mid'], Decimal('13.5'))
        self.assertEqual(stored[1]['captured_at'], datetime(2026, 9, 30, 14, tzinfo=timezone.utc))
        with self.pool.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM transactions').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT count(*) FROM covered_calls').fetchone()[0], 1)

    def test_invalid_reference_quotes_are_not_persisted(self):
        self.assertEqual(save_snapshots([snapshot(mid=0, bid=0, ask=0), snapshot(mid=13, bid=14, ask=12)]), 0)
        self.assertEqual(load_snapshots(DAY), [])

    def test_checks_are_day_specific_and_survive_new_service_instances(self):
        save_snapshots([baseline(), snapshot()])
        save_contract_checks([self.check(), self.check(date(2026, 10, 1), 2)])
        self.assertEqual(load_contract_checks(DAY), {self.raw['id']: Decimal(1)})
        self.assertEqual(load_contract_checks(date(2026, 10, 1)), {self.raw['id']: Decimal(2)})
        service = OptionPnlService(clock=lambda: datetime(2026, 9, 30, 14, 0, 30, tzinfo=timezone.utc), schedule_provider=lambda _: SCHEDULE)
        result = service.decorate([point()], DAY, [self.raw], collect=False)[0]
        self.assertEqual(result['option_daily_pnl'], -150)
        self.assertTrue(result['options_complete'])

    def test_missing_checks_fail_closed_even_with_priced_contract(self):
        save_snapshots([baseline(), snapshot()])
        service = OptionPnlService(clock=lambda: datetime(2026, 9, 30, 14, 0, 30, tzinfo=timezone.utc), schedule_provider=lambda _: SCHEDULE)
        result = service.decorate([point()], DAY, [self.raw], collect=False)[0]
        self.assertIsNone(result['combined_daily_pnl'])
        self.assertIn('contract_adjustment_unverified', result['options_reasons'])


if __name__ == '__main__': unittest.main()
