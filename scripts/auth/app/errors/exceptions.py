from __future__ import annotations

from app.errors.codes import ErrorCode


class BatcherError(Exception):
    def __init__(self, code: ErrorCode, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class RetryableBatcherError(BatcherError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(code=code, message=message, retryable=True)


class NonRetryableBatcherError(BatcherError):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(code=code, message=message, retryable=False)


def map_exception(exc: Exception) -> tuple[ErrorCode, str, bool]:
    if isinstance(exc, BatcherError):
        return exc.code, exc.message, exc.retryable

    return ErrorCode.internal_unhandled, str(exc) or "internal error", True
