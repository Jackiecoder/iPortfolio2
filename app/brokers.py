"""Canonical spelling for known broker labels; preserve custom account names."""

from typing import Optional


BROKER_NAMES = {
    "fidelity": "Fidelity",
    "okx": "OKX",
    "binance.us": "Binance.US",
    "schwab": "Schwab",
}


def normalize_broker(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    label = value.strip()
    return BROKER_NAMES.get(label.casefold(), label) or None
