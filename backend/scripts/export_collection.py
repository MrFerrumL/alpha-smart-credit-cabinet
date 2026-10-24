"""Выгрузка коллекции запросов Postman v2.1 в docs/postman_collection.json.

Коллекция строится из живой спецификации ``app.openapi()``, поэтому не расходится с кодом.
Импортируется в Postman, Insomnia и Bruno.

    python -m scripts.export_collection          # перезаписать файл
    python -m scripts.export_collection --check  # проверить, что файл совпадает с кодом (для CI)
"""

import json
import sys
from pathlib import Path
from typing import Any

from app.main import app

TARGET = Path(__file__).resolve().parents[2] / "docs" / "postman_collection.json"

SCHEMA_URL = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
BASE = "{{base_url}}"

# Переменные коллекции: имя -> значение по умолчанию.
VARIABLES: dict[str, str] = {
    "base_url": "http://localhost:8080",
    "token": "",
    "application_id": "",
    "challenge_id": "",
    "signing_code": "",
    "loan_id": "",
    "task_id": "",
}
# Прочие параметры пути, которых нет в списке выше: имя -> значение (объявляются как переменные).
EXTRA_PATH_VARIABLES: dict[str, str] = {"code": "express"}

# Примеры значений по имени поля или параметра (приоритет ниже, чем у example в схеме).
NAME_EXAMPLES: dict[str, Any] = {
    "email": "bakery@demo.local",
    "password": "demo1234",
    "inn": "0077010019",
    "product_code": "express",
    "amount": 3000000,
    "term_months": 12,
    "status": "approved",
    "monthly_revenue": 4000000,
    "monthly_expenses": 2500000,
    "debt_payments": 150000,
    "employees": 25,
    "consent_bki": True,
    "contact_name": "Ольга Северова",
    "contact_position": "Генеральный директор",
    "comment": "Комментарий к заявке",
    "answer": "Выписка по расчётному счёту за последние 6 месяцев приложена",
    "kind": "bank_statement",
    "challenge_id": "{{challenge_id}}",
    "code": "{{signing_code}}",
}
# Готовые тела для схем, где обобщённый пример неудобен.
BODY_OVERRIDES: dict[str, Any] = {
    "ApplicationUpdate": {"amount": 2500000, "term_months": 18},
    "CompanyLinkIn": {"inn": "0077070071"},
    "CancelIn": {"comment": "Передумали: нужна другая сумма"},
    "PolicySimulationIn": {"max_dsr": 0.45, "min_coverage": 1.3},
    # Исполнимый пример: запрос документа проходит при любом грейде, одобрение ограничено ставкой грейда.
    "AnalystDecisionIn": {
        "outcome": "request_info",
        "comment": "Нужна выписка за 6 месяцев",
        "task_kind": "document",
        "task_title": "Выписка по счёту за 6 месяцев",
    },
}
# Под какой учёткой выполнять запрос, если токена из сквозного сценария (bakery@) для него недостаточно.
LOGIN_HINTS: dict[tuple[str, str], str] = {
    ("post", "/api/companies/link"): "Выполняйте под `new@demo.local` (вход — папка «Вход»): у пекарни компания "
    "уже подключена, и запрос вернёт `409`.",
    ("post", "/api/applications/{application_id}/decision"): "Нужен токен аналитика (`analyst@demo.local`) и "
    "заявка в статусе «Рассматривает специалист», например `vector@demo.local` с инвестиционным кредитом.",
    ("get", "/api/applications/{application_id}/assessment"): "Нужен токен аналитика (`analyst@demo.local`).",
    ("post", "/api/applications/{application_id}/assessment/replay"): "Нужен токен аналитика (`analyst@demo.local`).",
    ("post", "/api/policy/simulate"): "Нужен токен аналитика (`analyst@demo.local`).",
}

