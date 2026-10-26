"""Защита входа по паролю: пять неудач для одной почты за пять минут закрывают вход на пять минут."""

import threading

from fastapi.testclient import TestClient

from app.main import app
from app.security import LoginThrottle, ip_throttle

CLIENT = "bakery@demo.local"
PASSWORD = "demo1234"
THROTTLED = "Слишком много неудачных попыток входа — подождите 5 минут"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def throttle(max_failures: int = 5, window_s: float = 300, **kwargs) -> tuple[LoginThrottle, Clock]:
    clock = Clock()
    return LoginThrottle(max_failures, window_s, clock=clock, **kwargs), clock


def fail(t: LoginThrottle, key: str, times: int = 1) -> None:
    for _ in range(times):
        assert t.begin(key) == 0
        t.finish(key, False)


def wait(t: LoginThrottle, key: str) -> float:
    """Сколько ещё закрыт вход; если открыт, пробная попытка место не занимает."""
    seconds = t.begin(key)
    if seconds == 0:
        t.finish(key, None)
    return seconds


def login(client, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


# --- счётчик сам по себе -----------------------------------------------------------------------------------------


def test_locks_on_the_last_allowed_failure_and_opens_after_the_window():
    t, clock = throttle()
    fail(t, "a", 4)
    assert wait(t, "a") == 0
    fail(t, "a")
    assert wait(t, "a") == 300
    clock.now += 299
    assert 0 < wait(t, "a") <= 1
    clock.now += 1
    assert wait(t, "a") == 0
    fail(t, "a", 4)  # после окна счёт идёт заново
    assert wait(t, "a") == 0


def test_failures_spread_beyond_the_window_do_not_add_up():
    t, clock = throttle()
    for _ in range(10):
        fail(t, "a")
        clock.now += 100  # в окне 300 с помещается не больше трёх неудач
        assert wait(t, "a") == 0


def test_success_resets_the_count():
    t, _ = throttle()
    fail(t, "a", 4)
    assert t.begin("a") == 0
    t.finish("a", True)
    fail(t, "a", 4)
    assert wait(t, "a") == 0


def test_attempt_without_a_verdict_is_not_a_failure():
    t, _ = throttle(max_failures=2)
    for _ in range(10):  # сбой БД при проверке: место освобождается, неудачей не считается
        assert t.begin("a") == 0
        t.finish("a", None)
    assert wait(t, "a") == 0
    assert t._entries == {}  # и следа в таблице не остаётся


def test_keys_are_counted_separately():
    t, _ = throttle()
    fail(t, "a", 5)
    assert wait(t, "a") > 0 and wait(t, "b") == 0


def test_address_counter_is_not_reset_by_successful_logins():
    t, _ = throttle(max_failures=50, reset_on_success=False)
    fail(t, "ip", 30)
    assert t.begin("ip") == 0
    t.finish("ip", True)  # удачный вход с этого адреса счёт не гасит
    fail(t, "ip", 19)
    assert wait(t, "ip") == 0
    fail(t, "ip")
    assert wait(t, "ip") == 300


def test_default_thresholds_stay_well_above_what_ci_produces():
    from app.config import Settings

    s = Settings()
    assert (s.login_max_failures, s.login_failure_window_s, s.login_ip_max_failures) == (5, 300, 50)


def test_zero_failures_allowed_turns_the_throttle_off():
    t, _ = throttle(max_failures=0)
    for _ in range(50):
        assert t.begin("a") == 0
        t.finish("a", False)
    assert wait(t, "a") == 0


def test_attempts_in_flight_count_towards_the_limit():
    t, _ = throttle()
    for _ in range(5):
        assert t.begin("a") == 0  # пароли ещё проверяются
    assert t.begin("a") == 300  # шестая попытка не проходит, пока пять заняты
    for _ in range(5):
        t.finish("a", False)
    assert wait(t, "a") == 300  # итог пяти неудач — блокировка


def test_a_released_slot_lets_the_next_attempt_in():
    t, _ = throttle(max_failures=2)
    assert t.begin("a") == 0 and t.begin("a") == 0
    assert t.begin("a") > 0
    t.finish("a", None)
    assert t.begin("a") == 0


def test_parallel_attempts_cannot_exceed_the_limit():
    t, _ = throttle()
    threads_count = 24
    start, all_begun = threading.Barrier(threads_count), threading.Barrier(threads_count)
    admitted: list[int] = []

    def attempt() -> None:
        start.wait()
        seconds = t.begin("a")
        all_begun.wait()  # ни одна проверка не кончилась, пока остальные не начались
        if seconds == 0:
            admitted.append(1)
            t.finish("a", False)

    threads = [threading.Thread(target=attempt) for _ in range(threads_count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(admitted) == 5
    assert wait(t, "a") == 300


def test_parallel_failures_are_not_lost():
    t, _ = throttle(max_failures=80)
    barrier = threading.Barrier(8)

    def worker() -> None:
        barrier.wait()
        fail(t, "a", 10)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert wait(t, "a") > 0  # все 80 неудач учтены


def test_table_stays_bounded_cold_entries_go_first_then_the_oldest_open_one():
    t, clock = throttle(max_keys=3)
    fail(t, "cold")
    clock.now += 301  # "cold" остыла: за окно у неё нет неудач
    fail(t, "a")
    fail(t, "b")
    fail(t, "c", 5)  # место нужно: уходит остывшая, а не «a»
    assert set(t._entries) == {"a", "b", "c"}
    fail(t, "d")  # остывших нет — уходит самая давняя незакрытая («a»); закрытая «c» остаётся закрытой
    assert set(t._entries) == {"b", "c", "d"}
    assert wait(t, "c") > 0


def test_a_key_that_fails_again_becomes_the_newest():
    t, _ = throttle(max_keys=2)
    fail(t, "a")
    fail(t, "b")
    fail(t, "a")  # «a» снова самая свежая
    fail(t, "c")
    assert set(t._entries) == {"a", "c"}


def test_flood_of_new_keys_does_not_erase_a_lock():
    t, _ = throttle(max_keys=3)
    fail(t, "victim", 5)  # самая давняя запись, и она закрыта
    fail(t, "x")
    fail(t, "y")
    for i in range(50):
        fail(t, f"random-{i}@example.com")
    assert wait(t, "victim") > 0


def test_full_table_never_refuses_a_new_key():
    t, _ = throttle(max_keys=3)
    for key in ("a", "b", "c"):
        fail(t, key, 5)  # таблица заполнена закрытыми ключами
    assert t.begin("d") == 0  # новый ключ принимается: иначе заполнение таблицы закрыло бы вход всем
    t.finish("d", False)
    assert len(t._entries) == 3 and "d" in t._entries
    assert "a" not in t._entries  # вытеснен самый давний
    assert wait(t, "b") > 0 and wait(t, "c") > 0


def test_when_every_entry_is_locked_or_busy_the_oldest_goes():
    t, _ = throttle(max_keys=2)
    fail(t, "locked", 5)
    assert t.begin("busy") == 0
    assert t.begin("new") == 0  # один закрыт, второй проверяется: вытесняется самый давний, то есть закрытый
    assert set(t._entries) == {"busy", "new"}
    t.finish("busy", False)  # проверка вытесненной записи не ломает счёт и не бросает исключение
    t.finish("new", None)
    t.finish("locked", False)


def test_key_with_an_attempt_in_flight_is_not_evicted():
    t, _ = throttle(max_keys=2)
    assert t.begin("busy") == 0
    fail(t, "x")
    fail(t, "y")  # «busy» самая давняя, но её пароль ещё проверяется
    assert "busy" in t._entries
    t.finish("busy", False)  # неудача не потеряна
    fail(t, "busy", 3)
    assert wait(t, "busy") == 0
    fail(t, "busy")
    assert wait(t, "busy") > 0  # 1 + 3 + 1 = 5 неудач


# --- вход через API ----------------------------------------------------------------------------------------------


def test_sixth_attempt_after_five_wrong_passwords_is_throttled(client):
    for _ in range(5):
        assert login(client, CLIENT, "wrong").status_code == 401
    blocked = login(client, CLIENT, "wrong")
    assert blocked.status_code == 429
    body = blocked.json()
    assert body["code"] == "too_many_requests" and body["status"] == 429
    assert body["detail"] == THROTTLED


def test_right_password_does_not_help_while_locked(client):
    for _ in range(5):
        login(client, CLIENT, "wrong")
    assert login(client, CLIENT, PASSWORD).status_code == 429


def test_unknown_email_is_throttled_like_a_known_one(client):
    for _ in range(5):
        assert login(client, "nobody@demo.local", "x").status_code == 401
    assert login(client, "nobody@demo.local", "x").status_code == 429


def test_a_stranger_cannot_lock_the_owner_out_from_another_address(client):
    def login_from(address: str, password: str):
        return client.post(
            "/api/auth/login", json={"email": CLIENT, "password": password}, headers={"X-Real-IP": address}
        )

    for _ in range(5):
        assert login_from("203.0.113.5", "wrong").status_code == 401
    assert login_from("203.0.113.5", PASSWORD).status_code == 429  # для адреса злоумышленника вход закрыт
    assert login_from("198.51.100.7", PASSWORD).status_code == 200
    assert login(client, CLIENT, PASSWORD).status_code == 200  # без заголовка — свой адрес соединения, он тоже чист


def test_address_is_locked_after_failures_across_many_emails(client, monkeypatch):
    monkeypatch.setattr(ip_throttle, "max_failures", 6)  # настоящий предел — 50, на проверку ушло бы 50 хешей паролей
    for i in range(3):
        assert login(client, f"user{i}@example.com", "x").status_code == 401
    assert login(client, CLIENT, PASSWORD).status_code == 200  # удачный вход счёт по адресу не гасит
    for i in range(3, 6):
        assert login(client, f"user{i}@example.com", "x").status_code == 401
    blocked = login(client, CLIENT, PASSWORD)
    assert blocked.status_code == 429 and blocked.json()["detail"] == THROTTLED
    elsewhere = client.post(
        "/api/auth/login", json={"email": CLIENT, "password": PASSWORD}, headers={"X-Real-IP": "198.51.100.7"}
    )
    assert elsewhere.status_code == 200


def test_attempt_refused_by_the_pair_counter_does_not_count_for_the_address(client, monkeypatch):
    monkeypatch.setattr(ip_throttle, "max_failures", 6)
    for _ in range(5):
        assert login(client, CLIENT, "wrong").status_code == 401
    for _ in range(10):  # отказы по паре «почта + адрес» — не неудачи и не копят счёт адреса
        assert login(client, CLIENT, "wrong").status_code == 429
    assert login(client, "analyst@demo.local", PASSWORD).status_code == 200


def test_without_the_header_the_connection_address_is_counted(client):
    for _ in range(5):
        assert login(client, CLIENT, "wrong").status_code == 401
    assert login(client, CLIENT, PASSWORD).status_code == 429


def test_other_accounts_are_not_affected(client):
    for _ in range(5):
        login(client, CLIENT, "wrong")
    assert login(client, "analyst@demo.local", PASSWORD).status_code == 200


def test_spelling_of_the_email_does_not_dodge_the_counter(client):
    for email in (CLIENT, CLIENT.upper(), f"  {CLIENT} ", CLIENT, CLIENT.title()):
        assert login(client, email, "wrong").status_code == 401
    assert login(client, CLIENT, PASSWORD).status_code == 429


def test_successful_login_resets_the_count(client):
    for _ in range(4):
        login(client, CLIENT, "wrong")
    assert login(client, CLIENT, PASSWORD).status_code == 200
    for _ in range(4):
        assert login(client, CLIENT, "wrong").status_code == 401
    assert login(client, CLIENT, PASSWORD).status_code == 200


def test_error_while_checking_the_password_is_not_a_failed_login(client, monkeypatch):
    def boom(*_):
        raise RuntimeError("boom")

    quiet = TestClient(app, raise_server_exceptions=False)  # сбой отдаёт 500, а не бросается в тест
    with monkeypatch.context() as patched:
        patched.setattr("app.api.auth.verify_password", boom)
        for _ in range(7):  # больше лимита: места под попытки не утекают, неудачами сбои не считаются
            assert login(quiet, CLIENT, PASSWORD).status_code == 500
    assert login(client, CLIENT, PASSWORD).status_code == 200
