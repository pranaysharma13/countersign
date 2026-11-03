"""Labelled fixture extractions for the companion invoices. Built from the document
fragments so line numbers can't drift. Written to data/fixtures/companions/extractions/.
"""

from __future__ import annotations

from typing import Any

from .companion_world import (CEDAR_GROSS_CENTS, CEDAR_INVOICE, CEDAR_INV_NUMBER, CEDAR_PO, CEDAR_QTY_MILLI,
                              CEDAR_QUOTE, CEDAR_UNIT_CENTS, HP_GROSS_CENTS, HP_INVOICE, HP_PO, HP_QTY_MILLI, HP_QUOTE,
                              HP_UNIT_CENTS, HARBOR_INV_NUMBER, INJECT_TEXT, NL_BANK_1, NL_GROSS_CENTS, NL_INVOICE,
                              NL_PO, NL_QTY_MILLI, NL_QUOTE, NL_UNIT_CENTS, NORTHLINE_INV_NUMBER, PEAK_INV_NUMBER,
                              PF_GROSS_CENTS, PF_INVOICE, PF_PO, PF_QTY_MILLI, PF_QUOTE, PF_UNIT_CENTS, REDLINE_INV_NUMBER,
                              RH_FUEL_CENTS, RH_FUEL_QTY_MILLI, RH_GROSS_CENTS, RH_INVOICE, RH_MATERIAL_CENTS, RH_PO,
                              RH_QTY_MILLI, RH_QUOTE, RH_UNIT_CENTS, VALLEY_INV_NUMBER, VS_CEILING_CENTS,
                              VS_CEILING_QTY_MILLI, VS_GROSS_CENTS, VS_INVOICE, VS_PO, VS_QTY_MILLI, VS_QUOTE,
                              VS_UNIT_CENTS, BAYLINE_INV_NUMBER, BE_GROSS_CENTS, BE_INVOICE, BE_PO, BE_QTY_MILLI,
                              BE_QUOTE, BE_UNIT_CENTS, DELTA_INV_NUMBER, DP_FUEL_CENTS, DP_FUEL_QTY_MILLI,
                              DP_FUEL_UNIT_CENTS, DP_GROSS_CENTS, DP_INVOICE, DP_PO, DP_PUMP_CENTS, DP_QTY_MILLI,
                              DP_QUOTE, DP_UNIT_CENTS, RD_BILLED_UNIT_CENTS, RD_GROSS_CENTS, RD_INVOICE, RD_PO,
                              RD_QTY_MILLI, RD_QUOTE, RD_QUOTED_CENTS, RD_QUOTED_UNIT_CENTS, RIDGEWAY_INV_NUMBER)
from .supplier_docs import fragments
from .supplier_world import PROJECT, SourceDoc


def _one(doc: SourceDoc, *needles: str):
    hits = [f for f in fragments(doc) if all(n in f.text for n in needles) and not f.id.endswith("_body")]
    if len(hits) != 1:
        raise RuntimeError(f"{doc.id} {needles!r}: {[f.id + ':' + f.text for f in hits]}")
    return hits[0]


def _exact(doc: SourceDoc, text: str):
    hits = [f for f in fragments(doc) if f.text == text]
    if len(hits) != 1:
        raise RuntimeError(f"{doc.id} exact {text!r}: {[f.id for f in hits]}")
    return hits[0]


def _join(doc: SourceDoc, *needles_per_frag: tuple[str, ...]) -> tuple[str, list[str]]:
    frags = [_one(doc, *n) for n in needles_per_frag]
    return " ".join(f.text for f in frags), [f.id for f in frags]


def _field(doc: SourceDoc, value: Any, *needles: str) -> dict[str, Any]:
    f = _one(doc, *needles)
    return {"value": value, "quote": f.text, "fragments": [f.id]}


def _exact_field(doc: SourceDoc, value: Any, text: str) -> dict[str, Any]:
    f = _exact(doc, text)
    return {"value": value, "quote": f.text, "fragments": [f.id]}


def _term(code: str, label: str, amount_cents: int, quantity_milli: int, quote: str, frag_ids: list[str],
          scope: dict[str, Any], effective_from: str = "", effective_to: str = "") -> dict[str, Any]:
    return {"code": code, "label": label, "amount_cents": amount_cents, "quantity_milli": quantity_milli,
            "scope": scope, "effective_from": effective_from, "effective_to": effective_to,
            "quote": quote, "fragments": frag_ids}


def _wrap(document_id: str, document_kind: str, **body: Any) -> dict[str, Any]:
    return {"document_id": document_id, "document_kind": document_kind, "mode": "fixture",
            "label": "FIXTURE: pre-labelled extraction (AI_MODE=fixture), not a live model call",
            "prompt_version": "fixture-v1", "instructions_found": [], **body}


