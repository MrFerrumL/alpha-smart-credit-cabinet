"""Полномочия представителя компании по данным ЕГРЮЛ/ЕГРИП.

Без доверенности действовать от имени компании и подписывать договор может только руководитель
(единоличный исполнительный орган), у ИП — сам предприниматель. Учредитель может подключить компанию к
кабинету и готовить заявки, но подписать договор не может.

В прототипе личность сверяется по ФИО из профиля. В промышленной версии — по ИНН физического лица из
сертификата электронной подписи, который сравнивается с ИНН руководителя в ЕГРЮЛ.
"""

from dataclasses import dataclass


def _tokens(name: str | None) -> set[str]:
    return {part for part in (name or "").lower().replace("ё", "е").split() if part}


def same_person(profile_name: str, registry_name: str | None) -> bool:
    """ФИО из профиля («Имя Фамилия») совпадает с ФИО в реестре («Фамилия Имя Отчество»): все слова профиля
    есть в реестре, и среди них обязательно фамилия."""
    mine = _tokens(profile_name)
    registry = (registry_name or "").lower().replace("ё", "е").split()
    if len(mine) < 2 or not registry:
        return False
    return registry[0] in mine and mine <= set(registry)


@dataclass(frozen=True)
class Authority:
    is_head: bool
    is_founder: bool

    @property
    def may_connect(self) -> bool:
        return self.is_head or self.is_founder

    @property
    def can_sign(self) -> bool:
        return self.is_head


def authority_of(profile_name: str, egrul: dict) -> Authority:
    director = (egrul.get("director") or {}).get("name")
    founders = [f.get("name") for f in egrul.get("founders") or []]
    return Authority(
        is_head=same_person(profile_name, director),
        is_founder=any(same_person(profile_name, name) for name in founders),
    )


def may_sign(full_name: str, can_sign: bool, registry_director: str | None) -> bool:
    """Право подписи из профиля действует, только пока человек — руководитель по данным ЕГРЮЛ."""
    return can_sign and (not registry_director or same_person(full_name, registry_director))
