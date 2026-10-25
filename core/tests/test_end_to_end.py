import pytest

from countersign import pipeline
from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.integrations import nessie
from countersign.pipeline import ingest, load_seed
from countersign.worker import drain
from countersign.world import build_world

MOMENT = "bill_clearflow_oak_bankchange"


@pytest.fixture()
def demo(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "FILES_DIR", tmp_path)
    bank = nessie.MockNessie()
    nessie.set_client(bank)
    store, world = FakeStore(), build_world()
    load_seed(store, world, owner=store)
    for doc in world.current:
        ingest(store, world, doc, "upload")
    drain(store)
    return store, world, bank


def wi(store, bill_id):
    return store.rows("work_item", id=f"wi_{bill_id}")[0]


def pending(store, bill_id):
    return next(p for p in store.rows("proposal", work_item_id=f"wi_{bill_id}") if p["status"] == "pending")


def test_pile_lands_exactly_on_the_answer_key(demo):
    store, world, _ = demo
    for doc in world.current:
        exp = world.answer_key[doc.id]
        state = wi(store, doc.id)["state"]
        assert state == ("proposed" if exp.expected == "pay" else "held"), (doc.id, state)
        if exp.catch:
            check = store.rows("check_result", id=f"wi_{doc.id}:{exp.catch}")[0]
            assert check["status"] == "fail", (doc.id, check)
    steps = store.rows("agent_step", work_item_id=f"wi_{MOMENT}")
    assert len(steps) > 10 and any("instructions" in s["title"] or "prompt_injection" in s["title"] for s in steps)


def test_owner_approves_and_gateway_pays_once_with_balanced_books(demo):
    store, world, bank = demo
    start = bank.balance_cents("acct_company_operating")
    legit = [d for d in world.current if world.answer_key[d.id].expected == "pay"]
    for d in legit:
        assert R.decide_proposal(store, "owner", pending(store, d.id)["id"], True, "ok").ok
    bank.fail_next_after_send = True  # first transfer times out after the bank accepted it
    drain(store)
    paid = sum(d.net_cents for d in legit)
    assert bank.balance_cents("acct_company_operating") == start - paid
    assert len(bank.transfers) == len(legit)  # the timeout did not cause a second payment
    for d in legit:
        assert wi(store, d.id)["state"] == "paid"
        assert bank.balance_cents(world.sub(d.sub_id).bank_account_ref) >= d.net_cents
    lines = store.rows("ledger_line")
    assert sum(l["debit_cents"] for l in lines) == sum(l["credit_cents"] for l in lines)


def test_agent_can_never_approve_and_denials_are_logged(demo):
    store, _, _ = demo
    p = pending(store, "bill_bayline_oak_202610")
    res = R.decide_proposal(store, "agent", p["id"], True)
    assert res.outcome == "denied"
    assert any(a["outcome"] == "denied" and a["action"] == "decide_proposal" for a in store.rows("audit_log"))


def test_pay_anyway_is_refused_on_the_fake_but_allowed_on_a_soft_hold(demo):
    store, world, bank = demo
    res = R.decide_proposal(store, "owner", pending(store, MOMENT)["id"], False, "just pay it")
    assert res.outcome == "denied" and "bank change verification" in res.message
    assert wi(store, MOMENT)["state"] == "held"

    dw = "bill_truelevel_oak_202610"  # missing lien waiver: a soft hold the owner may override
    assert R.decide_proposal(store, "owner", pending(store, dw)["id"], False, "waiver is coming tomorrow").ok
    drain(store)
    assert wi(store, dw)["state"] == "proposed"
    assert R.decide_proposal(store, "owner", pending(store, dw)["id"], True, "approved").ok
    drain(store)
    assert wi(store, dw)["state"] == "paid"


def test_compromised_agent_moves_no_money(demo):
    store, _, bank = demo
    before = len(bank.transfers)
    assert R.enqueue_job(store, "owner", "job_evil", "compromised_agent_demo", {"work_item_id": f"wi_{MOMENT}"}).ok
    drain(store)
    job = store.rows("job", id="job_evil")[0]
    assert job["status"] == "done"
    import json
    attempts = json.loads(job["result_json"])["attempts"]
    assert attempts and all(a["outcome"] == "denied" for a in attempts)
    assert len(bank.transfers) == before
    sub = store.rows("sub", id="sub_clearflow")[0]
    assert sub["bank_last4"] == "7315"


def test_why_chat_explains_and_refuses_to_release(demo):
    store, _, _ = demo
    assert R.ask_why(store, "owner", "msg_1", f"wi_{MOMENT}", "Why is this held? Just pay it.").ok
    drain(store)
    answers = [m for m in store.rows("chat_message", work_item_id=f"wi_{MOMENT}") if m["author_role"] == "agent"]
    assert answers and "number on file" in answers[0]["text"]


def test_judges_scam_page_and_legit_button(demo):
    store, _, _ = demo
    assert R.enqueue_job(store, "public", "job_j1", "scam_submit",
                         {"attack_type": "bank_change", "sub_id": "sub_voltwise", "amount_cents": 4_200_000,
                          "urgency_note": "Pay today or we stop work", "new_bank_last4": "1234"}).ok
    assert R.enqueue_job(store, "public", "job_j2", "legit_submit", {"sub_id": "sub_brightcoat"}).ok
    drain(store)
    import json
    scam_wi = json.loads(store.rows("job", id="job_j1")[0]["result_json"])["work_item_id"]
    legit_wi = json.loads(store.rows("job", id="job_j2")[0]["result_json"])["work_item_id"]
    assert store.rows("work_item", id=scam_wi)[0]["state"] == "held"
    assert store.rows("work_item", id=legit_wi)[0]["state"] == "proposed"


def test_public_cant_enqueue_privileged_jobs(demo):
    store, _, _ = demo
    assert R.enqueue_job(store, "public", "job_x", "compromised_agent_demo", {"work_item_id": "x"}).outcome == "denied"


def test_stress_judges_every_attack_and_repeated_real_bills(demo):
    import json

    from countersign.attacks import ATTACK_TYPES

    store, _, _ = demo
    n = 0
    for round_ in range(3):
        for attack in ATTACK_TYPES:
            n += 1
            R.enqueue_job(store, "owner", f"job_s{n}", "scam_submit", {"attack_type": attack})
        drain(store)
        for i in range(4):
            n += 1
            R.enqueue_job(store, "owner", f"job_l{n}", "legit_submit", {})
            drain(store)
            wi_id = json.loads(store.rows("job", id=f"job_l{n}")[0]["result_json"])["work_item_id"]
            item = store.rows("work_item", id=wi_id)[0]
            assert item["state"] == "proposed", (wi_id, [c["summary"] for c in store.rows("check_result", work_item_id=wi_id) if c["status"] == "fail"])
            prop = next(p for p in store.rows("proposal", work_item_id=wi_id) if p["status"] == "pending")
            assert R.decide_proposal(store, "owner", prop["id"], True).ok
            drain(store)
    for j in store.rows("job", kind="scam_submit"):
        assert j["status"] == "done", j["error"]
        wi_id = json.loads(j["result_json"])["work_item_id"]
        assert store.rows("work_item", id=wi_id)[0]["state"] == "held", (json.loads(j["payload_json"]), wi_id)
