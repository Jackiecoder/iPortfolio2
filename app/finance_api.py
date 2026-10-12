"""Authenticated by the application's existing /api middleware."""
import logging

from fastapi import APIRouter, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from . import finance_repository as repository
from .finance import (ExchangeCreate, ExchangeUpdate, FinanceError, InventoryPaymentCreate,
                      LoanCreate, LoanUpdate, MovementCreate,
                      MovementUpdate, PaymentCreate, ProductCreate, ProductUpdate,
                      TransferCreate, TransferUpdate)

logger = logging.getLogger(__name__)
router = APIRouter(prefix='/api/finance', tags=['finance'])


async def _execute(function, *args):
    try:
        return await run_in_threadpool(function, *args)
    except FinanceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception('Financial ledger operation failed')
        raise HTTPException(status_code=503, detail='Financial ledger is temporarily unavailable; refresh and retry with the same request') from exc


@router.get('')
async def get_finance():
    return await _execute(repository.list_finance)


@router.post('/transfers')
async def create_transfer(request: TransferCreate):
    return await _execute(repository.create_record, 'transfers', request)


@router.put('/transfers/{record_id}')
async def update_transfer(record_id: int, request: TransferUpdate):
    return await _execute(repository.update_record, 'transfers', record_id, request)


@router.delete('/transfers/{record_id}')
async def void_transfer(record_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_record, 'transfers', record_id, version)


@router.post('/exchanges')
async def create_exchange(request: ExchangeCreate):
    return await _execute(repository.create_record, 'exchanges', request)


@router.put('/exchanges/{record_id}')
async def update_exchange(record_id: int, request: ExchangeUpdate):
    return await _execute(repository.update_record, 'exchanges', record_id, request)


@router.delete('/exchanges/{record_id}')
async def void_exchange(record_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_record, 'exchanges', record_id, version)


@router.post('/loans')
async def create_loan(request: LoanCreate):
    return await _execute(repository.create_record, 'loans', request)


@router.put('/loans/{record_id}')
async def update_loan(record_id: int, request: LoanUpdate):
    return await _execute(repository.update_record, 'loans', record_id, request)


@router.delete('/loans/{record_id}')
async def void_loan(record_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_record, 'loans', record_id, version)


@router.post('/loans/{record_id}/repayments')
async def create_repayment(record_id: int, request: PaymentCreate):
    return await _execute(repository.create_payment, 'loans', record_id, request)


@router.delete('/loans/{record_id}/repayments/{payment_id}')
async def void_repayment(record_id: int, payment_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_payment, 'loans', record_id, payment_id, version)


@router.post('/products')
async def create_product(request: ProductCreate):
    return await _execute(repository.create_record, 'products', request)


@router.put('/products/{record_id}')
async def update_product(record_id: int, request: ProductUpdate):
    return await _execute(repository.update_record, 'products', record_id, request)


@router.delete('/products/{record_id}')
async def void_product(record_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_record, 'products', record_id, version)


@router.post('/movements')
async def create_movement(request: MovementCreate):
    return await _execute(repository.create_record, 'movements', request)


@router.put('/movements/{record_id}')
async def update_movement(record_id: int, request: MovementUpdate):
    return await _execute(repository.update_record, 'movements', record_id, request)


@router.delete('/movements/{record_id}')
async def void_movement(record_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_record, 'movements', record_id, version)


@router.post('/movements/{record_id}/payments')
async def create_movement_payment(record_id: int, request: InventoryPaymentCreate):
    return await _execute(repository.create_payment, 'movements', record_id, request)


@router.delete('/movements/{record_id}/payments/{payment_id}')
async def void_movement_payment(record_id: int, payment_id: int, version: int = Query(..., ge=1)):
    return await _execute(repository.void_payment, 'movements', record_id, payment_id, version)
