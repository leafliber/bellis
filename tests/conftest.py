"""Global pytest guardrails so hung pipes or async loops fail fast with a traceback."""

from __future__ import annotations

import faulthandler
import os
import sys
from collections.abc import Iterator

import pytest

_DEFAULT_TEST_TIMEOUT_S = 30.0


@pytest.fixture(autouse=True)
def _per_test_hang_guard() -> Iterator[None]:
    raw = os.getenv("BELLIS_TEST_TIMEOUT_S")
    timeout = float(raw) if raw else _DEFAULT_TEST_TIMEOUT_S
    if timeout > 0:
        stream = sys.__stderr__ or sys.stderr
        faulthandler.dump_traceback_later(timeout, repeat=False, file=stream, exit=True)
    try:
        yield
    finally:
        if timeout > 0:
            faulthandler.cancel_dump_traceback_later()
