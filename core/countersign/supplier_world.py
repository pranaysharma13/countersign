"""The v2 demo world: Marlow & Finch buys ready-mix from BayMix Supply (SPEC §8). All fictional.

Domains use the reserved .example TLD, phones use 555-01xx, bank details are dummy tokens.
Documents are written line by line; every non-blank line becomes one immutable source
fragment (supplier_docs.py). This module is model input only: the expected answers live
in data/answer_keys/ and are never read by extraction code.

Line markup: "# " heading, "## " subheading, "= " fixed-width table row. The marker is
not part of the fragment text.
"""

from __future__ import annotations

from dataclasses import dataclass

from .world import PROJECTS, Company, Project

TODAY = "2026-10-24"
PROJECT: Project = next(p for p in PROJECTS if p.id == "prj_oak")
COMPANY = Company()


@dataclass(frozen=True)
class Supplier:
    id: str
    name: str
    email_domain: str
    phone_on_file: str
    crs_ref: str
    status: str = "active"


@dataclass(frozen=True)
class Contact:
    id: str
    supplier_id: str
    name: str
    email: str
    phone: str
    title: str
    pre_established: bool  # set up before any dispute; the only contacts a payee change can be verified through


@dataclass(frozen=True)
class PayeeProfile:
    supplier_id: str
    version: int
    account_ref: str  # Nessie account token, never shown in full
    last4: str
    bank_name: str
    requested_via: str  # seed | email | portal

    @property
    def id(self) -> str:
        return f"{self.supplier_id}:v{self.version}"


@dataclass(frozen=True)
class Person:
    role: str
    name: str
    limit_cents: int  # 0 = no approval authority
    project_scope: str = "*"


@dataclass(frozen=True)
class Deposit:
    id: str
    purchase_id: str
    supplier_id: str
    amount_cents: int
    status: str
    transfer_ref: str  # simulated (mock Nessie)
    settled_on: str


@dataclass(frozen=True)
class EmailMeta:
    message_id: str
    thread_id: str
    from_address: str
    to_addresses: str
    subject: str
    sent_at_iso: str
    ingested_at_iso: str


@dataclass(frozen=True)
class SourceDoc:
    id: str
    kind: str  # quote | terms | po | invoice | email | other (CONTRACT §9.2)
    filename: str
    pages: tuple[tuple[str, ...], ...]  # PDF pages; an email has one "page" of body lines
    email: EmailMeta | None = None


BAYMIX = Supplier("sup_baymix", "BayMix Supply", "baymix-supply.example", "(510) 555-0191", "crs_test_business_09")

CONTACTS = (
    Contact("ctc_baymix_rosa", BAYMIX.id, "Rosa Delgado", "rosa.delgado@baymix-supply.example", "(510) 555-0191",
            "Sales Manager", True),
    Contact("ctc_baymix_ar", BAYMIX.id, "BayMix Accounts Receivable", "ar@baymix-supply.example", "(510) 555-0192",
            "Accounts Receivable", True),
    Contact("ctc_baymix_dispatch", BAYMIX.id, "BayMix Dispatch", "dispatch@baymix-supply.example", "(510) 555-0193",
            "Dispatch", True),
)

PAYEE_V1 = PayeeProfile(BAYMIX.id, 1, "acct_baymix_v1", "2290", "Quarry Point Bank", "seed")

PEOPLE = (
    Person("owner", COMPANY.owner_name, 250_000_00),
    Person("purchasing", "Jordan Pike", 2_000_00),
    Person("receiver", "Luis Ortega (superintendent)", 0),
    Person("bookkeeper", COMPANY.bookkeeper_name, 0),
)

PURCHASE_ID = "pur_baymix_oak"
PO_NUMBER = "MF-PO-1031"
QUOTE_NUMBER = "BMQ-4417"
INVOICE_ID = "inv_bm23104"
INVOICE_NUMBER = "BM-23104"
REV1_ID = "rev_bm23104_r1"
REV2_ID = "rev_bm23104_r2"
WEEKEND_CR_ID = "cr_baymix_weekend_oct10"
WAITING_CR_ID = "cr_baymix_waiting"

DEPOSIT = Deposit("dep_baymix_oak_1", PURCHASE_ID, BAYMIX.id, 10_000_00, "settled", "mock_nessie_dep_1003", "2026-10-03")

MF = "jordan.pike@marlowfinch.example"
_HEAD = "Ready-mix concrete - 2200 Quarry Road, Newark, CA 94560 - (510) 555-0191"
_TABLE_HEAD = "= Line  Description                                   Qty      Unit  Unit price    Amount"

