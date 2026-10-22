from fastapi import APIRouter, Query

from app.domain.products import CATALOGUE, PRODUCTS, Product, match_products, monthly_payment, schedule
from app.errors import BusinessValidationError, NotFound
from app.schemas import CalcOut, MatchIn, MatchOut, ProductOut, ScheduleRowOut

router = APIRouter(prefix="/products", tags=["Продукты"])


def product_out(p: Product) -> ProductOut:
    return ProductOut(
        code=p.code,
        name=p.name,
        tagline=p.tagline,
        min_amount=p.min_amount,
        max_amount=p.max_amount,
        min_term=p.min_term,
        max_term=p.max_term,
        rate=float(p.rate),
        purposes=list(p.purposes),
        repayment=p.repayment,
        collateral=p.collateral,
        decision=p.decision,
        decision_time=p.decision_time,
        documents=list(p.documents),
        highlights=list(p.highlights),
    )


@router.get("", response_model=list[ProductOut], summary="Каталог кредитных продуктов")
def list_products() -> list[ProductOut]:
    return [product_out(p) for p in CATALOGUE]


@router.post("/match", response_model=list[MatchOut], summary="Подбор продукта под цель, сумму и срок")
def match(data: MatchIn) -> list[MatchOut]:
    return [
        MatchOut(
            product=product_out(m.product),
            fit=m.fit,
            amount=m.amount,
            term_months=m.term_months,
            monthly_payment=int(m.monthly_payment),
            overpayment=int(m.overpayment),
            reasons=m.reasons,
            caveats=m.caveats,
        )
        for m in match_products(data.purpose, data.amount, data.term_months)
    ]


@router.get("/{code}/calculate", response_model=CalcOut, summary="Платёж и график погашения")
def calculate(
    code: str,
    amount: int = Query(gt=0, le=1_000_000_000),
    term_months: int = Query(ge=1, le=120),
) -> CalcOut:
    product = PRODUCTS.get(code)
    if product is None:
        raise NotFound("Продукт не найден")
    if not product.min_term <= term_months <= product.max_term:
        raise BusinessValidationError(
            errors=[{"field": "term_months", "message": f"Срок — от {product.min_term} до {product.max_term} мес."}]
        )
    rows = schedule(amount, product.rate, term_months, product.repayment)
    total = sum(r.payment for r in rows)
    return CalcOut(
        product_code=code,
        amount=amount,
        term_months=term_months,
        rate=float(product.rate),
        monthly_payment=int(monthly_payment(amount, product.rate, term_months, product.repayment)),
        overpayment=int(total - amount),
        total=int(total),
        schedule=[
            ScheduleRowOut(n=r.n, payment=int(r.payment), principal=int(r.principal), interest=int(r.interest), balance=int(r.balance))
            for r in rows
        ],
    )
