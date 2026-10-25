"""scripts/reset_demo_v2.py's logic against the module reference: one command, safe to run twice."""

import pytest

from countersign import demo_reset
from countersign.fake_store import FakeStore
from countersign.seed_check import compare, reference

IDS = {r: r for r in demo_reset.ROLES}  # the reference's identities are role names


def test_reset_loads_the_opening_and_the_sandbox_and_matches_the_reference():
    s = FakeStore()
    log = demo_reset.reset(s, IDS, "admin")
    assert log[0] == "claim_admin: ok"
    assert {a["role"] for a in s.rows("actor")} == set(demo_reset.ROLES) | {"admin"}
    assert {a["role"]: a["limit_cents"] for a in s.rows("authority")}["purchasing"] == 200_000
    assert s.rows("invoice", id="inv_bm23104") and s.rows("supplier", id="sup_sandbox")
    assert compare(s, reference(list(demo_reset.seeds().values()))) == []


def test_running_it_twice_changes_nothing():
    s = FakeStore()
    demo_reset.reset(s, IDS, "admin")
    before = {t: len(rows) for t, rows in s.tables.items() if t not in {"audit_log", "request_result"}}
    log = demo_reset.reset(s, IDS, "admin")
    assert log[0] == "claim_admin: duplicate" and all("duplicate" in line and " ok" not in line for line in log[1:])
    assert {t: len(rows) for t, rows in s.tables.items() if t not in {"audit_log", "request_result"}} == before


def test_an_admin_claimed_elsewhere_is_fine_but_a_stranger_stops_it():
    s = FakeStore()
    assert s.call("admin", "claim_admin").ok  # e.g. setup_actors.py claimed it with its own request id
    assert demo_reset.reset(s, IDS, "admin")[0] == "claim_admin: denied"
    with pytest.raises(demo_reset.ResetError, match="another identity is admin"):
        demo_reset.reset(_claimed_by_stranger(), IDS, "admin")
    with pytest.raises(demo_reset.ResetError, match="no identity for"):
        demo_reset.reset(FakeStore(), {**IDS, "receiver": ""}, "admin")


def _claimed_by_stranger():
    s = FakeStore()
    assert s.call("admin", "claim_admin").ok
    s.tables["actor"]["admin"]["identity"] = "0xstranger"
    return s
