"""Money is always integer cents. Percentages are basis points (10% = 1000)."""

from __future__ import annotations


def cents(dollars: int | str) -> int:
    """Parse whole dollars or a '1,234.56' string into cents without floats."""
    if isinstance(dollars, int):
        return dollars * 100
    text = dollars.replace("$", "").replace(",", "").strip()
    negative = text.startswith("-") or (text.startswith("(") and text.endswith(")"))
    text = text.strip("-()")
    whole, _, frac = text.partition(".")
    frac = (frac + "00")[:2]
    value = int(whole or "0") * 100 + int(frac or "0")
    return -value if negative else value


def apply_bps(amount_cents: int, bps: int) -> int:
    """amount * bps / 10000, rounded half up, integer only."""
    return (amount_cents * bps + 5000) // 10000


def fmt(amount_cents: int) -> str:
    sign = "-" if amount_cents < 0 else ""
    a = abs(amount_cents)
    return f"{sign}${a // 100:,}.{a % 100:02d}"
