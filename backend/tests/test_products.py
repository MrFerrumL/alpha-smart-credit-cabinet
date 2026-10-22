from decimal import Decimal

import pytest

from app.domain.inn import is_valid_inn
from app.domain.products import Purpose, match_products, monthly_payment, schedule


def test_annuity_payment():
    assert monthly_payment(1_000_000, Decimal("12"), 12) == Decimal("88849")


def test_interest_only_payment():
    assert monthly_payment(1_000_000, Decimal("24.9"), 12, "interest_only") == Decimal("20750")


@pytest.mark.parametrize("repayment", ["annuity", "interest_only"])
def test_schedule_repays_whole_amount(repayment):
    rows = schedule(3_000_000, Decimal("22.9"), 12, repayment)
    assert len(rows) == 12
    assert rows[-1].balance == 0
    assert sum(r.principal for r in rows) == 3_000_000


def test_equipment_goes_to_invest_credit():
    best = match_products(Purpose.EQUIPMENT, 5_000_000, 36)[0]
    assert best.product.code == "invest"
    assert best.fit == "best"


def test_cash_gap_goes_to_overdraft():
    assert match_products(Purpose.CASH_GAP, 1_000_000, 12)[0].product.code == "overdraft"


def test_small_expansion_prefers_product_without_minimum_problem():
    matches = match_products(Purpose.EXPANSION, 500_000, 12)
    assert matches[0].product.code == "express"
    invest = next(m for m in matches if m.product.code == "invest")
    assert invest.fit == "partial"
    assert invest.amount == 1_000_000
    assert any("Минимальная сумма" in c for c in invest.caveats)


def test_amount_above_maximum_is_capped_with_explanation():
    match = next(m for m in match_products(Purpose.WORKING_CAPITAL, 15_000_000, 12) if m.product.code == "express")
    assert match.amount == 10_000_000
    assert any("Максимальная сумма — 10 млн ₽" in c for c in match.caveats)


@pytest.mark.parametrize(
    ("inn", "valid"),
    [
        ("0077010019", True),
        ("007703003174", True),
        ("0077010018", False),
        ("007703003175", False),
        ("12345", False),
        ("abcdefghij", False),
    ],
)
def test_inn_checksum(inn, valid):
    assert is_valid_inn(inn) is valid
