"""Live extraction plumbing with a fake client (no network). A fake can't catch a schema the API rejects;
scripts/try_live_extraction.py makes the real calls for that."""

import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from countersign import live_extract as L
from countersign.extractions import evidence_problems
from countersign.supplier_docs import file_bytes, fragments
from countersign.supplier_world import QUOTE, WEEKEND_1


class _Stream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


class FakeClient:
    """Answers each structured-output request with the next canned output (or raises it)."""

    def __init__(self, *answers, stop_reason="end_turn", model="claude-opus-5-5"):
        self.answers, self.stop_reason, self.model, self.requests = list(answers), stop_reason, model, []
        self.messages = self

    def stream(self, **params):
        self.requests.append(params)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _Stream(SimpleNamespace(model=self.model, stop_reason=self.stop_reason,
                                       stop_details=SimpleNamespace(category="cyber"),
                                       usage=SimpleNamespace(input_tokens=1200, output_tokens=300),
                                       content=[SimpleNamespace(type="text", text=json.dumps(answer))]))


def frags(doc):
    return [{"id": f.id, "page": f.page, "line_start": f.line_start, "text": f.text} for f in fragments(doc)]


def error(cls, status, message):
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(message, response=httpx2.Response(status, request=req), body=None)


WEEKEND_ANSWER = {
    "change_requests": [{
        "ref": "Weekend-Delivery Oct10", "kind": "EXTRA_CHARGE", "description": "Weekend delivery, Saturday Oct 10 pour",
        "amount_cents": 120000, "rate_cents": 0, "rate_unit": "",
        "scope": {"delivery_refs": ["2026-10-10"], "from_date": "2026-10-10", "to_date": "2026-10-10", "quantity_milli": 0, "unit": ""},
        "effective_from": "2026-10-10", "classification": "proposed", "supplier_acceptance": "Proposed", "missing_reason": "",
        "quote": "We can do it for a flat weekend delivery charge of $1,200.00 for that pour.",
        "fragments": ["frag_em_weekend_1_p0_l4", "frag_em_weekend_1_p0_l5"]}],
    "acceptances": [], "internal_approval_claims": [], "payee_change_requests": [], "instructions_found": []}


@pytest.fixture(autouse=True)
def reset_client():
    yield
    L.set_client(None)


def test_schemas_stay_inside_the_strict_mode_limits():
    def count(x, out):
        if isinstance(x, dict):
            if x.get("type") == "object":
                out["optional"] += len(set(x["properties"]) - set(x["required"]))
                assert x["additionalProperties"] is False
            out["any_of"] += int("anyOf" in x or isinstance(x.get("type"), list))
            for v in x.values():
                count(v, out)
        elif isinstance(x, list):
            for v in x:
                count(v, out)
        return out

    for schema in (L.CLASSIFY, L.EMAIL, L.QUOTE):
        assert count(schema, {"optional": 0, "any_of": 0}) == {"optional": 0, "any_of": 0}
        text = json.dumps(schema)
        assert not any(w in text for w in ("reasoning", "thinking", "trace", "rationale"))


def test_email_output_becomes_the_fixture_shape_with_enums_in_any_case():
    fake = FakeClient(WEEKEND_ANSWER)
    L.set_client(fake)
    meta = {"from_address": WEEKEND_1.email.from_address, "to_addresses": WEEKEND_1.email.to_addresses}
    ext = L.read_email(WEEKEND_1.id, meta, frags(WEEKEND_1), on_file=[], ref_prefix="baymix")
    cr = ext["change_requests"][0]
    assert (cr["ref"], cr["kind"], cr["classification"], cr["supplier_acceptance"]) == \
        ("baymix_weekend_delivery_oct10", "extra_charge", "PROPOSED", "proposed")
    assert cr["scope"] == {"delivery_refs": ["2026-10-10"], "from": "2026-10-10", "to": "2026-10-10"}
    assert (ext["mode"], ext["model"], ext["fallback"]) == ("live", "claude-opus-5-5", False)
    assert evidence_problems(ext, {f["id"]: f["text"] for f in frags(WEEKEND_1)}) == []
    req = fake.requests[0]
    assert req["output_config"]["effort"] == "medium" and req["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in req and req["max_tokens"] >= 16000


def test_a_ref_on_file_is_kept_and_not_found_facts_become_null():
    answer = {**WEEKEND_ANSWER, "change_requests": [], "acceptances": [
        {"ref": "BAYMIX_WEEKEND_OCT10", "supplier_acceptance": "ACCEPTED", "quote": "x", "fragments": []}]}
    L.set_client(FakeClient(answer))
    ext = L.read_email(WEEKEND_1.id, {}, frags(WEEKEND_1), on_file=["baymix_weekend_oct10: Weekend delivery"],
                       ref_prefix="baymix")
    assert ext["acceptances"][0]["ref"] == "baymix_weekend_oct10" and ext["acceptances"][0]["supplier_acceptance"] == "accepted"
    facts = L._facts([{"name": "QUOTE_DATE", "found": False, "value": "", "quote": "", "fragments": [], "missing_reason": "no date"},
                      {"name": "incorporates_terms", "found": True, "value": "True", "quote": "q", "fragments": ["f"],
                       "missing_reason": ""}], ("quote_date", "incorporates_terms", "unit"))
    assert facts["quote_date"] == {"value": None, "missing_reason": "no date"}
    assert facts["incorporates_terms"]["value"] is True
    assert facts["unit"] == {"value": None, "missing_reason": "not stated in the document"}  # not returned at all


def test_a_pdf_takes_two_calls_classify_then_its_kind():
    quote_answer = {"facts": [{"name": "supplier_name", "found": True, "value": "BayMix Supply", "quote": "BayMix Supply",
                               "fragments": ["frag_bm_quote_p1_l1"], "missing_reason": ""}],
                    "terms": [], "instructions_found": []}
    fake = FakeClient({"document_kind": "QUOTE", "title_quote": "QUOTATION BMQ-4417", "fragments": ["frag_bm_quote_p1_l3"]}, quote_answer)
    L.set_client(fake)
    ext = L.read_pdf(QUOTE.id, file_bytes(QUOTE), frags(QUOTE))
    assert ext["document_kind"] == "quote" and len(ext["calls"]) == 2 and len(fake.requests) == 2
    assert fake.requests[0]["messages"][0]["content"][0]["type"] == "document"


def test_refusals_and_bad_requests_go_to_review_and_server_errors_are_retried():
    L.set_client(FakeClient(WEEKEND_ANSWER, stop_reason="refusal"))
    with pytest.raises(L.ExtractionFailed, match="declined"):
        L.read_email(WEEKEND_1.id, {}, frags(WEEKEND_1), [], "baymix")
    L.set_client(FakeClient(WEEKEND_ANSWER, stop_reason="max_tokens"))
    with pytest.raises(L.ExtractionFailed, match="cut off"):
        L.read_email(WEEKEND_1.id, {}, frags(WEEKEND_1), [], "baymix")
    L.set_client(FakeClient(error(anthropic.BadRequestError, 400, "Schema is too complex")))
    with pytest.raises(L.ExtractionFailed, match="400"):
        L.read_email(WEEKEND_1.id, {}, frags(WEEKEND_1), [], "baymix")
    L.set_client(FakeClient(error(anthropic.InternalServerError, 500, "overloaded")))
    with pytest.raises(anthropic.InternalServerError):
        L.read_email(WEEKEND_1.id, {}, frags(WEEKEND_1), [], "baymix")
