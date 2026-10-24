"""Scorecard: run generated scams + legit bills through the checks and decision rules,
compare with the answer key, and report caught / wrongly held / dollars protected.

`run_offline` is deterministic and free (no APIs): every case is evaluated alone
against the company's real history. The live demo runs the full agent on top.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from .attacks import Case, scorecard_cases
from .checks import run_all
from .decide import decide
from .harness import context_for
from .world import World, build_world


@dataclass
class CaseResult:
    case: Case
    actual: str
    blocking: list[str]
    reason: str

    @property
    def correct(self) -> bool:
        return self.actual == self.case.expected.expected


def evaluate(world: World, case: Case) -> CaseResult:
    prior = list(world.history) + case.extra_prior
    ctx = context_for(world, case.doc, prior, doc_text=case.doc.hidden_text)
    d = decide(ctx.bill, run_all(ctx))
    return CaseResult(case, "pay" if d.kind == "payment" else "hold", d.blocking, d.reason)


def totals(results: list[CaseResult]) -> dict[str, Any]:
    scams = [r for r in results if r.case.expected.expected == "hold"]
    legit = [r for r in results if r.case.expected.expected == "pay"]
    per_type: dict[str, Counter] = defaultdict(Counter)
    for r in results:
        per_type[r.case.expected.attack_type]["total"] += 1
        per_type[r.case.expected.attack_type]["correct"] += int(r.correct)
    return {
        "cases": len(results),
        "scams": len(scams),
        "scams_caught": sum(r.actual == "hold" for r in scams),
        "legit": len(legit),
        "legit_paid": sum(r.actual == "pay" for r in legit),
        "legit_wrongly_held": sum(r.actual == "hold" for r in legit),
        "dollars_protected_cents": sum(r.case.doc.net_cents for r in scams if r.actual == "hold"),
        "dollars_lost_cents": sum(r.case.doc.net_cents for r in scams if r.actual == "pay"),
        "per_type": {k: dict(v) for k, v in sorted(per_type.items())},
        "expected_check_fired": sum(r.case.expected.catch in r.blocking for r in scams),
    }


def run_offline(n_attacks: int = 200, n_legit: int = 50, seed: int = 13) -> tuple[list[CaseResult], dict[str, Any]]:
    world = build_world()
    results = [evaluate(world, c) for c in scorecard_cases(world, n_attacks, n_legit, seed)]
    return results, totals(results)