QUOTE = SourceDoc("doc_bm_quote", "quote", "BayMix_Quote_BMQ-4417.pdf", (
    (
        "# BayMix Supply",
        _HEAD,
        "## QUOTATION BMQ-4417",
        "Quote date: 2026-09-29",
        "Customer: Marlow & Finch Builders, attn. Jordan Pike (Purchasing)",
        f"Project: {PROJECT.name}, {PROJECT.address}",
        "",
        "Product: Ready-mix concrete, 4,000 psi, 3/4 in. aggregate, mix BM-40-34",
        "Maximum quantity: 500 cubic yards (cy), delivered to the project",
        "Unit price: $165.00 per cubic yard, delivered",
        "Price validity: fixed for deliveries from 2026-10-01 through 2026-10-31",
        "Extended maximum: 500 cy x $165.00 = $82,500.00",
        "Deposit: $10,000.00 due before the first pour, applied once against invoices under this quote",
        "Payment terms: Net 30 days from invoice date",
        "Not included: weekend or after-hours delivery, truck waiting time (see Term 2), fuel surcharge (Term 3)",
        "",
        "This quote incorporates the BayMix Supply Terms and Conditions of Sale on page 2.",
        "",
        "Accepted for Marlow & Finch Builders: Jordan Pike, Purchasing    Date: 2026-10-01",
        "Issued for BayMix Supply: Rosa Delgado, Sales Manager",
    ),
    (
        "## TERMS AND CONDITIONS OF SALE (part of Quote BMQ-4417)",
        "",
        "1. Price changes. Quoted prices are fixed for the validity period. Any price change requires",
        "mutual written agreement of buyer and seller before the affected deliveries.",
        "",
        "2. Additional charges. Charges not listed in this quote, including weekend or after-hours delivery",
        "and truck waiting time, apply only when both parties agree to them in writing before the work.",
        "",
        "3. Fuel surcharge. For deliveries in a week when the weekly California on-highway diesel price",
        "index published by the U.S. Energy Information Administration is above $5.25 per gallon, seller",
        "may add $0.40 per cubic yard for each full $0.10 per gallon above $5.25. The index for the week",
        "of delivery applies. No surcharge applies at or below $5.25 per gallon.",
        "",
        "4. Quantity. Deliveries above the maximum quantity require a written change.",
        "",
        "5. Deposit. A deposit is applied once, only against invoices under this quote.",
        "",
        "6. Payment instructions. Seller will not change its payment instructions by email alone. Buyer",
        "will confirm any change by calling seller at the phone number on this quote.",
    ),
))

PO = SourceDoc("doc_mf_po_1031", "po", "MarlowFinch_PO_MF-PO-1031.pdf", (
    (
        "# Marlow & Finch Builders",
        "General contractor - Fremont, CA - purchasing@marlowfinch.example",
        "## PURCHASE ORDER MF-PO-1031",
        "PO date: 2026-10-01",
        "Supplier: BayMix Supply, 2200 Quarry Road, Newark, CA 94560",
        f"Project: {PROJECT.name}, {PROJECT.address}",
        "",
        _TABLE_HEAD,
        "= 1     Ready-mix concrete 4,000 psi, mix BM-40-34    500.000  cy    $165.00       $82,500.00",
        "",
        "PO total, not to exceed: $82,500.00",
        "Terms: BayMix Quote BMQ-4417 and its Terms and Conditions of Sale. Deposit $10,000.00 per the quote.",
        "Price fixed for deliveries through 2026-10-31. Any change needs written agreement and approval",
        "by Marlow & Finch purchasing.",
        "Issued by: Jordan Pike, Purchasing, Marlow & Finch Builders",
        "",
        "## SUPPLIER ACKNOWLEDGMENT",
        "BayMix Supply acknowledges and accepts purchase order MF-PO-1031 on the terms of Quote BMQ-4417.",
        "Acknowledged by: Rosa Delgado, Sales Manager, BayMix Supply    Date: 2026-10-01",
    ),
))


def _email(doc_id: str, meta: EmailMeta, body: tuple[str, ...]) -> SourceDoc:
    return SourceDoc(doc_id, "email", f"{meta.message_id}.eml", (body,), meta)


WEEKEND_SUBJECT = "Saturday Oct 10 pour - weekend delivery charge"
WEEKEND_1 = _email("doc_em_weekend_1", EmailMeta(
    "em_weekend_1", "thr_weekend", "rosa.delgado@baymix-supply.example", MF, WEEKEND_SUBJECT,
    "2026-10-08T09:12:00-07:00", "2026-10-08T09:20:00-07:00"), (
    "Hi Jordan,",
    "",
    "Granite Line asked us to deliver the Oakview foundation pour on Saturday, October 10.",
    "Weekend delivery is not included in Quote BMQ-4417. We can do it for a flat weekend",
    "delivery charge of $1,200.00 for that pour.",
    "",
    "Please confirm in writing if you want us to go ahead.",
    "",
    "Rosa Delgado",
    "Sales Manager, BayMix Supply",
))
WEEKEND_2 = _email("doc_em_weekend_2", EmailMeta(
    "em_weekend_2", "thr_weekend", MF, "rosa.delgado@baymix-supply.example", f"Re: {WEEKEND_SUBJECT}",
    "2026-10-08T14:40:00-07:00", "2026-10-08T14:45:00-07:00"), (
    "Hi Rosa,",
    "",
    "Yes, please go ahead with the Saturday, October 10 pour at the flat $1,200.00 weekend charge.",
    "I've approved it on our side.",
    "",
    "Jordan Pike",
    "Purchasing, Marlow & Finch Builders",
))
WEEKEND_3 = _email("doc_em_weekend_3", EmailMeta(
    "em_weekend_3", "thr_weekend", "rosa.delgado@baymix-supply.example", MF, f"Re: {WEEKEND_SUBJECT}",
    "2026-10-08T15:05:00-07:00", "2026-10-08T15:10:00-07:00"), (
    "Jordan,",
    "",
    "Confirmed: flat weekend delivery charge of $1,200.00 for the Saturday, October 10 pour.",
    "First truck on site at 7:00 AM.",
    "",
    "Rosa",
))
WAITING_1 = _email("doc_em_waiting_1", EmailMeta(
    "em_waiting_1", "thr_waiting", "dispatch@baymix-supply.example", MF, "Oakview pours - site access",
    "2026-10-14T07:31:00-07:00", "2026-10-14T07:40:00-07:00"), (
    "Jordan,",
    "",
    "Heads up for the remaining Oakview pours: trucks were held at the gate on Monday while the",
    "pump was set up. Waiting charges may apply if trucks are held on site.",
    "",
    "BayMix Dispatch",
))

