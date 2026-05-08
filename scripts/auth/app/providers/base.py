from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NormalizedAccount:
    provider: str
    identifier: str
    secret: str
    metadata: dict[str, str] = field(default_factory=dict)
    raw: str = ""


@dataclass
class ProviderResult:
    ok: bool
    message: str
    external_account_id: str | None = None
    tokens: dict[str, str] = field(default_factory=dict)
    quota: dict[str, Any] | None = None


class ProviderAdapter(ABC):
    name: str

    @abstractmethod
    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        raise NotImplementedError

    @abstractmethod
    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        raise NotImplementedError

    @abstractmethod
    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        raise NotImplementedError

    @abstractmethod
    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        raise NotImplementedError

    async def cleanup_session(self, session: Any) -> None:
        _ = session

    async def build_result(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        quota: dict[str, Any] | None,
    ) -> ProviderResult:
        return ProviderResult(
            ok=True,
            message=f"{self.name} account accepted: {account.identifier}",
            tokens=tokens,
            quota=quota,
        )
