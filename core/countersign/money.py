"""Money is always integer cents. Percentages are basis points (10% = 1000).
Quantities are integer thousandths (500 cy = 500000)."""

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


def milli(quantity: int | str) -> int:
    """Parse a whole number or a '1,250.5' string into thousandths without floats."""
    if isinstance(quantity, int):
        return quantity * 1000
    text = quantity.replace(",", "").strip()
    negative = text.startswith("-")
    whole, _, frac = text.strip("-").partition(".")
    if len(frac.rstrip("0")) > 3:
        raise ValueError(f"more than three decimals: {quantity!r}")
    value = int(whole or "0") * 1000 + int((frac + "000")[:3] or "0")
    return -value if negative else value


def extend(quantity_milli: int, unit_price_cents: int) -> int | None:
    """quantity x unit price in cents, only when it's exact (the module's rule); None otherwise."""
    total = quantity_milli * unit_price_cents
    return total // 1000 if total % 1000 == 0 else None


def extend_up(quantity_milli: int, unit_price_cents: int) -> int:
    """quantity x unit price in cents, rounded up. For worst-case exposure, never for billing."""
    return -(-(quantity_milli * unit_price_cents) // 1000)


def fmt_qty(quantity_milli: int, unit: str = "") -> str:
    whole, frac = divmod(abs(quantity_milli), 1000)
    text = f"{'-' if quantity_milli < 0 else ''}{whole:,}" + (f".{frac:03d}".rstrip("0") if frac else "")
    return f"{text} {unit}".strip()
