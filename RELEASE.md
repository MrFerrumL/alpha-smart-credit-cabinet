> Исторические материалы исходного проекта v1.0.2. Актуальный запуск и ML-доработки описаны в README.md и RUNBOOK.md в корне репозитория.

# Версия на проверку

Проверяется тег `v1.0.2` репозитория https://github.com/donaldtrumpdev-commits/alpha, дедлайн 26.10.2026. Хеш коммита
тега указан в форме сдачи, сверить его можно так:

```bash
git fetch --tags
git rev-parse v1.0.2^{commit}
git checkout v1.0.2
```

Как проверить: `docker compose up --build`, затем `python scripts/smoke.py` и шаги «Проверка за 10 минут» из
[README.md](README.md). Тесты и сценарии в браузере CI прогоняет на каждый push в `main`.

Артефакты: [README.md](README.md), [docs/SUBMISSION.md](docs/SUBMISSION.md) и его PDF, документы в [docs/](docs/),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), видео основного сценария `potok-demo.mp4` в [релизе v1.0.2](https://github.com/donaldtrumpdev-commits/alpha/releases/tag/v1.0.2) и в
артефакте `demo-video` прогона CI на коммите тега.

PDF для формы сдачи с тегом и хешем (Node.js 22, Chromium из Playwright):

```bash
cd e2e
npm ci
npx playwright install chromium
npm run submission-pdf -- --tag v1.0.2 --commit "$(git rev-parse v1.0.2^{commit})" --out ../SUBMISSION-v1.0.2.pdf
```

Доступ: репозиторий приватный, приглашение отправлено аккаунту жюри `alfa-hack-2026`, его нужно принять до 29.10.