# Что делает каждая из ручек сквозного сценария: (метод, путь) должны быть в спецификации.
FLOW_OPERATIONS = [
    ("post", "/api/auth/demo-login"),
    ("post", "/api/applications"),
    ("post", "/api/applications/{application_id}/submit"),
    ("get", "/api/applications/{application_id}"),
    ("post", "/api/applications/{application_id}/offer/accept"),
    ("get", "/api/applications/{application_id}/contract"),
    ("post", "/api/applications/{application_id}/signing/code"),
    ("post", "/api/applications/{application_id}/signing/confirm"),
    ("get", "/api/loans/{loan_id}"),
]

INTRO = """\
Коллекция запросов к API кредитного конвейера «Поток». Построена автоматически из OpenAPI-спецификации \
(`python -m scripts.export_collection`), поэтому совпадает с кодом.

**Как пользоваться**
1. Поднимите стенд (`docker compose up`) и импортируйте файл в Postman, Insomnia или Bruno.
2. Переменная `base_url` по умолчанию указывает на nginx стенда: `http://localhost:8080`. \
Backend напрямую тоже доступен: `http://localhost:8000` — просто поменяйте значение переменной.
3. Откройте папку «Сквозной сценарий: от заявки до выдачи» и запускайте запросы по порядку \
(или целиком через Runner): тестовые скрипты сами сохраняют `token`, `application_id`, `challenge_id`, \
`signing_code` и `loan_id` в переменные коллекции.
4. Остальные папки — по одной на раздел API; в них все запросы, не вошедшие в сквозной сценарий.

**Авторизация.** Bearer-токен берётся из переменной `token` (заполняется запросом `demo-login` или `login`). \
Публичные ручки отправляются без токена.

**Тестовые учётки.** Список возвращает `GET /api/auth/demo-accounts`; пароль всех — `demo1234`. \
Сценарий использует `bakery@demo.local`: заявка «Экспресс-оборот» одобряется автоматически.

**Подпись смоделирована.** Вместо SMS код подтверждения возвращается в ответе `signing/code` (поле `demo_code`).
"""


# --------------------------------------------------------------------------------------
# Примеры значений по схеме


def _resolve(spec: dict, schema: dict) -> tuple[dict, str | None]:
    """Разворачивает $ref и anyOf/oneOf (берём первый не-null вариант). Возвращает схему и имя компонента."""
    name = None
    for _ in range(10):
        if "$ref" in schema:
            name = schema["$ref"].rsplit("/", 1)[-1]
            schema = spec["components"]["schemas"][name]
            continue
        variants = schema.get("anyOf") or schema.get("oneOf")
        if variants:
            non_null = [v for v in variants if v.get("type") != "null"]
            schema = non_null[0] if non_null else variants[0]
            continue
        break
    return schema, name


def example_for(spec: dict, schema: dict, field: str | None = None, depth: int = 0) -> Any:
    schema, comp = _resolve(spec, schema)
    if comp in BODY_OVERRIDES:
        return BODY_OVERRIDES[comp]
    if "example" in schema:
        return schema["example"]
    if field in NAME_EXAMPLES:
        return NAME_EXAMPLES[field]
    if "default" in schema:
        return schema["default"]
    if "enum" in schema:
        return schema["enum"][0]
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        if depth > 5:
            return {}
        return {
            key: example_for(spec, sub, key, depth + 1)
            for key, sub in schema.get("properties", {}).items()
        }
    if kind == "array":
        return [example_for(spec, schema.get("items", {}), field, depth + 1)]
    if kind == "integer":
        if "minimum" in schema:
            return int(schema["minimum"])
        if "exclusiveMinimum" in schema:
            return int(schema["exclusiveMinimum"]) + 1
        return 1
    if kind == "number":
        return schema.get("minimum", 1.0)
    if kind == "boolean":
        return True
    return "string"


# --------------------------------------------------------------------------------------
# Сборка элементов коллекции


def _script(lines: list[str]) -> dict:
    # Блок даёт каждому скрипту свою область видимости: newman выполняет скрипты в общем контексте,
    # и повторное `const data` в следующем запросе иначе было бы ошибкой.
    return {"listen": "test", "script": {"type": "text/javascript", "exec": ["{", *lines, "}"]}}