def cedar_quote() -> dict[str, Any]:
    price_q, price_ids = _join(CEDAR_QUOTE, ("Unit price: $20.90",), ("Price validity: fixed",))
    extra_q, extra_ids = _join(CEDAR_QUOTE, ("Additional charges.",), ("in writing before the work.",))
    return _wrap(CEDAR_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(CEDAR_QUOTE, "Cedar & Bolt Lumber", "Cedar & Bolt Lumber"),
        "quote_number": _field(CEDAR_QUOTE, "CBQ-880", "QUOTATION CBQ-880"),
        "quote_date": _field(CEDAR_QUOTE, "2026-10-06", "Quote date: 2026-10-06"),
        "project_name": _field(CEDAR_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(CEDAR_QUOTE, "CDX plywood, 4 ft x 8 ft x 3/4 in., grade stamped", "Product: CDX plywood"),
        "unit": _field(CEDAR_QUOTE, "sheet", "200 sheets, delivered"),
        "buyer_accepted_on": _field(CEDAR_QUOTE, "2026-10-08", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(CEDAR_QUOTE, True, "This quote incorporates the Cedar & Bolt"),
    }, terms=[
        _term("unit_price", "Unit price, delivered", CEDAR_UNIT_CENTS, 0, price_q, price_ids,
              {"unit": "sheet"}, "2026-10-08", "2026-10-31"),
        _term("max_quantity", "Maximum quantity", 0, CEDAR_QTY_MILLI,
              _one(CEDAR_QUOTE, "Maximum quantity: 200 sheets").text,
              [_one(CEDAR_QUOTE, "Maximum quantity: 200 sheets").id],
              {"unit": "sheet"}, "2026-10-08", "2026-10-31"),
        _term("valid_through", "Price validity", 0, 0,
              _one(CEDAR_QUOTE, "Price validity: fixed").text,
              [_one(CEDAR_QUOTE, "Price validity: fixed").id],
              {}, "2026-10-08", "2026-10-31"),
        _term("payment_terms", "Net 15", 0, 0,
              _one(CEDAR_QUOTE, "Payment terms: Net 15").text,
              [_one(CEDAR_QUOTE, "Payment terms: Net 15").id],
              {"net_days": 15}),
        _term("price_change_rule", "Price changes need mutual written agreement", 0, 0,
              " ".join(f.text for f in [_one(CEDAR_QUOTE, "Price changes. Any price change"),
                                        _one(CEDAR_QUOTE, "before the affected deliveries.")]),
              [_one(CEDAR_QUOTE, "Price changes. Any price change").id,
               _one(CEDAR_QUOTE, "before the affected deliveries.").id],
              {}),
        _term("extra_charge_rule", "Extra charges only when agreed in writing first", 0, 0, extra_q, extra_ids, {}),
    ])


def cedar_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(CEDAR_PO, ("Cedar & Bolt Lumber acknowledges",), ("Acknowledged by: Mei Chen",))
    return _wrap(CEDAR_PO.id, "po", fields={
        "po_number": _field(CEDAR_PO, "MF-PO-1044", "PURCHASE ORDER MF-PO-1044"),
        "po_date": _field(CEDAR_PO, "2026-10-08", "PO date: 2026-10-08"),
        "supplier_name": _field(CEDAR_PO, "Cedar & Bolt Lumber", "Supplier: Cedar & Bolt Lumber"),
        "project_name": _field(CEDAR_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(CEDAR_PO, CEDAR_GROSS_CENTS, "PO total, not to exceed: $4,180.00"),
        "incorporates_quote": _field(CEDAR_PO, "CBQ-880", "Terms: Cedar & Bolt Quote CBQ-880"),
        "supplier_acknowledged_on": {"value": "2026-10-08", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "CDX plywood 4x8 3/4 in.",
        "quantity_milli": CEDAR_QTY_MILLI, "unit": "sheet",
        "unit_price_cents": CEDAR_UNIT_CENTS, "amount_cents": CEDAR_GROSS_CENTS,
        "quote": _one(CEDAR_PO, "CDX plywood 4x8 3/4 in.").text,
        "fragments": [_one(CEDAR_PO, "CDX plywood 4x8 3/4 in.").id],
    }])


def cedar_invoice() -> dict[str, Any]:
    return _wrap(CEDAR_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(CEDAR_INVOICE, "Cedar & Bolt Lumber", "Cedar & Bolt Lumber"),
        "invoice_number": _field(CEDAR_INVOICE, CEDAR_INV_NUMBER, "INVOICE CB-8802"),
        "invoice_date": _field(CEDAR_INVOICE, "2026-10-22", "Invoice date: 2026-10-22"),
        "due_date": _field(CEDAR_INVOICE, "2026-11-06", "Due date: 2026-11-06 (Net 15)"),
        "po_number": _field(CEDAR_INVOICE, "MF-PO-1044", "Your PO: MF-PO-1044"),
        "currency": _field(CEDAR_INVOICE, "USD", "Gross amount: $4,180.00"),
        "gross_cents": _field(CEDAR_INVOICE, CEDAR_GROSS_CENTS, "Gross amount: $4,180.00"),
        "balance_requested_cents": _field(CEDAR_INVOICE, CEDAR_GROSS_CENTS, "Balance due: $4,180.00"),
        "remit_account_last4": _field(CEDAR_INVOICE, "5531", "account ending 5531"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "CDX plywood 4x8 3/4 in.",
        "quantity_milli": CEDAR_QTY_MILLI, "unit": "sheet",
        "unit_price_cents": CEDAR_UNIT_CENTS, "amount_cents": CEDAR_GROSS_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(CEDAR_INVOICE, "CDX plywood 4x8 3/4 in.").text,
        "fragments": [_one(CEDAR_INVOICE, "CDX plywood 4x8 3/4 in.").id],
    }])


def nl_quote() -> dict[str, Any]:
    price_q, price_ids = _join(NL_QUOTE, ("Unit price: $1,250.00",), ("Price validity: fixed",))
    extra_q, extra_ids = _join(NL_QUOTE, ("Additional charges.",), ("in writing before the work.",))
    return _wrap(NL_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(NL_QUOTE, "Northline Rebar", "Northline Rebar"),
        "quote_number": _field(NL_QUOTE, "NLQ-19", "QUOTATION NLQ-19"),
        "quote_date": _field(NL_QUOTE, "2026-10-02", "Quote date: 2026-10-02"),
        "project_name": _field(NL_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(NL_QUOTE, "Grade 60 reinforcing bar, #5, cut and bent to the Oakview footing schedule",
                          "Product: Grade 60 reinforcing bar"),
        "unit": _field(NL_QUOTE, "ton", "2 tons, delivered"),
        "buyer_accepted_on": _field(NL_QUOTE, "2026-10-06", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(NL_QUOTE, True, "This quote incorporates the Northline Rebar"),
    }, terms=[
        _term("unit_price", "Unit price, delivered", NL_UNIT_CENTS, 0, price_q, price_ids,
              {"unit": "ton"}, "2026-10-06", "2026-10-31"),
        _term("max_quantity", "Maximum quantity", 0, NL_QTY_MILLI,
              _one(NL_QUOTE, "Maximum quantity: 2 tons").text,
              [_one(NL_QUOTE, "Maximum quantity: 2 tons").id],
              {"unit": "ton"}, "2026-10-06", "2026-10-31"),
        _term("valid_through", "Price validity", 0, 0,
              _one(NL_QUOTE, "Price validity: fixed").text,
              [_one(NL_QUOTE, "Price validity: fixed").id],
              {}, "2026-10-06", "2026-10-31"),
        _term("payment_terms", "Net 30", 0, 0,
              _one(NL_QUOTE, "Payment terms: Net 30").text,
              [_one(NL_QUOTE, "Payment terms: Net 30").id],
              {"net_days": 30}),
        _term("price_change_rule", "Price changes need mutual written agreement", 0, 0,
              " ".join(f.text for f in [_one(NL_QUOTE, "Price changes. Any price change"),
                                        _one(NL_QUOTE, "before the affected deliveries.")]),
              [_one(NL_QUOTE, "Price changes. Any price change").id,
               _one(NL_QUOTE, "before the affected deliveries.").id],
              {}),
        _term("extra_charge_rule", "Extra charges only when agreed in writing first", 0, 0, extra_q, extra_ids, {}),
    ])


def nl_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(NL_PO, ("Northline Rebar acknowledges",), ("Acknowledged by: Tomas Reed",))
    return _wrap(NL_PO.id, "po", fields={
        "po_number": _field(NL_PO, "MF-PO-1051", "PURCHASE ORDER MF-PO-1051"),
        "po_date": _field(NL_PO, "2026-10-06", "PO date: 2026-10-06"),
        "supplier_name": _field(NL_PO, "Northline Rebar", "Supplier: Northline Rebar"),
        "project_name": _field(NL_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(NL_PO, NL_GROSS_CENTS, "PO total, not to exceed: $2,500.00"),
        "incorporates_quote": _field(NL_PO, "NLQ-19", "Terms: Northline Rebar Quote NLQ-19"),
        "supplier_acknowledged_on": {"value": "2026-10-06", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "Grade 60 rebar #5, cut and bent",
        "quantity_milli": NL_QTY_MILLI, "unit": "ton",
        "unit_price_cents": NL_UNIT_CENTS, "amount_cents": NL_GROSS_CENTS,
        "quote": _one(NL_PO, "Grade 60 rebar #5, cut and bent").text,
        "fragments": [_one(NL_PO, "Grade 60 rebar #5, cut and bent").id],
    }])


def nl_invoice() -> dict[str, Any]:
    return _wrap(NL_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(NL_INVOICE, "Northline Rebar", "Northline Rebar"),
        "invoice_number": _field(NL_INVOICE, NORTHLINE_INV_NUMBER, "INVOICE NL-441"),
        "invoice_date": _field(NL_INVOICE, "2026-10-21", "Invoice date: 2026-10-21"),
        "due_date": _field(NL_INVOICE, "2026-11-20", "Due date: 2026-11-20 (Net 30)"),
        "po_number": _field(NL_INVOICE, "MF-PO-1051", "Your PO: MF-PO-1051"),
        "currency": _field(NL_INVOICE, "USD", "Gross amount: $2,500.00"),
        "gross_cents": _field(NL_INVOICE, NL_GROSS_CENTS, "Gross amount: $2,500.00"),
        "balance_requested_cents": _field(NL_INVOICE, NL_GROSS_CENTS, "Balance due: $2,500.00"),
        "remit_account_last4": _field(NL_INVOICE, "4188", "account ending 4188"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "Grade 60 rebar #5, cut and bent",
        "quantity_milli": NL_QTY_MILLI, "unit": "ton",
        "unit_price_cents": NL_UNIT_CENTS, "amount_cents": NL_GROSS_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(NL_INVOICE, "Grade 60 rebar #5, cut and bent").text,
        "fragments": [_one(NL_INVOICE, "Grade 60 rebar #5, cut and bent").id],
    }])


def nl_bank_email() -> dict[str, Any]:
    return _wrap(NL_BANK_1.id, "email", fields={
        "subject": _field(NL_BANK_1, "Updated remittance account for invoice NL-441",
                          "Please remit invoice NL-441"),
        "requested_last4": _field(NL_BANK_1, "7703", "account ending 7703"),
    }, change_requests=[], acceptances=[], internal_approval_claims=[],
        payee_change_requests=[{"last4": "7703", "bank_name": "Harbor Wire Bank",
                                **{k: v for k, v in _field(NL_BANK_1, None, "account ending 7703").items() if k != "value"}}])


def _agreed_terms(doc: SourceDoc, unit: str, unit_cents: int, qty_milli: int, price_needle: str,
                  max_qty_needle: str, net_days: int, valid_from: str, valid_to: str) -> list[dict[str, Any]]:
    price_q, price_ids = _join(doc, (price_needle,), ("Price validity: fixed",))
    extra_q, extra_ids = _join(doc, ("Additional charges.",), ("in writing before the work.",))
    return [
        _term("unit_price", "Unit price, delivered", unit_cents, 0, price_q, price_ids,
              {"unit": unit}, valid_from, valid_to),
        _term("max_quantity", "Maximum quantity", 0, qty_milli,
              _one(doc, max_qty_needle).text, [_one(doc, max_qty_needle).id],
              {"unit": unit}, valid_from, valid_to),
        _term("valid_through", "Price validity", 0, 0,
              _one(doc, "Price validity: fixed").text, [_one(doc, "Price validity: fixed").id],
              {}, valid_from, valid_to),
        _term("payment_terms", f"Net {net_days}", 0, 0,
              _one(doc, f"Payment terms: Net {net_days}").text,
              [_one(doc, f"Payment terms: Net {net_days}").id], {"net_days": net_days}),
        _term("price_change_rule", "Price changes need mutual written agreement", 0, 0,
              " ".join(f.text for f in [_one(doc, "Price changes. Any price change"),
                                        _one(doc, "before the affected deliveries.")]),
              [_one(doc, "Price changes. Any price change").id,
               _one(doc, "before the affected deliveries.").id], {}),
        _term("extra_charge_rule", "Extra charges only when agreed in writing first", 0, 0, extra_q, extra_ids, {}),
    ]


def harbor_quote() -> dict[str, Any]:
    return _wrap(HP_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(HP_QUOTE, "Harbor Pack Crating", "Harbor Pack Crating"),
        "quote_number": _field(HP_QUOTE, "HPQ-22", "QUOTATION HPQ-22"),
        "quote_date": _field(HP_QUOTE, "2026-10-07", "Quote date: 2026-10-07"),
        "project_name": _field(HP_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(HP_QUOTE, "Heat-treated export crate, 48 in. x 40 in., delivered to the project",
                          "Product: Heat-treated export crate"),
        "unit": _field(HP_QUOTE, "crate", "40 crates, delivered"),
        "buyer_accepted_on": _field(HP_QUOTE, "2026-10-09", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(HP_QUOTE, True, "This quote incorporates the Harbor Pack"),
    }, terms=_agreed_terms(HP_QUOTE, "crate", HP_UNIT_CENTS, HP_QTY_MILLI, "Unit price: $18.50",
                           "Maximum quantity: 40 crates", 15, "2026-10-09", "2026-10-31"))


def harbor_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(HP_PO, ("Harbor Pack Crating acknowledges",), ("Acknowledged by: Nora Hale",))
    return _wrap(HP_PO.id, "po", fields={
        "po_number": _field(HP_PO, "MF-PO-1062", "PURCHASE ORDER MF-PO-1062"),
        "po_date": _field(HP_PO, "2026-10-09", "PO date: 2026-10-09"),
        "supplier_name": _field(HP_PO, "Harbor Pack Crating", "Supplier: Harbor Pack Crating"),
        "project_name": _field(HP_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(HP_PO, HP_GROSS_CENTS, "PO total, not to exceed: $740.00"),
        "incorporates_quote": _field(HP_PO, "HPQ-22", "Terms: Harbor Pack Crating Quote HPQ-22"),
        "supplier_acknowledged_on": {"value": "2026-10-09", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "Heat-treated export crate 48x40",
        "quantity_milli": HP_QTY_MILLI, "unit": "crate",
        "unit_price_cents": HP_UNIT_CENTS, "amount_cents": HP_GROSS_CENTS,
        "quote": _one(HP_PO, "Heat-treated export crate 48x40").text,
        "fragments": [_one(HP_PO, "Heat-treated export crate 48x40").id],
    }])


def harbor_invoice() -> dict[str, Any]:
    inj = _one(HP_INVOICE, INJECT_TEXT)
    return _wrap(HP_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(HP_INVOICE, "Harbor Pack Crating", "Harbor Pack Crating"),
        "invoice_number": _field(HP_INVOICE, HARBOR_INV_NUMBER, "INVOICE HP-220"),
        "invoice_date": _field(HP_INVOICE, "2026-10-20", "Invoice date: 2026-10-20"),
        "due_date": _field(HP_INVOICE, "2026-11-04", "Due date: 2026-11-04 (Net 15)"),
        "po_number": _field(HP_INVOICE, "MF-PO-1062", "Your PO: MF-PO-1062"),
        "currency": _field(HP_INVOICE, "USD", "Gross amount: $740.00"),
        "gross_cents": _field(HP_INVOICE, HP_GROSS_CENTS, "Gross amount: $740.00"),
        "balance_requested_cents": _field(HP_INVOICE, HP_GROSS_CENTS, "Balance due: $740.00"),
        "remit_account_last4": _field(HP_INVOICE, "6144", "account ending 6144"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "Heat-treated export crate 48x40",
        "quantity_milli": HP_QTY_MILLI, "unit": "crate",
        "unit_price_cents": HP_UNIT_CENTS, "amount_cents": HP_GROSS_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(HP_INVOICE, "Heat-treated export crate 48x40").text,
        "fragments": [_one(HP_INVOICE, "Heat-treated export crate 48x40").id],
    }], instructions_found=[inj.text], instruction_fragments=[inj.id])


def valley_quote() -> dict[str, Any]:
    return _wrap(VS_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(VS_QUOTE, "Valley Sand & Gravel", "Valley Sand & Gravel"),
        "quote_number": _field(VS_QUOTE, "VSQ-31", "QUOTATION VSQ-31"),
        "quote_date": _field(VS_QUOTE, "2026-10-08", "Quote date: 2026-10-08"),
        "project_name": _field(VS_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(VS_QUOTE, "Washed concrete sand, delivered to the project",
                          "Product: Washed concrete sand"),
        "unit": _field(VS_QUOTE, "ton", "80 tons, delivered"),
        "buyer_accepted_on": _field(VS_QUOTE, "2026-10-10", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(VS_QUOTE, True, "This quote incorporates the Valley Sand"),
    }, terms=_agreed_terms(VS_QUOTE, "ton", VS_UNIT_CENTS, VS_CEILING_QTY_MILLI, "Unit price: $42.00",
                           "Maximum quantity: 80 tons", 15, "2026-10-10", "2026-10-31"))


def valley_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(VS_PO, ("Valley Sand & Gravel acknowledges",), ("Acknowledged by: Cal Rivera",))
    return _wrap(VS_PO.id, "po", fields={
        "po_number": _field(VS_PO, "MF-PO-1073", "PURCHASE ORDER MF-PO-1073"),
        "po_date": _field(VS_PO, "2026-10-10", "PO date: 2026-10-10"),
        "supplier_name": _field(VS_PO, "Valley Sand & Gravel", "Supplier: Valley Sand & Gravel"),
        "project_name": _field(VS_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(VS_PO, VS_CEILING_CENTS, "PO total, not to exceed: $3,360.00"),
        "incorporates_quote": _field(VS_PO, "VSQ-31", "Terms: Valley Sand & Gravel Quote VSQ-31"),
        "supplier_acknowledged_on": {"value": "2026-10-10", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "Washed concrete sand",
        "quantity_milli": VS_CEILING_QTY_MILLI, "unit": "ton",
        "unit_price_cents": VS_UNIT_CENTS, "amount_cents": VS_CEILING_CENTS,
        "quote": _one(VS_PO, "Washed concrete sand").text,
        "fragments": [_one(VS_PO, "Washed concrete sand").id],
    }])


def valley_invoice() -> dict[str, Any]:
    return _wrap(VS_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(VS_INVOICE, "Valley Sand & Gravel", "Valley Sand & Gravel"),
        "invoice_number": _field(VS_INVOICE, VALLEY_INV_NUMBER, "INVOICE VS-310"),
        "invoice_date": _field(VS_INVOICE, "2026-10-21", "Invoice date: 2026-10-21"),
        "due_date": _field(VS_INVOICE, "2026-11-05", "Due date: 2026-11-05 (Net 15)"),
        "po_number": _field(VS_INVOICE, "MF-PO-1073", "Your PO: MF-PO-1073"),
        "currency": _field(VS_INVOICE, "USD", "Gross amount: $3,990.00"),
        "gross_cents": _field(VS_INVOICE, VS_GROSS_CENTS, "Gross amount: $3,990.00"),
        "balance_requested_cents": _field(VS_INVOICE, VS_GROSS_CENTS, "Balance due: $3,990.00"),
        "remit_account_last4": _field(VS_INVOICE, "3382", "account ending 3382"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "Washed concrete sand",
        "quantity_milli": VS_QTY_MILLI, "unit": "ton",
        "unit_price_cents": VS_UNIT_CENTS, "amount_cents": VS_GROSS_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(VS_INVOICE, "Washed concrete sand").text,
        "fragments": [_one(VS_INVOICE, "Washed concrete sand").id],
    }])


def redline_quote() -> dict[str, Any]:
    return _wrap(RH_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(RH_QUOTE, "Redline Haul", "Redline Haul"),
        "quote_number": _field(RH_QUOTE, "RHQ-14", "QUOTATION RHQ-14"),
        "quote_date": _field(RH_QUOTE, "2026-10-09", "Quote date: 2026-10-09"),
        "project_name": _field(RH_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(RH_QUOTE, "Dump truck haul, 12-yard, site to plant, delivered loads",
                          "Product: Dump truck haul"),
        "unit": _field(RH_QUOTE, "load", "12 loads, delivered"),
        "buyer_accepted_on": _field(RH_QUOTE, "2026-10-11", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(RH_QUOTE, True, "This quote incorporates the Redline Haul"),
    }, terms=_agreed_terms(RH_QUOTE, "load", RH_UNIT_CENTS, RH_QTY_MILLI, "Unit price: $380.00",
                           "Maximum quantity: 12 loads", 15, "2026-10-11", "2026-10-31"))


def redline_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(RH_PO, ("Redline Haul acknowledges",), ("Acknowledged by: Tess Quinn",))
    return _wrap(RH_PO.id, "po", fields={
        "po_number": _field(RH_PO, "MF-PO-1095", "PURCHASE ORDER MF-PO-1095"),
        "po_date": _field(RH_PO, "2026-10-11", "PO date: 2026-10-11"),
        "supplier_name": _field(RH_PO, "Redline Haul", "Supplier: Redline Haul"),
        "project_name": _field(RH_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(RH_PO, RH_MATERIAL_CENTS, "PO total, not to exceed: $4,560.00"),
        "incorporates_quote": _field(RH_PO, "RHQ-14", "Terms: Redline Haul Quote RHQ-14"),
        "supplier_acknowledged_on": {"value": "2026-10-11", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "Dump truck haul 12-yard",
        "quantity_milli": RH_QTY_MILLI, "unit": "load",
        "unit_price_cents": RH_UNIT_CENTS, "amount_cents": RH_MATERIAL_CENTS,
        "quote": _one(RH_PO, "Dump truck haul 12-yard").text,
        "fragments": [_one(RH_PO, "Dump truck haul 12-yard").id],
    }])


def redline_invoice() -> dict[str, Any]:
    return _wrap(RH_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(RH_INVOICE, "Redline Haul", "Redline Haul"),
        "invoice_number": _field(RH_INVOICE, REDLINE_INV_NUMBER, "INVOICE RH-55"),
        "invoice_date": _field(RH_INVOICE, "2026-10-22", "Invoice date: 2026-10-22"),
        "due_date": _field(RH_INVOICE, "2026-11-06", "Due date: 2026-11-06 (Net 15)"),
        "po_number": _field(RH_INVOICE, "MF-PO-1095", "Your PO: MF-PO-1095"),
        "currency": _field(RH_INVOICE, "USD", "Gross amount: $4,740.00"),
        "gross_cents": _field(RH_INVOICE, RH_GROSS_CENTS, "Gross amount: $4,740.00"),
        "balance_requested_cents": _field(RH_INVOICE, RH_GROSS_CENTS, "Balance due: $4,740.00"),
        "remit_account_last4": _field(RH_INVOICE, "9021", "account ending 9021"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "Dump truck haul 12-yard",
        "quantity_milli": RH_QTY_MILLI, "unit": "load",
        "unit_price_cents": RH_UNIT_CENTS, "amount_cents": RH_MATERIAL_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(RH_INVOICE, "Dump truck haul 12-yard").text,
        "fragments": [_one(RH_INVOICE, "Dump truck haul 12-yard").id],
    }, {
        "kind": "fuel", "description": "Fuel surcharge",
        "quantity_milli": RH_FUEL_QTY_MILLI, "unit": "ea",
        "unit_price_cents": RH_FUEL_CENTS, "amount_cents": RH_FUEL_CENTS,
        "quote": _one(RH_INVOICE, "Fuel surcharge").text,
        "fragments": [_one(RH_INVOICE, "Fuel surcharge").id],
    }])


def peak_quote() -> dict[str, Any]:
    return _wrap(PF_QUOTE.id, "quote", fields={
        "supplier_name": _exact_field(PF_QUOTE, "Peak Form Supply", "Peak Form Supply"),
        "quote_number": _field(PF_QUOTE, "PFQ-8", "QUOTATION PFQ-8"),
        "quote_date": _field(PF_QUOTE, "2026-10-05", "Quote date: 2026-10-05"),
        "project_name": _field(PF_QUOTE, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(PF_QUOTE, "Steel-faced form panel, 2 ft x 8 ft, delivered to the project",
                          "Product: Steel-faced form panel"),
        "unit": _field(PF_QUOTE, "panel", "30 panels, delivered"),
        "buyer_accepted_on": _field(PF_QUOTE, "2026-10-07", "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(PF_QUOTE, True, "This quote incorporates the Peak Form"),
    }, terms=_agreed_terms(PF_QUOTE, "panel", PF_UNIT_CENTS, PF_QTY_MILLI, "Unit price: $55.00",
                           "Maximum quantity: 30 panels", 15, "2026-10-07", "2026-10-31"))


def peak_po() -> dict[str, Any]:
    ack_q, ack_ids = _join(PF_PO, ("Peak Form Supply acknowledges",), ("Acknowledged by: Ira Voss",))
    return _wrap(PF_PO.id, "po", fields={
        "po_number": _field(PF_PO, "MF-PO-1084", "PURCHASE ORDER MF-PO-1084"),
        "po_date": _field(PF_PO, "2026-10-07", "PO date: 2026-10-07"),
        "supplier_name": _field(PF_PO, "Peak Form Supply", "Supplier: Peak Form Supply"),
        "project_name": _field(PF_PO, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(PF_PO, PF_GROSS_CENTS, "PO total, not to exceed: $1,650.00"),
        "incorporates_quote": _field(PF_PO, "PFQ-8", "Terms: Peak Form Supply Quote PFQ-8"),
        "supplier_acknowledged_on": {"value": "2026-10-07", "quote": ack_q, "fragments": ack_ids},
    }, lines=[{
        "kind": "material", "description": "Steel-faced form panel 2x8",
        "quantity_milli": PF_QTY_MILLI, "unit": "panel",
        "unit_price_cents": PF_UNIT_CENTS, "amount_cents": PF_GROSS_CENTS,
        "quote": _one(PF_PO, "Steel-faced form panel 2x8").text,
        "fragments": [_one(PF_PO, "Steel-faced form panel 2x8").id],
    }])


def peak_invoice() -> dict[str, Any]:
    return _wrap(PF_INVOICE.id, "invoice", fields={
        "supplier_name": _exact_field(PF_INVOICE, "Peak Form Supply", "Peak Form Supply"),
        "invoice_number": _field(PF_INVOICE, PEAK_INV_NUMBER, "INVOICE PF-77"),
        "invoice_date": _field(PF_INVOICE, "2026-10-23", "Invoice date: 2026-10-23"),
        "due_date": _field(PF_INVOICE, "2026-11-07", "Due date: 2026-11-07 (Net 15)"),
        "po_number": _field(PF_INVOICE, "MF-PO-1084", "Your PO: MF-PO-1084"),
        "currency": _field(PF_INVOICE, "USD", "Gross amount: $1,650.00"),
        "gross_cents": _field(PF_INVOICE, PF_GROSS_CENTS, "Gross amount: $1,650.00"),
        "balance_requested_cents": _field(PF_INVOICE, PF_GROSS_CENTS, "Balance due: $1,650.00"),
        "remit_account_last4": _field(PF_INVOICE, "4470", "account ending 4470"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{
        "kind": "material", "description": "Steel-faced form panel 2x8",
        "quantity_milli": PF_QTY_MILLI, "unit": "panel",
        "unit_price_cents": PF_UNIT_CENTS, "amount_cents": PF_GROSS_CENTS,
        "links": {"term_code": "unit_price"},
        "quote": _one(PF_INVOICE, "Steel-faced form panel 2x8").text,
        "fragments": [_one(PF_INVOICE, "Steel-faced form panel 2x8").id],
    }])


def _quote(doc: SourceDoc, supplier: str, number: str, date: str, product: str, product_needle: str, unit: str,
           unit_needle: str, accepted_on: str, terms_needle: str, terms: list[dict[str, Any]]) -> dict[str, Any]:
    return _wrap(doc.id, "quote", fields={
        "supplier_name": _exact_field(doc, supplier, supplier),
        "quote_number": _field(doc, number, f"QUOTATION {number}"),
        "quote_date": _field(doc, date, f"Quote date: {date}"),
        "project_name": _field(doc, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "product": _field(doc, product, product_needle),
        "unit": _field(doc, unit, unit_needle),
        "buyer_accepted_on": _field(doc, accepted_on, "Accepted for Marlow & Finch"),
        "incorporates_terms": _field(doc, True, terms_needle),
    }, terms=terms)


def _po(doc: SourceDoc, number: str, date: str, supplier: str, ack_by: str, quote_no: str, nte_cents: int,
        nte_needle: str, line: dict[str, Any], line_needle: str) -> dict[str, Any]:
    ack_q, ack_ids = _join(doc, (f"{supplier} acknowledges",), (f"Acknowledged by: {ack_by}",))
    return _wrap(doc.id, "po", fields={
        "po_number": _field(doc, number, f"PURCHASE ORDER {number}"),
        "po_date": _field(doc, date, f"PO date: {date}"),
        "supplier_name": _field(doc, supplier, f"Supplier: {supplier}"),
        "project_name": _field(doc, PROJECT.name, "Project: Oakview Lane Fourplex"),
        "not_to_exceed_cents": _field(doc, nte_cents, nte_needle),
        "incorporates_quote": _field(doc, quote_no, f"Terms: {supplier} Quote {quote_no}"),
        "supplier_acknowledged_on": {"value": date, "quote": ack_q, "fragments": ack_ids},
    }, lines=[{**line, "quote": _one(doc, line_needle).text, "fragments": [_one(doc, line_needle).id]}])


def _invoice(doc: SourceDoc, supplier: str, number: str, date: str, due: str, due_needle: str, po_number: str,
             gross_cents: int, gross_text: str, last4: str, lines: list[tuple[dict[str, Any], str]]) -> dict[str, Any]:
    return _wrap(doc.id, "invoice", fields={
        "supplier_name": _exact_field(doc, supplier, supplier),
        "invoice_number": _field(doc, number, f"INVOICE {number}"),
        "invoice_date": _field(doc, date, f"Invoice date: {date}"),
        "due_date": _field(doc, due, due_needle),
        "po_number": _field(doc, po_number, f"Your PO: {po_number}"),
        "currency": _field(doc, "USD", f"Gross amount: {gross_text}"),
        "gross_cents": _field(doc, gross_cents, f"Gross amount: {gross_text}"),
        "balance_requested_cents": _field(doc, gross_cents, f"Balance due: {gross_text}"),
        "remit_account_last4": _field(doc, last4, f"account ending {last4}"),
        "tax_cents": {"value": None, "missing_reason": "No tax line on this invoice; no tax rate is assumed."},
    }, lines=[{**line, "quote": _one(doc, needle).text, "fragments": [_one(doc, needle).id]} for line, needle in lines])


_RD_LINE = "Type X gypsum board 4x12 5/8 in."
_BE_LINE = "THHN copper wire 12 AWG, 500 ft spool"
_DP_LINE = "Concrete boom pump 38 m, per pour"


def ridgeway_quote() -> dict[str, Any]:
    return _quote(RD_QUOTE, "Ridgeway Drywall Supply", "RDQ-61", "2026-10-07",
                  "Type X gypsum board, 4 ft x 12 ft x 5/8 in., fire rated", "Product: Type X gypsum board",
                  "sheet", "300 sheets, delivered", "2026-10-09", "This quote incorporates the Ridgeway",
                  _agreed_terms(RD_QUOTE, "sheet", RD_QUOTED_UNIT_CENTS, RD_QTY_MILLI, "Unit price: $14.25",
                                "Maximum quantity: 300 sheets", 15, "2026-10-09", "2026-10-31"))


def ridgeway_po() -> dict[str, Any]:
    return _po(RD_PO, "MF-PO-1106", "2026-10-09", "Ridgeway Drywall Supply", "Jun Park", "RDQ-61", RD_QUOTED_CENTS,
               "PO total, not to exceed: $4,275.00",
               {"kind": "material", "description": _RD_LINE, "quantity_milli": RD_QTY_MILLI, "unit": "sheet",
                "unit_price_cents": RD_QUOTED_UNIT_CENTS, "amount_cents": RD_QUOTED_CENTS}, _RD_LINE)


def ridgeway_invoice() -> dict[str, Any]:
    return _invoice(RD_INVOICE, "Ridgeway Drywall Supply", RIDGEWAY_INV_NUMBER, "2026-10-22", "2026-11-06",
                    "Due date: 2026-11-06 (Net 15)", "MF-PO-1106", RD_GROSS_CENTS, "$4,530.00", "2619",
                    [({"kind": "material", "description": _RD_LINE, "quantity_milli": RD_QTY_MILLI, "unit": "sheet",
                       "unit_price_cents": RD_BILLED_UNIT_CENTS, "amount_cents": RD_GROSS_CENTS,
                       "links": {"term_code": "unit_price"}}, _RD_LINE)])


def bayline_quote() -> dict[str, Any]:
    return _quote(BE_QUOTE, "Bayline Electric Supply", "BEQ-120", "2026-10-08",
                  "THHN copper building wire, 12 AWG, 500 ft spool", "Product: THHN copper building wire",
                  "spool", "20 spools, delivered", "2026-10-10", "This quote incorporates the Bayline",
                  _agreed_terms(BE_QUOTE, "spool", BE_UNIT_CENTS, BE_QTY_MILLI, "Unit price: $143.00",
                                "Maximum quantity: 20 spools", 30, "2026-10-10", "2026-10-31"))


def bayline_po() -> dict[str, Any]:
    return _po(BE_PO, "MF-PO-1117", "2026-10-10", "Bayline Electric Supply", "Priya Nand", "BEQ-120", BE_GROSS_CENTS,
               "PO total, not to exceed: $2,860.00",
               {"kind": "material", "description": _BE_LINE, "quantity_milli": BE_QTY_MILLI, "unit": "spool",
                "unit_price_cents": BE_UNIT_CENTS, "amount_cents": BE_GROSS_CENTS}, _BE_LINE)


def bayline_invoice() -> dict[str, Any]:
    return _invoice(BE_INVOICE, "Bayline Electric Supply", BAYLINE_INV_NUMBER, "2026-10-23", "2026-11-22",
                    "Due date: 2026-11-22 (Net 30)", "MF-PO-1117", BE_GROSS_CENTS, "$2,860.00", "8350",
                    [({"kind": "material", "description": _BE_LINE, "quantity_milli": BE_QTY_MILLI, "unit": "spool",
                       "unit_price_cents": BE_UNIT_CENTS, "amount_cents": BE_GROSS_CENTS,
                       "links": {"term_code": "unit_price"}}, _BE_LINE)])


def delta_quote() -> dict[str, Any]:
    fuel_q, fuel_ids = _join(DP_QUOTE, ("4. Fuel surcharge.",), ("adds $32.00 per pour.",))
    terms = _agreed_terms(DP_QUOTE, "pour", DP_UNIT_CENTS, DP_QTY_MILLI, "Unit price: $1,150.00",
                          "Maximum quantity: 3 pours", 15, "2026-10-08", "2026-10-31")
    terms.append(_term("fuel_surcharge_rule", "Fuel surcharge per pour when the diesel index is above $5.00/gal",
                       DP_FUEL_UNIT_CENTS, 0, fuel_q, fuel_ids, {"unit": "pour", "index_threshold_cents": 500}))
    return _quote(DP_QUOTE, "Delta Pump Services", "DPQ-41", "2026-10-06",
                  "38 m concrete boom pump with operator, up to 6 hours per pour", "Product: 38 m concrete boom pump",
                  "pour", "Maximum quantity: 3 pours", "2026-10-08", "This quote incorporates the Delta Pump",
                  terms)


def delta_po() -> dict[str, Any]:
    return _po(DP_PO, "MF-PO-1128", "2026-10-08", "Delta Pump Services", "Marco Ruiz", "DPQ-41", DP_PUMP_CENTS,
               "PO total, not to exceed: $3,450.00",
               {"kind": "material", "description": _DP_LINE, "quantity_milli": DP_QTY_MILLI, "unit": "pour",
                "unit_price_cents": DP_UNIT_CENTS, "amount_cents": DP_PUMP_CENTS}, _DP_LINE)


def delta_invoice() -> dict[str, Any]:
    return _invoice(DP_INVOICE, "Delta Pump Services", DELTA_INV_NUMBER, "2026-10-23", "2026-11-07",
                    "Due date: 2026-11-07 (Net 15)", "MF-PO-1128", DP_GROSS_CENTS, "$3,546.00", "5108",
                    [({"kind": "material", "description": _DP_LINE, "quantity_milli": DP_QTY_MILLI, "unit": "pour",
                       "unit_price_cents": DP_UNIT_CENTS, "amount_cents": DP_PUMP_CENTS,
                       "links": {"term_code": "unit_price"}}, _DP_LINE),
                     ({"kind": "fuel", "description": "Fuel surcharge, per pour", "quantity_milli": DP_FUEL_QTY_MILLI,
                       "unit": "ea", "unit_price_cents": DP_FUEL_UNIT_CENTS, "amount_cents": DP_FUEL_CENTS},
                      "Fuel surcharge, per pour")])


def all_companion_fixtures() -> dict[str, dict[str, Any]]:
    return {
        CEDAR_QUOTE.id: cedar_quote(),
        CEDAR_PO.id: cedar_po(),
        CEDAR_INVOICE.id: cedar_invoice(),
        NL_QUOTE.id: nl_quote(),
        NL_PO.id: nl_po(),
        NL_INVOICE.id: nl_invoice(),
        NL_BANK_1.id: nl_bank_email(),
        HP_QUOTE.id: harbor_quote(),
        HP_PO.id: harbor_po(),
        HP_INVOICE.id: harbor_invoice(),
        VS_QUOTE.id: valley_quote(),
        VS_PO.id: valley_po(),
        VS_INVOICE.id: valley_invoice(),
        RH_QUOTE.id: redline_quote(),
        RH_PO.id: redline_po(),
        RH_INVOICE.id: redline_invoice(),
        PF_QUOTE.id: peak_quote(),
        PF_PO.id: peak_po(),
        PF_INVOICE.id: peak_invoice(),
        RD_QUOTE.id: ridgeway_quote(),
        RD_PO.id: ridgeway_po(),
        RD_INVOICE.id: ridgeway_invoice(),
        BE_QUOTE.id: bayline_quote(),
        BE_PO.id: bayline_po(),
        BE_INVOICE.id: bayline_invoice(),
        DP_QUOTE.id: delta_quote(),
        DP_PO.id: delta_po(),
        DP_INVOICE.id: delta_invoice(),
    }
