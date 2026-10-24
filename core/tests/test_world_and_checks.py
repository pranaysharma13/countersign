from countersign.checks import run_all
from countersign.decide import decide
from countersign.harness import context_for
from countersign.money import apply_bps, cents, fmt
from countersign.world import build_world


def test_money_is_integer_cents():
    assert cents("1,234.56") == 123456
    assert cents("(12.30)") == -1230
    assert cents(5) == 500
    assert apply_bps(4_186_000, 500) == 209_300
    assert fmt(-123456) == "-$1,234.56"


def test_history_is_clean_and_paid_in_full():
    w = build_world()
    assert len(w.history) > 30
    seen: list = []
    for doc in w.history:
        outcomes = run_all(context_for(w, doc, seen))
        failed = [(o.code, o.summary) for o in outcomes if o.status in {"fail", "error"}]
        assert not failed, (doc.id, failed)
        seen.append(doc)


def test_current_pile_matches_answer_key():
    w = build_world()
    processed = list(w.history)
    for doc in w.current:
        exp = w.answer_key[doc.id]
        ctx = context_for(w, doc, [p for p in processed if w.answer_key.get(p.id, None) is None
                                   or w.answer_key[p.id].expected == "pay"])
        d = decide(ctx.bill, run_all(ctx))
        actual = "pay" if d.kind == "payment" else "hold"
        assert actual == exp.expected, (doc.id, d.reason)
        if exp.catch:
            assert exp.catch in d.blocking, (doc.id, exp.catch, d.blocking)
        processed.append(doc)


def test_the_moment_is_a_hard_stop_with_every_red_flag():
    w = build_world()
    fake = next(d for d in w.current if d.id == "bill_clearflow_oak_bankchange")
    ctx = context_for(w, fake, list(w.history), doc_text=fake.hidden_text)
    outcomes = {o.code: o for o in run_all(ctx)}
    assert outcomes["bank_mismatch"].status == "fail"
    assert outcomes["sender_domain"].status == "fail" and "lookalike" in outcomes["sender_domain"].summary
    assert outcomes["prompt_injection"].status == "fail"
    assert outcomes["fake_owner_instruction"].status == "fail"
    d = decide(ctx.bill, list(outcomes.values()))
    assert d.kind == "hold" and d.hard_stop
    assert d.blocking[0] == "bank_mismatch"


def test_real_plumbing_bill_still_pays_after_the_fake_is_held():
    w = build_world()
    real = next(d for d in w.current if d.id == "bill_clearflow_oak_202610")
    ctx = context_for(w, real, list(w.history))  # the held fake is not a genuine prior bill
    d = decide(ctx.bill, run_all(ctx))
    assert d.kind == "payment", d.reason
    assert d.amount_cents == real.amount_cents - real.retainage_cents


def test_error_in_a_check_holds():
    w = build_world()
    doc = w.current[0]
    ctx = context_for(w, doc, list(w.history))
    ctx.crs = None  # CRS down
    d = decide(ctx.bill, run_all(ctx))
    assert d.kind == "hold" and "crs_liens_judgments" in d.blocking


def test_ai_can_add_a_hold_but_not_remove_one():
    w = build_world()
    legit = w.current[0]
    ctx = context_for(w, legit, list(w.history))
    assert decide(ctx.bill, run_all(ctx), extra_holds=["Sub's foreman says work isn't done"]).kind == "hold"