MF_AP = "ap@marlowfinch.example"
CLARIFICATION_SUBJECT = "Invoice BM-23104: 2 lines don't match what we agreed"  # what clarify.py drafts for revision 1
REPLY_1 = _email("doc_em_reply_1", EmailMeta(
    "em_reply_1", "thr_bm23104", "ar@baymix-supply.example", MF_AP, f"Re: {CLARIFICATION_SUBJECT}",
    "2026-10-24T09:05:00-07:00", "2026-10-24T09:10:00-07:00"), (
    "Hello,",
    "",
    "You're right: Quote BMQ-4417 fixes $165.00 per cubic yard through October 31. We've corrected",
    "the concrete to $165.00 per cubic yard and removed the truck waiting time charge.",
    "",
    "Corrected invoice BM-23104 (revision 2) is attached and replaces the October 23 invoice.",
    "",
    "BayMix Accounts Receivable",
))

_INVOICE_HEAD = (
    "# BayMix Supply",
    "Ready-mix concrete - 2200 Quarry Road, Newark, CA 94560 - ar@baymix-supply.example",
)
_INVOICE_PARTIES = (
    "Due date: 2026-11-22 (Net 30)",
    "Bill to: Marlow & Finch Builders, Accounts Payable",
    f"Project: {PROJECT.name}",
    "Your PO: MF-PO-1031    Quote: BMQ-4417",
    "",
    _TABLE_HEAD,
)
_INVOICE_FOOT = (
    "",
    "Deliveries: 2026-10-05 through 2026-10-22, Oakview Lane Fourplex.",
    "Remit to: BayMix Supply, Quarry Point Bank, account ending 2290",
    "Questions about this invoice: ar@baymix-supply.example, (510) 555-0192",
)

INVOICE_R1 = SourceDoc("doc_bm_inv_23104_r1", "invoice", "BayMix_Invoice_BM-23104.pdf", (
    _INVOICE_HEAD + (
        "## INVOICE BM-23104",
        "Invoice date: 2026-10-23",
    ) + _INVOICE_PARTIES + (
        "= 1     Ready-mix concrete 4,000 psi, mix BM-40-34    500.000  cy    $172.00       $86,000.00",
        "= 2     Weekend delivery, Saturday Oct 10 pour        1.000    ea    $1,200.00     $1,200.00",
        "= 3     Truck waiting time                            90.000   min   $2.50         $225.00",
        "",
        "Gross amount: $87,425.00",
        "Less deposit received: $10,000.00",
        "Balance due: $77,425.00",
    ) + _INVOICE_FOOT,
))

INVOICE_R2 = SourceDoc("doc_bm_inv_23104_r2", "invoice", "BayMix_Invoice_BM-23104_rev2.pdf", (
    _INVOICE_HEAD + (
        "## CORRECTED INVOICE BM-23104 (REVISION 2)",
        "This corrected invoice supersedes invoice BM-23104 dated 2026-10-23.",
        "Invoice date: 2026-10-23    Revision date: 2026-10-24",
    ) + _INVOICE_PARTIES + (
        "= 1     Ready-mix concrete 4,000 psi, mix BM-40-34    500.000  cy    $165.00       $82,500.00",
        "= 2     Weekend delivery, Saturday Oct 10 pour        1.000    ea    $1,200.00     $1,200.00",
        "",
        "Gross amount: $83,700.00",
        "Less deposit received: $10,000.00",
        "Balance due: $73,700.00",
        "Changes from revision 1: unit price corrected to $165.00 per Quote BMQ-4417; waiting time removed.",
    ) + _INVOICE_FOOT,
))

PRIMARY_DOCS: tuple[SourceDoc, ...] = (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1, INVOICE_R1, REPLY_1, INVOICE_R2)
DOCS_BY_ID = {d.id: d for d in PRIMARY_DOCS}
