"""Проверка ИНН по контрольным разрядам (10 цифр — организация, 12 — ИП)."""

_W10 = (2, 4, 10, 3, 5, 9, 4, 6, 8)
_W11 = (7, 2, 4, 10, 3, 5, 9, 4, 6, 8)
_W12 = (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8)


def _check_digit(digits: list[int], weights: tuple[int, ...]) -> int:
    return sum(d * w for d, w in zip(digits, weights)) % 11 % 10


def is_valid_inn(value: str) -> bool:
    if not value.isdigit():
        return False
    digits = [int(c) for c in value]
    if len(digits) == 10:
        return _check_digit(digits, _W10) == digits[9]
    if len(digits) == 12:
        return _check_digit(digits, _W11) == digits[10] and _check_digit(digits, _W12) == digits[11]
    return False
