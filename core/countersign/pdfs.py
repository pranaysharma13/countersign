"""Render bills (pay applications + lien waiver page) as realistic PDFs.

A sidecar JSON with the printed fields is written next to each PDF; the mock
extractor reads it (USE_MOCKS=true). The real extractor (Claude) reads the PDF.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

from .money import fmt
from .world import BillDoc, Company, Project

W, H = letter


def _money_right(c: canvas.Canvas, x: float, y: float, cents: int, bold: bool = False) -> None:
    c.setFont("Helvetica-Bold" if bold else "Helvetica", 9)
    c.drawRightString(x, y, fmt(cents))


def render_bill(doc: BillDoc, company: Company, project: Project | None, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=letter)
    c.setTitle(f"{doc.vendor_name} {doc.invoice_number}")

    # Header
    c.setFont("Helvetica-Bold", 15)
    c.drawString(0.75 * inch, H - 0.85 * inch, doc.vendor_name)
    c.setFont("Helvetica", 9)
    c.drawString(0.75 * inch, H - 1.05 * inch, f"CA Contractor License #{doc.vendor_license}" if doc.vendor_license else "")
    c.drawString(0.75 * inch, H - 1.2 * inch, doc.from_address)
    c.setFont("Helvetica-Bold", 13)
    c.drawRightString(W - 0.75 * inch, H - 0.85 * inch, "APPLICATION FOR PAYMENT")
    c.setFont("Helvetica", 9)
    for i, (k, v) in enumerate([("Invoice #", doc.invoice_number), ("Date", doc.bill_date), ("Due", doc.due_date),
                                ("Period", doc.period_label)]):
        c.drawRightString(W - 0.75 * inch, H - (1.05 + 0.15 * i) * inch, f"{k}: {v}")

    # Parties
    y = H - 1.85 * inch
    c.setFont("Helvetica-Bold", 9)
    c.drawString(0.75 * inch, y, "TO (Contractor)")
    c.drawString(4.0 * inch, y, "PROJECT")
    c.setFont("Helvetica", 9)
    c.drawString(0.75 * inch, y - 13, company.name)
    c.drawString(0.75 * inch, y - 26, f"Attn: {company.owner_name}")
    if project:
        c.drawString(4.0 * inch, y - 13, project.name)
        c.drawString(4.0 * inch, y - 26, project.address)
    c.drawString(4.0 * inch, y - 39, f"Subcontract: {doc.contract_id or 'n/a'}")

    # Schedule of values table
    y = H - 2.7 * inch
    cols = [0.75, 1.45, 4.35, 5.45, 6.45, 7.75]
    headers = ["Code", "Description", "Previous", "This period", "% complete"]
    c.setFillColor(colors.HexColor("#EEF1F4"))
    c.rect(0.7 * inch, y - 4, W - 1.4 * inch, 16, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(cols[0] * inch, y, headers[0])
    c.drawString(cols[1] * inch, y, headers[1])
    c.drawRightString(cols[3] * inch, y, headers[2])
    c.drawRightString(cols[4] * inch, y, headers[3])
    c.drawRightString(cols[5] * inch, y, headers[4])
    c.setFont("Helvetica", 9)
    for line in doc.lines:
        y -= 16
        c.drawString(cols[0] * inch, y, line.code)
        c.drawString(cols[1] * inch, y, line.description[:48])
        _money_right(c, cols[3] * inch, y, line.previous_cents)
        _money_right(c, cols[4] * inch, y, line.this_period_cents)
        c.drawRightString(cols[5] * inch, y, f"{line.percent_complete_bps / 100:.1f}%")

    # Totals
    y -= 30
    c.line(4.3 * inch, y + 12, W - 0.75 * inch, y + 12)
    for label, cents_value, bold in [("Total this period", doc.amount_cents, True),
                                     ("Less retainage", -doc.retainage_cents, False),
                                     ("AMOUNT DUE", doc.amount_cents - doc.retainage_cents, True)]:
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 9)
        c.drawString(4.35 * inch, y, label)
        _money_right(c, W - 0.75 * inch, y, cents_value, bold)
        y -= 15

    # Remit-to
    y -= 15
    c.setFont("Helvetica-Bold", 9)
    c.drawString(0.75 * inch, y, "REMIT PAYMENT TO")
    c.setFont("Helvetica", 9)
    c.drawString(0.75 * inch, y - 13, f"Bank: {doc.remit_bank_name}")
    c.drawString(0.75 * inch, y - 26, f"Routing: {doc.remit_routing}    Account: ****{doc.remit_account_last4}")
    c.drawString(0.75 * inch, y - 39, f"Account name: {doc.vendor_name}")

    c.setFont("Helvetica-Oblique", 8)
    c.drawString(0.75 * inch, 1.0 * inch, "Subcontractor certifies the work covered by this application has been completed in accordance with the subcontract.")
    c.setFont("Helvetica", 9)
    c.drawString(0.75 * inch, 0.8 * inch, f"Signed: ______________________   for {doc.vendor_name}")

    if doc.hidden_text:
        # Invisible to a person reading the page; present in the text layer.
        c.setFillColor(colors.white)
        c.setFont("Helvetica", 4)
        c.drawString(0.75 * inch, 0.55 * inch, doc.hidden_text)
        c.setFillColor(colors.black)
    c.showPage()

    if doc.has_lien_waiver:
        c.setFont("Helvetica-Bold", 12)
        c.drawString(0.75 * inch, H - 0.9 * inch, "CONDITIONAL WAIVER AND RELEASE ON PROGRESS PAYMENT")
        c.setFont("Helvetica", 9)
        text = c.beginText(0.75 * inch, H - 1.3 * inch)
        text.setLeading(13)
        for ln in [
            f"Name of Claimant: {doc.vendor_name}",
            f"Name of Customer: {company.name}",
            f"Job Location: {project.address if project else ''}",
            f"Through Date: {doc.bill_date}",
            "",
            "This document waives and releases lien, stop payment notice, and payment bond rights the claimant has",
            "for labor and service provided, and equipment and material delivered, to the customer on this job",
            "through the Through Date, upon receipt of payment of the amount below.",
            "",
            f"Maker of Check: {company.name}",
            f"Amount of Check: {fmt(doc.amount_cents - doc.retainage_cents)}",
            "",
            f"Claimant's Signature: ______________________     Date: {doc.bill_date}",
        ]:
            text.textLine(ln)
        c.drawText(text)
        c.showPage()
    c.save()

    sidecar = path.with_suffix(".json")
    sidecar.write_text(json.dumps({"printed": asdict(doc)}, indent=1))
    return path


def pdf_text(path: Path) -> str:
    """The PDF's full text layer, including text a person can't see."""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    return "\n".join(page.extract_text() or "" for page in reader.pages)
