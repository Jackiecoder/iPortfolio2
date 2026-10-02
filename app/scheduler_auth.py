"""Verify the narrowly scoped identity used by Cloud Scheduler.

The scheduler never receives the application's portfolio/transaction API token.
Its Google-signed OIDC token is accepted only by the scheduled refresh endpoint.
"""

import os
from functools import partial

import requests
from google.auth.transport.requests import Request
from google.oauth2 import id_token


SCHEDULER_PATH = "/api/internal/refresh"


def verify_scheduler_token(token: str) -> None:
    audience = os.environ.get("SCHEDULER_AUDIENCE", "")
    service_account = os.environ.get("SCHEDULER_SERVICE_ACCOUNT", "")
    if not token or not audience or not service_account:
        raise ValueError("Scheduler authentication is not configured")

    # Never trust Scheduler headers alone, nor accept an unsigned/decoded JWT.
    # Google-auth verifies signature, expiry, audience and Google issuer.
    with requests.Session() as session:
        claims = id_token.verify_oauth2_token(
            token,
            partial(Request(session=session), timeout=10),
            audience=audience,
        )
    if (claims.get("email") != service_account
            or claims.get("email_verified") is not True):
        raise ValueError("Unexpected scheduler identity")
