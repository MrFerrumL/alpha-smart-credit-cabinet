import base64
import hashlib
import hmac
import json
import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import jwt

from app.config import get_settings

_ALGORITHM = "HS256"
_PBKDF2_ITERATIONS = 200_000
# Хеш, с которым не совпадёт ни один пароль; проверка по нему длится столько же, сколько настоящая.
DUMMY_PASSWORD_HASH = "pbkdf2_sha256${}${}${}".format(
    _PBKDF2_ITERATIONS, base64.b64encode(bytes(16)).decode(), base64.b64encode(bytes(32)).decode()
)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        _PBKDF2_ITERATIONS, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
    except ValueError:
        return False
    if scheme != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iterations))
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def create_token(user_id: int, role: str) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.token_ttl_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(
        token, get_settings().secret_key, algorithms=[_ALGORITHM], options={"require": ["exp", "sub"]}
    )


def _keyed_hash(label: bytes, value: str) -> str:
    # SECRET_KEY подписывает и токены, а почту присылает сам клиент. Поэтому хеш считается не самим ключом, а ключом,
    # выведенным из него под своё назначение: подпись токена и отпечаток не выдают друг друга.
    key = hmac.new(get_settings().secret_key.encode(), label, hashlib.sha256).digest()
    return hmac.new(key, value.encode(), hashlib.sha256).hexdigest()


def fingerprint(value: str) -> str:
    """Короткий отпечаток почты для логов: без секретного ключа его не подобрать перебором по словарю почт. Ключ вне
    локального запуска случайный, поэтому после перезапуска backend отпечатки меняются."""
    return _keyed_hash(b"potok/log-fingerprint", value)[:12]


def throttle_key(*parts: str) -> str:
    """Ключ записи в счётчике неудачных входов (например, почта и адрес клиента): полный хеш, не обрезанный, чтобы
    чужие записи не совпадали, и с отдельной меткой, не пересекающейся с отпечатком из логов."""
    return _keyed_hash(b"potok/login-throttle", json.dumps(parts))  # JSON: границы частей не смешиваются


@dataclass(slots=True)
class _Failures:
    times: list[float] = field(default_factory=list)
    locked_until: float = 0.0
    in_flight: int = 0  # попытки, у которых пароль проверяется прямо сейчас


class LoginThrottle:
    """Счётчик неудачных входов по ключу (почта и адрес клиента, в том числе для неизвестной почты, либо только адрес):
    max_failures неудач за window_s секунд закрывают вход для этого ключа на window_s секунд. Удачный вход сбрасывает
    счёт, если reset_on_success (для счётчика по адресу он выключен: удачные входы не гасят перебор почт).

    Попытка проходит через begin() и finish(): begin() проверяет и занимает место одним действием под замком, поэтому
    параллельные запросы не проскочат лишнюю попытку, пока предыдущие ещё проверяют пароль.

    Живёт в памяти одного процесса: у каждого процесса backend свой счётчик. Число ключей ограничено max_keys. Когда
    место кончилось, убираются остывшие ключи, затем самый давний, который не закрыт и не проверяется, затем самый
    давний вообще: новый ключ принимается всегда, иначе заполнение таблицы закрыло бы вход всем. Это терпимо для
    прототипа: nginx пускает с адреса не больше 30 входов в минуту, а счётчик по адресу закрывает его после 50 неудач,
    так что заполнить 10 000 записей можно лишь с сотен адресов за 5 минут. Общее хранилище (Redis) — ответ для
    продакшена, здесь за рамками. Потокобезопасен: эндпоинты входа синхронные и выполняются в пуле потоков."""

    def __init__(
        self,
        max_failures: int,
        window_s: float,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
        reset_on_success: bool = True,
    ) -> None:
        self.max_failures = max_failures
        self.window_s = window_s
        self.max_keys = max_keys
        self.reset_on_success = reset_on_success
        self._clock = clock
        self._entries: dict[str, _Failures] = {}  # порядок вставки = порядок последней неудачи
        self._lock = threading.Lock()

    def begin(self, key: str) -> float:
        """Начало попытки. 0 — пароль можно проверять, занятое место нужно вернуть через finish(). Больше нуля — вход
        закрыт, столько секунд ждать (место не занято)."""
        if self.max_failures <= 0:
            return 0.0
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self._make_room(now)
                entry = self._entries[key] = _Failures()
            elif entry.locked_until > now:
                return entry.locked_until - now
            recent = sum(1 for t in entry.times if now - t < self.window_s)
            if recent + entry.in_flight >= self.max_failures:
                return self.window_s  # неудач и проверок в пути уже на весь лимит: следующая могла бы стать лишней
            entry.in_flight += 1
            return 0.0

    def finish(self, key: str, ok: bool | None) -> None:
        """Конец попытки, начатой begin(): True — пароль верный (счёт сбрасывается, если reset_on_success), False —
        неверный (неудача запоминается), None — вердикта нет, например сбой БД: место освобождается, неудачей это не
        считается."""
        if self.max_failures <= 0:
            return
        now = self._clock()
        with self._lock:
            entry = self._entries.pop(key, None)  # ниже вставляется заново, в конец
            if entry is None:
                return
            entry.in_flight = max(0, entry.in_flight - 1)
            if ok is True and self.reset_on_success:
                entry.times.clear()  # блокировку, уже наложенную параллельными неудачами, успех не снимает
            elif ok is False:
                entry.times = [t for t in entry.times if now - t < self.window_s]
                entry.times.append(now)
                if len(entry.times) >= self.max_failures:
                    entry.locked_until = now + self.window_s
                    entry.times.clear()
            if entry.in_flight or entry.times or entry.locked_until > now:
                self._entries[key] = entry

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def _make_room(self, now: float) -> None:
        """Освобождает место под новый ключ; новый ключ принимается всегда."""
        if len(self._entries) < self.max_keys:
            return
        for k in [k for k, e in self._entries.items() if self._is_idle(e, now)]:
            del self._entries[k]
        if len(self._entries) < self.max_keys:
            return
        # Сначала давний ключ, который не закрыт и не проверяется; если таких нет — просто самый давний.
        oldest_open = next((k for k, e in self._entries.items() if e.locked_until <= now and e.in_flight == 0), None)
        del self._entries[oldest_open if oldest_open is not None else next(iter(self._entries))]

    def _is_idle(self, entry: _Failures, now: float) -> bool:
        """Остыл: не закрыт, не проверяется и за окно у него нет неудач."""
        return (
            entry.locked_until <= now
            and entry.in_flight == 0
            and (not entry.times or now - entry.times[-1] >= self.window_s)
        )


login_throttle = LoginThrottle(get_settings().login_max_failures, get_settings().login_failure_window_s)
# Грубее: неудачи с одного адреса по любым почтам. Ловит перебор многих почт с одного места (password spraying).
ip_throttle = LoginThrottle(
    get_settings().login_ip_max_failures, get_settings().login_failure_window_s, reset_on_success=False
)
