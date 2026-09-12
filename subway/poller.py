"""A background thread that refreshes a data source on an interval."""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)


class Poller:
    name = "poller"

    def __init__(self, interval: float):
        self.interval = interval
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_ok: float | None = None
        self.last_error: str | None = None

    # subclasses implement this; it should swap in fresh data under self._lock
    def fetch(self) -> None:
        raise NotImplementedError

    def refresh(self) -> None:
        try:
            self.fetch()
            self.last_ok, self.last_error = time.time(), None
        except Exception as exc:  # noqa: BLE001 - keep polling on any failure
            log.warning("%s failed: %s", self.name, exc)
            self.last_error = str(exc)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.refresh()
            self._stop.wait(self.interval)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name=self.name, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
