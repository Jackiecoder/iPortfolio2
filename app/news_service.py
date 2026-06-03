"""News service: thin client for the sellthenews MCP server.

The server speaks MCP JSON-RPC over streamable HTTP (responses come back as
Server-Sent Events, one `data:` line per message). It is stateless for tool
calls — no session handshake is required — so we just POST a `tools/call`
request and parse the single `data:` payload.

Used by the Intraday P&L "news attribution" panel. All failures degrade
gracefully: callers get {"available": False, ...} instead of an exception,
so the dashboard never breaks if the news server is down or rate-limited.
"""

import json
import logging
import os
import threading
import time
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

# Endpoint is overridable via env (set to empty string to disable the feature).
MCP_URL = os.environ.get("NEWS_MCP_URL", "https://mcp.sellthenews.org/mcp")

_TIMEOUT = 8  # seconds per HTTP call
_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}

# In-memory TTL cache. The server rate-limits (~120/window), so we cache
# aggressively and only ever call it on demand.
_RECAP_TTL = 600   # 10 min
_STOCK_TTL = 900   # 15 min
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def is_enabled() -> bool:
    return bool(MCP_URL)


def _cache_get(key: str, ttl: int) -> Optional[Any]:
    with _cache_lock:
        hit = _cache.get(key)
    if hit and (time.time() - hit[0]) < ttl:
        return hit[1]
    return None


def _cache_set(key: str, value: Any) -> None:
    with _cache_lock:
        _cache[key] = (time.time(), value)


def _parse_sse_result(text: str) -> Optional[dict]:
    """Extract the JSON-RPC payload from an SSE (`data: {...}`) response body."""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def _mcp_call(tool: str, arguments: dict) -> Optional[str]:
    """Call one MCP tool, returning its concatenated text content or None."""
    if not is_enabled():
        return None
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    try:
        resp = requests.post(MCP_URL, headers=_HEADERS, json=payload, timeout=_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning("news MCP call %s failed: %s", tool, e)
        return None

    msg = _parse_sse_result(resp.text)
    if not msg or "result" not in msg:
        logger.warning("news MCP call %s returned no result", tool)
        return None
    blocks = msg["result"].get("content", [])
    texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return "\n".join(t for t in texts if t).strip() or None


def get_intraday_recaps(date: str, limit: int = 8) -> dict:
    """Time-bucketed AI market narrative for a date (YYYY-MM-DD)."""
    key = f"recap_{date}_{limit}"
    cached = _cache_get(key, _RECAP_TTL)
    if cached is not None:
        return cached

    if not is_enabled():
        result = {"available": False, "reason": "news feature disabled"}
        return result

    text = _mcp_call("get_intraday_news_recaps", {"date": date, "limit": limit})
    if text is None:
        # Don't cache transient failures for long; short negative cache.
        result = {"available": False, "reason": "news server unavailable", "date": date}
        _cache.setdefault(key, (time.time() - _RECAP_TTL + 60, result))  # ~1 min retry
        return result

    result = {"available": True, "date": date, "text": text}
    _cache_set(key, result)
    return result


def get_stock_news(ticker: str, limit: int = 5) -> dict:
    """Recent headlines for a single ticker."""
    ticker = ticker.upper().strip()
    key = f"stock_{ticker}_{limit}"
    cached = _cache_get(key, _STOCK_TTL)
    if cached is not None:
        return cached

    if not is_enabled():
        return {"available": False, "reason": "news feature disabled"}

    text = _mcp_call("get_stock_news", {"ticker": ticker, "limit": limit})
    if text is None:
        return {"available": False, "reason": "news server unavailable", "ticker": ticker}

    result = {"available": True, "ticker": ticker, "text": text}
    _cache_set(key, result)
    return result