def _url(path: str, query: list[dict] | None = None) -> dict:
    segments = [s for s in path.split("/") if s]
    raw = BASE + path
    active = [q for q in query or [] if not q.get("disabled")]
    if active:
        raw += "?" + "&".join(f"{q['key']}={q['value']}" for q in active)
    url: dict[str, Any] = {"raw": raw, "host": [BASE], "path": segments}
    if query:
        url["query"] = query
    return url


def _poll(target: str, extra: list[str] | None = None) -> list[str]:
    """Тест шага-опроса: в Runner и newman шаг повторяется раз в секунду, пока статус не станет target."""
    return [
        "const data = pm.response.json();",
        "console.log('Статус заявки:', data.status.code, '-', data.status.title);",
        *(extra or []),
        "const tries = Number(pm.collectionVariables.get('poll_tries') || 0);",
        f"if (data.status.code !== '{target}' && !data.status.terminal && tries < 90) {{",
        "  pm.collectionVariables.set('poll_tries', tries + 1);",
        "  postman.setNextRequest(pm.info.requestName);",
        "  setTimeout(() => {}, 1000);",
        "} else {",
        "  pm.collectionVariables.set('poll_tries', 0);",
        f"  pm.test('Статус {target}', () => pm.expect(data.status.code).to.eql('{target}'));",
        "}",
    ]


def _json_body(text: str) -> dict:
    return {"mode": "raw", "raw": text, "options": {"raw": {"language": "json"}}}


def _item(
    name: str,
    method: str,
    path: str,
    description: str,
    *,
    query: list[dict] | None = None,
    headers: list[dict] | None = None,
    body: dict | None = None,
    public: bool = False,
    test: list[str] | None = None,
) -> dict:
    request: dict[str, Any] = {"method": method.upper(), "header": headers or []}
    if public:
        request["auth"] = {"type": "noauth"}
    if body is not None:
        request["body"] = body
    request["url"] = _url(path, query)
    request["description"] = description
    item: dict[str, Any] = {"name": name, "request": request, "response": []}
    if test:
        item["event"] = [_script(test)]
    return item


