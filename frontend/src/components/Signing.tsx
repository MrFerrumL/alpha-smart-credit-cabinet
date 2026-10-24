import { Anchor, Button, Checkbox, Collapse, Loader, Modal, PinInput, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { useConfirmSigning, useContract, useInterestOnly, useLoan, useRequestSigningCode } from '../api/hooks';
import type { Application, SigningCode } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { NBSP, date, dateTime, money, moneyBig, months, rate } from '../lib/format';
import { nb } from '../lib/nobreak';
import { BarsLegend, PaymentBars } from './PaymentBars';
import { StatusBlock } from './Status';

function useCountdown(until: string | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return left;
}

// Последний код подписи живёт только в этой вкладке (sessionStorage, как и токен): после перезагрузки или
// возврата со страницы договора окно покажет его снова, пока он действует, и не запросит новый. На сервере
// открытого кода нет — только его HMAC.
function savedCode(key: string): SigningCode | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as SigningCode | null;
    return saved && new Date(saved.expires_at).getTime() > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

function saveCode(key: string, challenge: SigningCode | null) {
  try {
    if (challenge) sessionStorage.setItem(key, JSON.stringify(challenge));
    else sessionStorage.removeItem(key);
  } catch {
    /* приватный режим браузера — код живёт до перезагрузки */
  }
}

function CodeModal({ app, opened, onClose }: { app: Application; opened: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const storeKey = `credit.signing.${user?.id ?? 0}.${app.id}`;
  const request = useRequestSigningCode(app.id);
  const confirm = useConfirmSigning(app.id);
  const [challenge, setChallenge] = useState<SigningCode | null>(() => savedCode(storeKey));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(challenge?.expires_at ?? null);

  const send = () => {
    setError(null);
    setCode('');
    request.mutate(undefined, {
      onSuccess: (fresh) => {
        saveCode(storeKey, fresh);
        setChallenge(fresh);
      },
      onError: (e) => setError(e instanceof ApiError ? e.message : 'Не удалось получить код'),
    });
  };

  useEffect(() => {
    const expired = challenge !== null && new Date(challenge.expires_at).getTime() <= Date.now();
    if (opened && (!challenge || expired) && !request.isPending) send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const submit = (value: string) => {
    if (!challenge || value.length < 6) return;
    setError(null);
    confirm.mutate(
      { challenge_id: challenge.challenge_id, code: value },
      {
        onSuccess: () => {
          saveCode(storeKey, null);
          onClose();
        },
        onError: (e) => {
          setCode('');
          // После любой неудачи сохранённый код не показываем: после перезагрузки окно запросит новый.
          saveCode(storeKey, null);
          setError(e instanceof ApiError ? e.message : 'Не удалось подписать договор');
        },
      },
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Подписание договора</Text>} centered radius="lg">
      <Stack align="center" gap="md" ta="center">
        <Text fz="sm" c="dimmed" maw={340}>
          Введите одноразовый код, чтобы подписать договор простой электронной подписью.
        </Text>
        <div className="potok-code-box">
          <Text fz="xs" c="dimmed">
            Демо: электронная подпись смоделирована. В банке код пришёл бы в мобильное приложение — здесь он
            показан прямо в кабинете, SMS и почта не используются.
          </Text>
          <Text fw={700} fz={26} lts={6} mt={4} ff="monospace">
            {challenge?.demo_code ?? '······'}
          </Text>
        </div>
        <PinInput
          length={6}
          type="number"
          oneTimeCode
          size="lg"
          value={code}
          onChange={setCode}
          onComplete={submit}
          error={!!error}
          disabled={!challenge || confirm.isPending}
          autoFocus
        />
        {error && (
          <Text c="red" fz="sm">
            {error}
          </Text>
        )}
        {confirm.isPending && <Loader size="sm" />}
        <Text fz="xs" c="dimmed">
          {challenge && left > 0
            ? `Код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
            : challenge
              ? 'Срок действия кода истёк'
              : request.isPending
                ? 'Отправляем код…'
                : null}
        </Text>
        <Button variant="subtle" size="xs" onClick={send} loading={request.isPending}>
          Отправить новый код
        </Button>
      </Stack>
    </Modal>
  );
}

function nextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/**
 * Подписание — главный блок страницы: компактный статус, договор (сумма крупно, условия, переплата из договора,
 * мини-график), согласие и подпись кодом. Хеш условий — под «Подробнее», рядом со ссылкой на договор. На телефоне
 * «Подписать кодом» закреплена внизу. После подписи — настоящее состояние перевода, а не демонстрационная вставка.
 */
export function SigningCard({ app, extra }: { app: Application; extra?: ReactNode }) {
  const contract = useContract(app.id, true);
  const interestOnly = useInterestOnly(app.offer?.product_code);
  const [agreed, setAgreed] = useState(false);
  const [modalOpened, setModalOpened] = useState(false);
  const [more, setMore] = useState(false);
  const signed = app.offer?.status === 'signed';
  const canSign = app.allowed_actions.includes('sign');
  const c = contract.data;

  return (
    <section className="potok-decision" id="signing">
      <StatusBlock app={app} onPage hint={false} action={false} />
      <Title order={2} className="potok-say">
        {signed ? 'Договор подписан' : 'Договор готов к подписанию'}
      </Title>
      <Text c="dimmed" mt={4}>
        {c ? nb(`Кредитный договор №${NBSP}${c.number}`) : 'Готовим договор…'}
      </Text>

      {c && (
        <>
          <div className="potok-figures">
            <div>
              <div className="potok-fig-k">Сумма кредита</div>
              <div className="potok-big">{moneyBig(c.amount)}</div>
              <div className="potok-under">
                на {months(c.term_months)} под {rate(c.rate)} годовых
              </div>
            </div>
            <div>
              <div className="potok-fig-k">{interestOnly ? 'Проценты в месяц' : 'Платёж в месяц'}</div>
              <div className="potok-big">{moneyBig(c.monthly_payment)}</div>
              <div className="potok-under">первый — через месяц после выдачи</div>
            </div>
          </div>
          {/* Переплата и полная сумма — из договора, как на странице кредита. */}
          <div className="potok-cost">
            <span>
              Переплата <b>{money(c.total_payments - c.amount)}</b>
            </span>
            <span>
              Всего вернёте <b>{money(c.total_payments)}</b>
            </span>
          </div>
          {!interestOnly && (
            <div className="potok-sched">
              <div className="potok-sched-head">
                <Title order={3}>График платежей</Title>
                <BarsLegend />
              </div>
              <PaymentBars rows={c.schedule} firstDate={nextMonth()} />
            </div>
          )}
        </>
      )}

      <div className="potok-sign-links">
        <Anchor component={Link} to={`/applications/${app.id}/contract`} className="potok-link">
          Открыть договор и график платежей
        </Anchor>
        {c && (
          <Anchor component="button" type="button" className="potok-link potok-link-quiet" onClick={() => setMore((m) => !m)} aria-expanded={more}>
            {more ? 'Скрыть подробности' : 'Подробнее'}
          </Anchor>
        )}
      </div>
      {c && (
        <Collapse in={more}>
          <Text fz="sm" c="dimmed" mt={8}>
            Подпись привязана к условиям договора и графику: SHA-256 {c.terms_hash.slice(0, 16)}…
          </Text>
        </Collapse>
      )}

      {signed ? (
        <div className="potok-inline-note" data-tone={c?.issue_delayed || app.open_tasks > 0 ? 'warn' : 'ok'} role="status">
          {app.open_tasks > 0
            ? 'Договор подписан. Деньги поступят, как только вы закроете условия выдачи — они выше на странице.'
            : c?.issue_delayed
              ? 'Система банка временно не отвечает — перевод задерживается, мы повторяем его автоматически. Договор подписан, ничего делать не нужно.'
              : interestOnly
                ? 'Открываем лимит овердрафта на расчётном счёте компании — это займёт несколько секунд.'
                : 'Перечисляем деньги на расчётный счёт компании — это займёт несколько секунд.'}
        </div>
      ) : canSign ? (
        <>
          <Checkbox
            mt="lg"
            checked={agreed}
            onChange={(e) => setAgreed(e.currentTarget.checked)}
            label="Я ознакомился с договором и графиком платежей и согласен с условиями"
          />
          <div className="potok-cta">
            <div className="potok-cta-main">
              <Button size="lg" disabled={!agreed} onClick={() => setModalOpened(true)}>
                Подписать кодом
              </Button>
            </div>
            {extra}
          </div>
          <CodeModal app={app} opened={modalOpened} onClose={() => setModalOpened(false)} />
        </>
      ) : (
        <>
          <div className="potok-inline-note">Подписать договор может только руководитель компании.</div>
          {extra && <div className="potok-cta">{extra}</div>}
        </>
      )}
    </section>
  );
}

/**
 * Выдача: деньги на счёте или, для овердрафта, открытый лимит. Первый платёж и ближайшие платежи — из графика
 * выданного кредита (тот же расчёт, что на странице кредита).
 */
export function IssuedCard({ app }: { app: Application }) {
  const offer = app.offer;
  const interestOnly = useInterestOnly(offer?.product_code);
  const loan = useLoan(app.loan_id ?? 0, !!app.loan_id);
  const l = loan.data;
  const upcoming = l ? l.schedule.filter((r) => !l.next_payment_date || r.date >= l.next_payment_date).slice(0, 3) : [];
  return (
    <section className="potok-decision">
      <StatusBlock app={app} onPage hint={false} action={false} />
      <Title order={2} className="potok-say">
        {interestOnly ? 'Лимит открыт!' : 'Деньги на счёте!'}
      </Title>
      {offer && (
        <>
          <div className="potok-big" style={{ marginTop: 8 }}>
            {moneyBig(offer.amount)}
          </div>
          <Text c="dimmed" mt={6}>
            {interestOnly
              ? `Лимит овердрафта ${money(offer.amount)} открыт на расчётном счёте компании`
              : `зачислены на расчётный счёт компании${l ? ` ${dateTime(l.issued_at)}` : ''}`}
          </Text>
        </>
      )}
      {l?.next_payment_date && l.next_payment_amount && (
        <div className="potok-inline-note">
          <b>
            Первый платёж — {money(l.next_payment_amount)}, {date(l.next_payment_date)}.
          </b>{' '}
          {interestOnly ? 'Это проценты; основной долг возвращается в конце срока. ' : ''}Спишется с расчётного счёта
          автоматически — следить за датой не нужно.
        </div>
      )}
      <div className="potok-cta">
        {app.loan_id && (
          <Button component={Link} to={`/loans/${app.loan_id}`} size="lg">
            Кредит и график платежей
          </Button>
        )}
        <Button component={Link} to={`/applications/${app.id}/contract`} size="lg" variant="subtle">
          Скачать договор
        </Button>
      </div>
      {upcoming.length > 0 && (
        <section className="potok-sched">
          <Title order={3}>Ближайшие платежи</Title>
          <ul className="potok-rows">
            {upcoming.map((r) => (
              <li key={r.n}>
                <Link to={`/loans/${app.loan_id}`} className="potok-row">
                  <span className="potok-row-main">
                    <span className="potok-row-title">{date(r.date)}</span>
                    <span className="potok-row-sub">
                      основной долг {money(r.principal)}, проценты {money(r.interest)}
                    </span>
                  </span>
                  <span className="potok-row-side">{money(r.payment)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
