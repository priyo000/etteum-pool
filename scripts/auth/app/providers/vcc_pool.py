"""
VCC Pool — manages virtual credit cards for Stripe payment automation.

Cards are passed via BATCHER_VCC_POOL env var as JSON array.
Declined cards are removed from pool. Only successful cards persist.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any


@dataclass
class VCCCard:
    number: str
    exp_month: str
    exp_year: str
    cvv: str
    name: str = "John Doe"
    status: str = "available"  # available, declined, used

    @property
    def last4(self) -> str:
        return self.number[-4:] if len(self.number) >= 4 else self.number

    @property
    def exp_formatted(self) -> str:
        return f"{self.exp_month}/{self.exp_year}"

    @staticmethod
    def from_dict(data: dict[str, Any]) -> VCCCard:
        exp = data.get("exp", "")
        if "/" in exp:
            parts = exp.split("/")
            exp_month = parts[0].strip().zfill(2)
            exp_year = parts[1].strip()
        else:
            exp_month = data.get("exp_month", "01")
            exp_year = data.get("exp_year", "30")

        if len(exp_year) == 2:
            exp_year = f"20{exp_year}"

        return VCCCard(
            number=data.get("number", "").replace(" ", "").replace("-", ""),
            exp_month=exp_month,
            exp_year=exp_year,
            cvv=data.get("cvv", ""),
            name=data.get("name", "John Doe"),
        )


class VCCPool:
    def __init__(self, cards: list[VCCCard] | None = None):
        self._cards: list[VCCCard] = cards or []
        self._index = 0

    def next(self) -> VCCCard | None:
        available = [c for c in self._cards if c.status == "available"]
        if not available:
            return None
        return available[0]

    def mark_declined(self, card: VCCCard) -> None:
        self._cards = [c for c in self._cards if c.number != card.number]

    def mark_success(self, card: VCCCard) -> None:
        card.status = "used"

    def remaining(self) -> int:
        return len([c for c in self._cards if c.status == "available"])

    def __iter__(self):
        while True:
            card = self.next()
            if card is None:
                break
            yield card

    @staticmethod
    def from_env() -> VCCPool:
        raw = os.getenv("BATCHER_VCC_POOL", "[]")
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return VCCPool()

        if not isinstance(data, list):
            return VCCPool()

        cards = []
        for item in data:
            if isinstance(item, dict) and item.get("number"):
                cards.append(VCCCard.from_dict(item))

        return VCCPool(cards)