def _flow(spec: dict) -> dict:
    for method, path in FLOW_OPERATIONS:
        if method not in spec["paths"].get(path, {}):
            raise SystemExit(f"В спецификации нет {method.upper()} {path}: обновите сквозной сценарий")

    app_path = "/api/applications/{{application_id}}"
    json_h = [{"key": "Content-Type", "value": "application/json", "type": "text"}]
    create_body = {
        "product_code": "express",
        "purpose": "working_capital",
        "amount": 3000000,
        "term_months": 12,
        "form": {"finance": {"monthly_revenue": 4000000}, "consent_bki": True},
    }

    items = [
        _item(
            "1. Вход под тестовой учёткой",
            "post",
            "/api/auth/demo-login",
            "Вход в один клик под учёткой «Северной пекарни». Токен сохраняется в переменную `token`.",
            body=_json_body(json.dumps({"email": "bakery@demo.local"}, ensure_ascii=False, indent=2)),
            public=True,
            test=[
                "pm.test('Вход выполнен', () => pm.response.to.have.status(200));",
                "const data = pm.response.json();",
                "pm.collectionVariables.set('token', data.access_token);",
            ],
        ),
        _item(
            "2. Создать черновик заявки",
            "post",
            "/api/applications",
            "Продукт «Экспресс-оборот», пополнение оборотных средств, 3 000 000 ₽ на 12 месяцев. "
            "Идентификатор заявки сохраняется в `application_id`.",
            body=_json_body(json.dumps(create_body, ensure_ascii=False, indent=2)),
            test=[
                "pm.test('Черновик создан', () => pm.expect(pm.response.code).to.be.oneOf([200, 201]));",
                "const data = pm.response.json();",
                "pm.collectionVariables.set('application_id', data.id);",
            ],
        ),
        _item(
            "3. Отправить заявку в банк",
            "post",
            app_path + "/submit",
            "Запускает конвейер проверок. Заголовок `Idempotency-Key` защищает от двойной отправки: "
            "повтор с тем же ключом вернёт тот же результат.",
            headers=[{"key": "Idempotency-Key", "value": "{{$guid}}", "type": "text"}],
            test=["pm.test('Заявка отправлена', () => pm.response.to.have.status(200));"],
        ),
        _item(
            "4. Статус заявки (повторять до approved)",
            "get",
            app_path,
            "Конвейер работает в фоне, решение появляется примерно через 10 секунд. "
            "В Runner и newman шаг повторяется сам раз в секунду, пока `status.code` не станет `approved`; "
            "вручную — повторяйте запрос.",
            test=_poll("approved"),
        ),
        _item(
            "5. Принять предложение банка",
            "post",
            app_path + "/offer/accept",
            "Доступно после статуса `approved`. Переводит заявку к подписанию договора.",
            test=["pm.test('Предложение принято', () => pm.response.to.have.status(200));"],
        ),
        _item(
            "6. Кредитный договор",
            "get",
            app_path + "/contract",
            "Текст договора с условиями и графиком платежей.",
            test=["pm.test('Договор получен', () => pm.response.to.have.status(200));"],
        ),
        _item(
            "7. Запросить код для подписания",
            "post",
            app_path + "/signing/code",
            "Электронная подпись смоделирована: вместо SMS код возвращается в кабинет (поле `demo_code`). "
            "Идентификатор попытки и код сохраняются в `challenge_id` и `signing_code`.",
            test=[
                "pm.test('Код выдан', () => pm.response.to.have.status(200));",
                "const data = pm.response.json();",
                "pm.collectionVariables.set('challenge_id', data.challenge_id);",
                "pm.collectionVariables.set('signing_code', data.demo_code);",
            ],
        ),
        _item(
            "8. Подписать договор кодом",
            "post",
            app_path + "/signing/confirm",
            "Подтверждение подписи кодом из предыдущего шага. После подписания запускается выдача.",
            body=_json_body('{\n  "challenge_id": {{challenge_id}},\n  "code": "{{signing_code}}"\n}'),
            test=["pm.test('Договор подписан', () => pm.response.to.have.status(200));"],
        ),
        _item(
            "9. Статус заявки (повторять до issued)",
            "get",
            app_path,
            "Выдача занимает несколько секунд. В Runner и newman шаг повторяется сам, пока `status.code` не "
            "станет `issued`; тогда в поле `loan_id` появится идентификатор кредита (сохраняется в `loan_id`).",
            test=_poll("issued", ["if (data.loan_id) { pm.collectionVariables.set('loan_id', data.loan_id); }"]),
        ),
        _item(
            "10. Кредит и график платежей",
            "get",
            "/api/loans/{{loan_id}}",
            "Выданный кредит с графиком погашения.",
            test=["pm.test('Кредит найден', () => pm.response.to.have.status(200));"],
        ),
    ]
    return {
        "name": "Сквозной сценарий: от заявки до выдачи",
        "description": (
            "Последовательный сценарий для запуска по порядку (Runner / «Run collection» или newman). "
            "Шаги 4 и 9 — опрос: в Runner они повторяются сами, пока статус не достигнет нужного значения. "
            "Учётка `bakery@demo.local`, продукт «Экспресс-оборот» одобряется автоматически."
        ),
        "item": items,
    }


