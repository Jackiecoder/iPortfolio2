"""CSV file parsing for transaction data."""

import csv
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

from .models import ActionType, Transaction


class CSVParseError(Exception):
    """Exception raised for CSV parsing errors."""
    def __init__(self, message: str, row_number: Optional[int] = None):
        self.row_number = row_number
        super().__init__(f"Row {row_number}: {message}" if row_number else message)


def parse_decimal(value: str) -> Optional[Decimal]:
    """Parse a string to Decimal, returning None for empty values."""
    if not value or value.strip() == "":
        return None
    try:
        return Decimal(value.strip())
    except InvalidOperation:
        raise ValueError(f"Invalid decimal value: {value}")


def parse_date(value: str) -> datetime:
    """Parse a date string in various formats."""
    formats = ["%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d"]
    value = value.strip()
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Invalid date format: {value}")


def parse_action(value: str) -> ActionType:
    """Parse action type from string."""
    value = value.strip().upper()
    try:
        return ActionType(value)
    except ValueError:
        valid_actions = ", ".join(a.value for a in ActionType)
        raise ValueError(f"Invalid action '{value}'. Valid actions: {valid_actions}")


def parse_csv_file(file_path: Path) -> list[Transaction]:
    """Parse a CSV file and return a list of transactions.

    Args:
        file_path: Path to the CSV file

    Returns:
        List of Transaction objects

    Raises:
        CSVParseError: If the file cannot be parsed
    """
    transactions = []

    if not file_path.exists():
        raise CSVParseError(f"File not found: {file_path}")

    try:
        with open(file_path, "r", encoding="utf-8-sig") as f:
            # Try to detect delimiter
            sample = f.read(4096)
            f.seek(0)

            # Use csv.Sniffer to detect dialect
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
            except csv.Error:
                dialect = csv.excel  # Default to comma-separated

            reader = csv.DictReader(f, dialect=dialect)

            # Normalize field names (lowercase, strip whitespace)
            if reader.fieldnames:
                reader.fieldnames = [name.lower().strip() for name in reader.fieldnames]

            required_fields = {"date", "asset", "action"}
            if not reader.fieldnames or not required_fields.issubset(set(reader.fieldnames)):
                missing = required_fields - set(reader.fieldnames or [])
                raise CSVParseError(f"Missing required columns: {missing}")

            for row_num, row in enumerate(reader, start=2):  # Start at 2 (header is row 1)
                try:
                    transaction = Transaction(
                        date=parse_date(row.get("date", "")),
                        asset=row.get("asset", "").strip(),
                        action=parse_action(row.get("action", "")),
                        amount=parse_decimal(row.get("amount", "")),
                        quantity=parse_decimal(row.get("quantity", "")),
                        ave_price=parse_decimal(row.get("ave_price", "")),
                        source=row.get("source", "").strip() or None,
                        comment=row.get("comment", "").strip() or None,
                    )
                    transactions.append(transaction)
                except ValueError as e:
                    raise CSVParseError(str(e), row_num)
                except Exception as e:
                    raise CSVParseError(f"Error parsing row: {e}", row_num)

    except UnicodeDecodeError:
        raise CSVParseError("File encoding error. Please use UTF-8 encoding.")
    except csv.Error as e:
        raise CSVParseError(f"CSV format error: {e}")

    return transactions


def parse_csv_content(content: str) -> list[Transaction]:
    """Parse CSV content from a string.

    Args:
        content: CSV content as string

    Returns:
        List of Transaction objects
    """
    import io

    transactions = []

    # Try to detect delimiter
    try:
        dialect = csv.Sniffer().sniff(content[:4096], delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel

    reader = csv.DictReader(io.StringIO(content), dialect=dialect)

    # Normalize field names
    if reader.fieldnames:
        reader.fieldnames = [name.lower().strip() for name in reader.fieldnames]

    required_fields = {"date", "asset", "action"}
    if not reader.fieldnames or not required_fields.issubset(set(reader.fieldnames)):
        missing = required_fields - set(reader.fieldnames or [])
        raise CSVParseError(f"Missing required columns: {missing}")

    for row_num, row in enumerate(reader, start=2):
        try:
            transaction = Transaction(
                date=parse_date(row.get("date", "")),
                asset=row.get("asset", "").strip(),
                action=parse_action(row.get("action", "")),
                amount=parse_decimal(row.get("amount", "")),
                quantity=parse_decimal(row.get("quantity", "")),
                ave_price=parse_decimal(row.get("ave_price", "")),
                source=row.get("source", "").strip() or None,
                comment=row.get("comment", "").strip() or None,
            )
            transactions.append(transaction)
        except ValueError as e:
            raise CSVParseError(str(e), row_num)
        except Exception as e:
            raise CSVParseError(f"Error parsing row: {e}", row_num)

    return transactions
