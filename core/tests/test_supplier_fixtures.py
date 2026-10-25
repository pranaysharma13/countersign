from email import message_from_bytes, policy

import pytest

from countersign.ids import sha256_hex
from countersign.money import extend, extend_up, fmt_qty, milli
from countersign.pdfs import pdf_text
from countersign.supplier_docs import email_body, fragments, normalize_ws, render_eml, render_pdf, text_matches
from countersign.supplier_world import PRIMARY_DOCS, QUOTE


def test_quantities_are_integer_thousandths():
    assert milli("500") == 500_000
    assert milli("1,250.5") == 1_250_500
    assert milli("0.125") == 125
    assert milli(90) == 90_000
    with pytest.raises(ValueError):
        milli("1.0001")
    assert extend(500_000, 16_500) == 8_250_000
    assert extend(90_000, 250) == 22_500
    assert extend(1_333, 16_500) is None  # not exact: the module would reject this line
    assert extend_up(1_333, 16_500) == 21_995
    assert fmt_qty(500_000, "cy") == "500 cy" and fmt_qty(1_250_500) == "1,250.5"


def test_fragment_ids_are_unique_and_whitespace_normalized_matching_is_strict():
    ids = [f.id for d in PRIMARY_DOCS for f in fragments(d)]
    assert len(ids) == len(set(ids))
    assert text_matches("Unit price:   $165.00 per cubic\nyard, delivered", "Unit price: $165.00 per cubic yard, delivered")
    assert not text_matches("Unit price: $172.00 per cubic yard, delivered", "Unit price: $165.00 per cubic yard, delivered")


@pytest.mark.parametrize("doc", [d for d in PRIMARY_DOCS if not d.email], ids=lambda d: d.id)
def test_every_pdf_fragment_is_in_the_text_layer_of_its_page(doc, tmp_path):
    path = render_pdf(doc, tmp_path / doc.filename)
    from pypdf import PdfReader

    pages = [{normalize_ws(ln) for ln in (p.extract_text() or "").splitlines()} for p in PdfReader(str(path)).pages]
    assert len(pages) == len(doc.pages)
    for f in fragments(doc):
        assert normalize_ws(f.text) in pages[f.page - 1], (f.id, f.text)


@pytest.mark.parametrize("doc", [d for d in PRIMARY_DOCS if d.email], ids=lambda d: d.id)
def test_every_email_fragment_is_in_the_parsed_eml(doc):
    msg = message_from_bytes(render_eml(doc), policy=policy.default)
    body = msg.get_body(preferencelist=("plain",)).get_content()
    assert msg["From"] == doc.email.from_address and msg["Subject"] == doc.email.subject
    lines = {normalize_ws(ln) for ln in body.splitlines()}
    for f in fragments(doc):
        if f.id.endswith("_body"):
            assert text_matches(body, f.text) and f.text == email_body(doc)
        else:
            assert f.page == 0 and f.email_message_id == doc.email.message_id
            assert normalize_ws(f.text) in lines, f.id


def test_pdfs_are_reproducible(tmp_path):
    a = render_pdf(QUOTE, tmp_path / "a.pdf").read_bytes()
    b = render_pdf(QUOTE, tmp_path / "b.pdf").read_bytes()
    assert sha256_hex(a) == sha256_hex(b)
    assert "mutual written agreement" in pdf_text(tmp_path / "a.pdf")
    assert "diesel price" in pdf_text(tmp_path / "a.pdf")