def _operation_item(spec: dict, method: str, path: str, op: dict) -> dict:
    hint = LOGIN_HINTS.get((method, path))
    query: list[dict] = []
    headers: list[dict] = []
    for param in op.get("parameters", []):
        if param["in"] == "path":
            path = path.replace("{" + param["name"] + "}", "{{" + param["name"] + "}}")
        elif param["in"] == "query":
            value = example_for(spec, param.get("schema", {}), param["name"])
            entry: dict[str, Any] = {"key": param["name"], "value": str(value)}
            if not param.get("required"):
                entry["disabled"] = True
            query.append(entry)
        elif param["in"] == "header":
            value = "{{$guid}}" if param["name"] == "Idempotency-Key" else str(
                example_for(spec, param.get("schema", {}), param["name"])
            )
            entry = {"key": param["name"], "value": value, "type": "text"}
            if not param.get("required"):
                entry["disabled"] = True
            headers.append(entry)

    body = None
    content = op.get("requestBody", {}).get("content", {})
    if "application/json" in content:
        sample = example_for(spec, content["application/json"]["schema"])
        body = _json_body(json.dumps(sample, ensure_ascii=False, indent=2))
    elif "multipart/form-data" in content:
        schema, _ = _resolve(spec, content["multipart/form-data"]["schema"])
        required = set(schema.get("required", []))
        fields = []
        for key, sub in schema.get("properties", {}).items():
            resolved, _ = _resolve(spec, sub)
            if resolved.get("contentMediaType") or resolved.get("format") == "binary":
                field: dict[str, Any] = {"key": key, "type": "file", "src": []}
            elif key == "task_id":
                field = {"key": key, "value": "{{task_id}}", "type": "text"}
            else:
                field = {"key": key, "value": str(example_for(spec, sub, key)), "type": "text"}
            if key not in required and key not in NAME_EXAMPLES:
                field["disabled"] = True
            fields.append(field)
        body = {"mode": "formdata", "formdata": fields}

    parts = [op.get("summary", "")]
    if op.get("description"):
        parts.append(op["description"])
    if hint:
        parts.append(hint)
    if method == "get" and path.endswith("/stream"):
        parts.append("Поток Server-Sent Events: ответ не завершается, события приходят по мере изменения статуса.")
    if body is not None and body["mode"] == "formdata":
        parts.append("Выберите файл в поле `file` (PDF, изображение или таблица).")
    description = "\n\n".join(p for p in parts if p)

    test = None
    if path == "/api/auth/login":
        test = [
            "pm.test('Вход выполнен', () => pm.response.to.have.status(200));",
            "pm.collectionVariables.set('token', pm.response.json().access_token);",
        ]
    return _item(
        op.get("summary", f"{method.upper()} {path}"),
        method,
        path,
        description,
        query=query or None,
        headers=headers or None,
        body=body,
        public=not op.get("security"),
        test=test,
    )


def build() -> dict:
    spec = app.openapi()
    covered = set(FLOW_OPERATIONS)

    tag_order = [t["name"] for t in spec.get("tags", [])]
    tag_desc = {t["name"]: t.get("description", "") for t in spec.get("tags", [])}
    groups: dict[str, list[dict]] = {name: [] for name in tag_order}
    for path, operations in spec["paths"].items():
        for method, op in operations.items():
            if (method, path) in covered:
                continue
            tag = (op.get("tags") or ["Без раздела"])[0]
            groups.setdefault(tag, []).append(_operation_item(spec, method, path, op))

    folders = [_flow(spec)]
    for name, items in groups.items():
        if items:
            folders.append({"name": name, "description": tag_desc.get(name, ""), "item": items})

    variables = dict(VARIABLES)
    variables.update(EXTRA_PATH_VARIABLES)
    return {
        "info": {
            "name": "Поток — кредитный конвейер",
            "description": INTRO,
            "schema": SCHEMA_URL,
        },
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{token}}", "type": "string"}]},
        "variable": [{"key": key, "value": value, "type": "string"} for key, value in variables.items()],
        "item": folders,
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    collection = render()
    if "--check" in sys.argv:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != collection:
            print(f"{TARGET} устарел: выполните python -m scripts.export_collection", file=sys.stderr)
            return 1
        print("OK: docs/postman_collection.json совпадает с кодом")
        return 0
    TARGET.write_text(collection, encoding="utf-8", newline="\n")
    print(f"Записано: {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
