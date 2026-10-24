import { Anchor, Button, Checkbox, FileButton, Radio, Select, Skeleton, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconArrowLeft } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import {
  useApplication,
  useDocuments,
  useFinancials,
  useMeta,
  useProducts,
  useSubmitApplication,
  useUpdateApplication,
  useUploadDocument,
} from '../api/hooks';
import type { Application, ApplicationForm, Product, Purpose, PurposeInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DocumentList } from '../components/ApplicationBlocks';
import { ChoiceList, ChoiceMark } from '../components/Choice';
import { AmountTermFields, MoneyInput } from '../components/Money';
import { Stepper } from '../components/Status';
import { MAX_DEBT_SHARE, monthlyPayment } from '../lib/finance';
import { NBSP, amountRange, date, money, moneyBig, moneyShort, months, monthsShort, percent, plural, rate } from '../lib/format';
import { nb } from '../lib/nobreak';
import { LoadError } from '../components/States';

type StepKey = 'company' | 'params' | 'finance' | 'collateral' | 'documents' | 'review';

const STEP_LABELS: Record<StepKey, string> = {
  company: 'Компания',
  params: 'Кредит',
  finance: 'Финансы',
  collateral: 'Обеспечение',
  documents: 'Документы',
  review: 'Проверка',
};

const COLLATERAL_KINDS = [
  { value: 'real_estate', label: 'Недвижимость' },
  { value: 'vehicle', label: 'Транспорт' },
  { value: 'equipment', label: 'Оборудование' },
  { value: 'guarantee', label: 'Поручительство собственника' },
];

interface Params {
  product_code: string;
  purpose: Purpose;
  amount: number;
  term_months: number;
}

function documentKind(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('выписк')) return 'bank_statement';
  if (t.includes('отчётност')) return 'financial_report';
  if (t.includes('залог')) return 'collateral';
  return 'other';
}

function num(value: string | number): number | null {
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, ''));
  return Number.isFinite(n) && String(value) !== '' ? n : null;
}

/** Зачем банку документ — одна строка под названием. */
const DOCUMENT_WHY: Record<string, string> = {
  bank_statement: 'По ней банк проверит обороты по счёту',
  financial_report: 'По ней банк оценит финансовое положение компании',
  collateral: 'По ним банк оценит залог без визита в офис',
};

/** Подпись поля с меткой источника справа: «Выручка в месяц  ФНС». */
function SourceLabel({ text, source }: { text: string; source?: string }) {
  return (
    <>
      {text}
      {source && <span className="potok-src">{source}</span>}
    </>
  );
}

/** Сводка заявки — липкая колонка слева: продукт, сумма, срок, оценка платежа. */
function WizardSummary({ product, purpose, amount, term, payment }: { product: Product; purpose?: string; amount: number; term: number; payment: number }) {
  return (
    <aside className="potok-panel potok-wz-sum" aria-label="Ваша заявка">
      <div className="potok-wz-sum-what">{nb(product.name)}</div>
      {purpose && <div className="potok-muted-text">{purpose.toLowerCase()}</div>}
      <div className="potok-wz-sum-amount">{moneyBig(amount)}</div>
      <div className="potok-muted-text">на {months(term)}</div>
      <dl className="potok-pairs potok-side-pairs">
        <div>
          <dt>{product.repayment === 'interest_only' ? 'Проценты' : 'Платёж'}</dt>
          <dd>≈{NBSP}{money(payment)} в{NBSP}месяц</dd>
        </div>
        <div>
          <dt>Ставка</dt>
          <dd>от {rate(product.rate)} годовых</dd>
        </div>
        <div>
          <dt>Решение</dt>
          <dd>{product.decision_time}</dd>
        </div>
      </dl>
      <Text fz="sm" c="dimmed" mt="md">
        Платёж и ставка — оценка: точные условия банк назовёт в решении.
      </Text>
    </aside>
  );
}

/** Что понадобится для заявки. */
function NeededDocuments({ product }: { product: Product }) {
  return (
    <section className="potok-panel">
      <Title order={3}>Что понадобится</Title>
      <ul className="potok-rows">
        <li className="potok-side-row">
          <b>Данные компании</b>
          <span>Уже взяли из ЕГРЮЛ и ФНС</span>
        </li>
        {product.documents.map((d) => (
          <li key={d} className="potok-side-row">
            <b>{d}</b>
          </li>
        ))}
        {product.collateral && (
          <li className="potok-side-row">
            <b>Обеспечение</b>
            <span>{product.collateral}</span>
          </li>
        )}
      </ul>
      <Text fz="sm" c="dimmed" mt="xs">
        Документы можно приложить на шаге «Документы» или позже, когда банк попросит.
      </Text>
    </section>
  );
}

/**
 * Нагрузка: доля всех кредитных платежей в выручке — графитовая полоса на шкале с меткой лимита. Выше лимита —
 * вывод цветом ошибки.
 */
function DebtMeter({ share }: { share: number }) {
  const over = share > MAX_DEBT_SHARE;
  const pct = Math.min(100, Math.round(share * 100));
  return (
    <div className="potok-meter" data-over={over}>
      <div className="potok-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Кредитная нагрузка">
        <span className="potok-meter-fill" style={{ width: `${pct}%` }} />
        <span className="potok-meter-limit" style={{ left: `${MAX_DEBT_SHARE * 100}%` }} />
      </div>
      <div className="potok-meter-scale">
        <span>0%</span>
        <span style={{ left: `${MAX_DEBT_SHARE * 100}%` }}>лимит {percent(MAX_DEBT_SHARE, 0)}</span>
        <span>100%</span>
      </div>
      <p className="potok-meter-verdict">
        Платежи по всем кредитам вместе с новым — {percent(share, 0)} выручки
        {share <= MAX_DEBT_SHARE ? `, в пределах лимита ${percent(MAX_DEBT_SHARE, 0)}` : '. Это больше лимита — банк, скорее всего, предложит меньшую сумму или больший срок'}
      </p>
    </div>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="potok-review-sec">
      <div className="potok-review-head">
        <Title order={3}>{title}</Title>
        <Button variant="subtle" px={0} onClick={onEdit}>
          Изменить
        </Button>
      </div>
      <dl className="potok-kv">{children}</dl>
    </section>
  );
}

function Wizard({ app, products, purposes }: { app: Application; products: Product[]; purposes: PurposeInfo[] }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const mobile = useMediaQuery('(max-width: 48em)');
  const update = useUpdateApplication(app.id);
  const submit = useSubmitApplication();
  const upload = useUploadDocument(app.id);
  const documents = useDocuments(app.id);
  const financials = useFinancials(true);

  const [params, setParams] = useState<Params>({
    product_code: app.product.code,
    purpose: app.purpose,
    amount: app.amount,
    term_months: app.term_months,
  });
  const [form, setForm] = useState<ApplicationForm>(() => ({
    ...app.form,
    contact_name: app.form.contact_name ?? user?.full_name ?? null,
    contact_position: app.form.contact_position ?? user?.position ?? null,
  }));
  const [active, setActive] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [hasDebts, setHasDebts] = useState(() => !!app.form.finance.debt_payments);
  const [sheetOpen, setSheetOpen] = useState(false);
  const prefilled = useRef(false);

  const product = products.find((p) => p.code === params.product_code) ?? products[0];
  const steps = useMemo<StepKey[]>(
    () =>
      (['company', 'params', 'finance', 'collateral', 'documents', 'review'] as StepKey[]).filter(
        (s) => s !== 'collateral' || !!product.collateral,
      ),
    [product.collateral],
  );
  const step = steps[Math.min(active, steps.length - 1)];

  // Выручку и расходы подставляем из «Прозрачного бизнеса», чтобы клиенту не вводить их вручную.
  useEffect(() => {
    const data = financials.data;
    if (!data?.available || prefilled.current || form.finance.monthly_revenue) return;
    prefilled.current = true;
    setForm((f) => ({
      ...f,
      finance: {
        ...f.finance,
        monthly_revenue: data.revenue_monthly,
        monthly_expenses: f.finance.monthly_expenses ?? data.expenses_monthly,
        employees: f.finance.employees ?? data.employees,
      },
    }));
  }, [financials.data, form.finance.monthly_revenue]);

  const payment = monthlyPayment(params.amount, product.rate, params.term_months, product.repayment);
  const revenue = form.finance.monthly_revenue ?? 0;
  const debtShare = revenue > 0 ? (payment + (form.finance.debt_payments ?? 0)) / revenue : null;
  const productPurposes = purposes.filter((p) => product.purposes.includes(p.code));

  const errors: Partial<Record<string, string>> = {};
  if (step === 'company' && !form.contact_name?.trim()) errors.contact_name = 'Укажите, с кем связаться';
  if (step === 'params') {
    if (params.amount < product.min_amount || params.amount > product.max_amount) {
      errors.amount = `От ${moneyShort(product.min_amount)} до ${moneyShort(product.max_amount)}`;
    }
    if (!product.purposes.includes(params.purpose)) errors.purpose = 'Этот продукт не подходит для выбранной цели';
  }
  if (step === 'finance' && !(revenue > 0)) errors.monthly_revenue = 'Без выручки банк не сможет оценить заявку';
  if (step === 'collateral') {
    if (!form.collateral?.kind) errors.collateral_kind = 'Выберите вид обеспечения';
    if (!form.collateral?.value) errors.collateral_value = 'Укажите примерную стоимость';
  }
  if (step === 'review' && !form.consent_bki) errors.consent = 'Без согласия банк не сможет проверить кредитную историю';
  const err = (key: string) => (showErrors ? errors[key] : undefined);

  const save = async () => {
    await update.mutateAsync({ ...params, form });
    setSavedAt(new Date());
  };

  const goTo = async (index: number) => {
    if (index > active && Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await save();
    } catch {
      return;
    }
    setShowErrors(false);
    setActive(index);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const send = async () => {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    try {
      await save();
    } catch {
      return;
    }
    submit.mutate({ id: app.id }, { onSuccess: () => navigate(`/applications/${app.id}`) });
  };

  const selectProduct = (p: Product) =>
    setParams((prev) => ({
      product_code: p.code,
      purpose: p.purposes.includes(prev.purpose) ? prev.purpose : p.purposes[0],
      amount: Math.min(Math.max(prev.amount, p.min_amount), p.max_amount),
      term_months: Math.min(Math.max(prev.term_months, p.min_term), p.max_term),
    }));

  const setFinance = (key: keyof ApplicationForm['finance'], value: string | number) =>
    setForm((f) => ({ ...f, finance: { ...f.finance, [key]: num(value) } }));

  const company = user?.company;
  const stepNo = Math.min(active, steps.length - 1);
  const purposeTitle = purposes.find((p) => p.code === params.purpose)?.title;
  const fromFns = !!financials.data?.available;
  const indexOf = (s: StepKey) => steps.indexOf(s);
  const busy = update.isPending || submit.isPending;
  const back = stepNo > 0 && (
    <Button variant="default" size="lg" onClick={() => goTo(active - 1)} disabled={busy}>
      Назад
    </Button>
  );
  // Без согласия на запрос в БКИ заявку не отправить — кнопка неактивна, пока согласие не отмечено.
  const next =
    step === 'review' ? (
      <Button size="lg" onClick={send} loading={busy} disabled={!form.consent_bki}>
        Отправить в банк
      </Button>
    ) : (
      <Button size="lg" onClick={() => goTo(active + 1)} loading={update.isPending}>
        Далее
      </Button>
    );

  return (
    <div className="potok-wz-page">
      <div className="potok-wz-head">
        <div>
          <Anchor component={Link} to={`/applications/${app.id}`} fz="sm" c="dimmed" className="potok-back">
            <IconArrowLeft size={16} /> К заявке
          </Anchor>
          <Title order={2} mt={4}>
            Заявка на кредит
          </Title>
          <Text fz="sm" c="dimmed" mt={2}>
            Заявка {nb(app.number)}
            {savedAt ? ', черновик сохранён' : ''}
          </Text>
        </div>
        <Stepper labels={steps.map((s) => STEP_LABELS[s])} current={stepNo} showLabels={!mobile} />
      </div>

      <div className="potok-wz">
        <div className="potok-wz-side">
          <WizardSummary product={product} purpose={purposeTitle} amount={params.amount} term={params.term_months} payment={payment} />
          {step === 'company' && <NeededDocuments product={product} />}
          {step === 'finance' && (
            <section className="potok-panel">
              <Title order={3}>Зачем эти цифры</Title>
              <Text c="dimmed" mt="xs">
                По выручке и платежам банк считает, какой платёж бизнесу по силам: все кредитные платежи — не больше
                половины выручки.
              </Text>
            </section>
          )}
          {step === 'documents' && (
            <section className="potok-panel">
              <Title order={3}>Нет документа под рукой</Title>
              <Text c="dimmed" mt="xs">
                Отправьте заявку без него. Если документ понадобится, банк пришлёт запрос в кабинет — заявка не
                потеряется.
              </Text>
            </section>
          )}
          {step === 'review' && (
            <section className="potok-panel">
              <Title order={3}>После отправки</Title>
              <ul className="potok-timeline potok-timeline-plan">
                <li>
                  Проверка данных
                  <span>пара минут</span>
                </li>
                <li>
                  Проверка компании
                  <span>банк сам запросит ЕГРЮЛ, ФНС и БКИ</span>
                </li>
                <li>
                  Оценка
                  <span>{product.decision === 'auto' ? product.decision_time : 'автоматически, затем специалист'}</span>
                </li>
                <li>
                  Решение
                  <span>придёт уведомление в кабинет</span>
                </li>
              </ul>
            </section>
          )}
        </div>

        <section className="potok-panel potok-wz-form fade-in" key={step}>
          <div className="potok-wz-stepno">
            Анкета: {stepNo + 1} из {steps.length}
            {mobile ? `, ${STEP_LABELS[step].toLowerCase()}` : ''}
          </div>

          {step === 'company' && company && (
            <>
              <Title order={1} className="potok-wz-h">
                Проверьте данные компании
              </Title>
              <Text className="potok-note">Взяли их из ЕГРЮЛ — вводить ничего не нужно.</Text>
              <div className="potok-wz-inset">
                <div className="potok-wz-inset-head">
                  <b>{nb(company.short_name)}</b>
                  <span className="potok-src">ЕГРЮЛ</span>
                </div>
                <dl className="potok-kv">
                  <div>
                    <dt>ИНН</dt>
                    <dd>{company.inn}</dd>
                  </div>
                  {company.ogrn && (
                    <div>
                      <dt>ОГРН</dt>
                      <dd>{company.ogrn}</dd>
                    </div>
                  )}
                  {company.registered_at && (
                    <div>
                      <dt>Работает с</dt>
                      <dd>{date(company.registered_at)}</dd>
                    </div>
                  )}
                  {company.okved && (
                    <div className="potok-kv-wide">
                      <dt>Вид деятельности</dt>
                      <dd>
                        {company.okved} — {company.okved_name}
                      </dd>
                    </div>
                  )}
                  {company.director && (
                    <div>
                      <dt>Руководитель</dt>
                      <dd>{company.director}</dd>
                    </div>
                  )}
                  {company.address && (
                    <div className="potok-kv-full">
                      <dt>Адрес</dt>
                      <dd>{company.address}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <Text fz="sm" c="dimmed" mt={8}>
                Что-то устарело — поменяйте данные в ЕГРЮЛ: банк увидит изменения сам.
              </Text>
              <Title order={3} mt={32}>
                С кем связаться по заявке
              </Title>
              <div className="potok-wz-row2">
                <TextInput
                  label="Контактное лицо"
                  value={form.contact_name ?? ''}
                  onChange={(e) => setForm({ ...form, contact_name: e.currentTarget.value })}
                  error={err('contact_name')}
                  maxLength={255}
                />
                <TextInput
                  label="Должность"
                  value={form.contact_position ?? ''}
                  onChange={(e) => setForm({ ...form, contact_position: e.currentTarget.value })}
                  maxLength={255}
                />
              </div>
              {!user?.can_sign && (
                <div className="potok-inline-note">
                  Вы можете заполнить и отправить заявку. Подписать договор сможет только руководитель компании.
                </div>
              )}
            </>
          )}

          {step === 'params' && (
            <>
              <Title order={1} className="potok-wz-h">
                Какой кредит нужен
              </Title>
              <Text className="potok-note">Можно поменять продукт — сумма и срок подстроятся под его условия.</Text>
              <div style={{ marginTop: 24 }}>
                <ChoiceList
                  label="Продукт"
                  value={product.code}
                  onChange={(code) => {
                    const p = products.find((x) => x.code === code);
                    if (p) selectProduct(p);
                  }}
                  options={products.map((p) => ({
                    value: p.code,
                    title: p.name,
                    text: `от ${rate(p.rate)} годовых, ${amountRange(p.min_amount, p.max_amount)}, решение ${p.decision_time}`,
                  }))}
                />
              </div>
              <Select
                mt={24}
                label="Цель кредита"
                data={productPurposes.map((p) => ({ value: p.code, label: p.title }))}
                value={params.purpose}
                onChange={(v) => v && setParams({ ...params, purpose: v as Purpose })}
                error={err('purpose')}
                allowDeselect={false}
              />
              <div style={{ marginTop: 24 }}>
                <AmountTermFields
                  amount={params.amount}
                  onAmount={(v) => setParams({ ...params, amount: v })}
                  term={params.term_months}
                  onTerm={(v) => setParams({ ...params, term_months: v })}
                  minAmount={product.min_amount}
                  maxAmount={product.max_amount}
                  minTerm={product.min_term}
                  maxTerm={product.max_term}
                  amountError={err('amount')}
                  termError={err('term_months')}
                />
              </div>
              <Text c="dimmed" mt="lg">
                {product.repayment === 'interest_only' ? 'Проценты в месяц при полном использовании лимита' : 'Платёж в месяц'} —
                примерно <b className="potok-ink">{money(payment)}</b>
              </Text>
            </>
          )}

          {step === 'finance' && (
            <>
              <Title order={1} className="potok-wz-h">
                Финансы компании
              </Title>
              <Text className="potok-note">По этим цифрам банк считает, какой платёж бизнесу по силам.</Text>
              <div className="potok-wz-row2 potok-wz-group">
                <MoneyInput
                  label={<SourceLabel text="Выручка в месяц" source={fromFns ? 'ФНС' : undefined} />}
                  value={form.finance.monthly_revenue ?? ''}
                  onChange={(v) => setFinance('monthly_revenue', v)}
                  error={err('monthly_revenue')}
                />
                <MoneyInput
                  label={<SourceLabel text="Расходы в месяц" source={fromFns ? 'ФНС' : undefined} />}
                  value={form.finance.monthly_expenses ?? ''}
                  onChange={(v) => setFinance('monthly_expenses', v)}
                />
                <MoneyInput
                  unit=""
                  thousandSeparator={undefined}
                  label={<SourceLabel text="Сотрудников, включая вас" source={fromFns && financials.data?.employees ? 'ФНС' : undefined} />}
                  value={form.finance.employees ?? ''}
                  onChange={(v) => setFinance('employees', v)}
                  max={100_000}
                />
              </div>
              <Text fz="sm" c="dimmed" mt={8}>
                {fromFns
                  ? `Заполнили выручку и расходы по данным ФНС за ${financials.data?.reporting_year} год, число сотрудников — тоже. Поправьте, если сейчас иначе.`
                  : financials.data
                    ? 'В налоговой нет данных о выручке — укажите её сами. Банк может попросить выписку, её можно приложить на шаге «Документы».'
                    : null}
              </Text>

              <Title order={3} className="potok-wz-group">
                Платите ли вы сейчас по другим кредитам?
              </Title>
              <Radio.Group
                value={hasDebts ? 'yes' : 'no'}
                onChange={(v) => {
                  setHasDebts(v === 'yes');
                  if (v === 'no') setForm((f) => ({ ...f, finance: { ...f.finance, debt_payments: null } }));
                }}
              >
                <div className="potok-choices potok-choices-row" role="radiogroup" aria-label="Платите ли вы сейчас по другим кредитам">
                  {[
                    ['yes', 'Да', 'Платежи по ним учтём в нагрузке'],
                    ['no', 'Нет', 'Других кредитов у компании нет'],
                  ].map(([value, title, text]) => (
                    <Radio.Card key={value} value={value} className="potok-choice">
                      <span className="potok-choice-text">
                        <span className="potok-choice-title">{title}</span>
                        <span className="potok-choice-sub">{text}</span>
                      </span>
                      <ChoiceMark />
                    </Radio.Card>
                  ))}
                </div>
              </Radio.Group>
              {hasDebts && (
                <MoneyInput
                  mt="md"
                  label="Платежи по ним в месяц"
                  description="Сумма ежемесячных платежей во всех банках, а не весь долг"
                  value={form.finance.debt_payments ?? ''}
                  onChange={(v) => setFinance('debt_payments', v)}
                />
              )}

              {debtShare !== null && (
                <section className="potok-wz-inset potok-wz-group" aria-label="Кредитная нагрузка">
                  <Title order={3}>Кредитная нагрузка</Title>
                  <DebtMeter share={debtShare} />
                </section>
              )}
            </>
          )}

          {step === 'collateral' && (
            <>
              <Title order={1} className="potok-wz-h">
                Обеспечение
              </Title>
              <Text className="potok-note">
                Для продукта «{nb(product.name)}» нужно обеспечение: {product.collateral?.toLowerCase()}.
              </Text>
              <div className="potok-wz-row2" style={{ marginTop: 24 }}>
                <Select
                  label="Что предлагаете в залог"
                  data={COLLATERAL_KINDS}
                  value={form.collateral?.kind ?? null}
                  onChange={(v) =>
                    setForm({ ...form, collateral: { kind: v, value: form.collateral?.value ?? null, description: form.collateral?.description ?? null } })
                  }
                  error={err('collateral_kind')}
                />
                <MoneyInput
                  label="Примерная стоимость"
                  value={form.collateral?.value ?? ''}
                  onChange={(v) =>
                    setForm({ ...form, collateral: { kind: form.collateral?.kind ?? null, value: num(v), description: form.collateral?.description ?? null } })
                  }
                  error={err('collateral_value')}
                />
              </div>
              {/* Покрытие — из введённых сумм, без запросов к банку. */}
              <ul className="potok-wz-inset potok-wz-facts">
                <li>
                  <span>Покрытие залогом</span>
                  <b>
                    {form.collateral?.value && params.amount > 0
                      ? `залог ${money(form.collateral.value)} покрывает ${percent(form.collateral.value / params.amount, 0)} суммы кредита`
                      : 'укажите стоимость залога'}
                  </b>
                </li>
                {product.collateral?.toLowerCase().includes('поручительство') && (
                  <li>
                    <span>Поручительство собственника</span>
                    <b>руководитель подтвердит его в кабинете после решения банка, перед выдачей</b>
                  </li>
                )}
              </ul>
              <Textarea
                mt="md"
                label="Описание, необязательно"
                placeholder="Например: станок ЧПУ 2022 года, приобретается на кредитные средства"
                value={form.collateral?.description ?? ''}
                onChange={(e) =>
                  setForm({ ...form, collateral: { kind: form.collateral?.kind ?? null, value: form.collateral?.value ?? null, description: e.currentTarget.value } })
                }
                maxLength={1000}
                autosize
                minRows={2}
              />
            </>
          )}

          {step === 'documents' && (
            <>
              <Title order={1} className="potok-wz-h">
                Документы
              </Title>
              <Text className="potok-note">Необязательно: с документами решение быстрее — банку не придётся их запрашивать.</Text>
              <div className="potok-docs">
                {product.documents.map((title) => {
                  const kind = documentKind(title);
                  const uploaded = documents.data?.filter((d) => d.kind === kind) ?? [];
                  return (
                    <div key={title} className="potok-doc">
                      <div className="potok-doc-main">
                        <div className="potok-doc-title">{title}</div>
                        {DOCUMENT_WHY[kind] && <div className="potok-doc-why">{DOCUMENT_WHY[kind]}</div>}
                      </div>
                      <FileButton
                        onChange={(file) => file && upload.mutate({ file, kind })}
                        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.doc,.docx,.txt"
                      >
                        {(props) => (
                          <Button {...props} variant="default" size="md" loading={upload.isPending && upload.variables?.kind === kind}>
                            {uploaded.length ? 'Добавить ещё' : 'Загрузить'}
                          </Button>
                        )}
                      </FileButton>
                      {uploaded.length > 0 && (
                        <div className="potok-doc-files">
                          <DocumentList documents={uploaded} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <Text fz="sm" c="dimmed" mt="md">
                PDF, изображения, Excel или Word до 10{NBSP}МБ.
              </Text>
            </>
          )}

          {step === 'review' && (
            <>
              <Title order={1} className="potok-wz-h">
                Всё верно?
              </Title>
              <Text className="potok-note">Проверьте заявку перед отправкой — после отправки менять её нельзя.</Text>
              <div className="potok-review">
                <ReviewSection title="Компания" onEdit={() => goTo(indexOf('company'))}>
                  <div>
                    <dt>Компания</dt>
                    <dd>{nb(company?.short_name)}</dd>
                  </div>
                  <div>
                    <dt>ИНН</dt>
                    <dd>{company?.inn}</dd>
                  </div>
                  <div>
                    <dt>Контакт</dt>
                    <dd>{form.contact_name}</dd>
                  </div>
                </ReviewSection>
                <ReviewSection title="Кредит" onEdit={() => goTo(indexOf('params'))}>
                  <div>
                    <dt>Продукт</dt>
                    <dd>{nb(product.name)}</dd>
                  </div>
                  <div>
                    <dt>Сумма</dt>
                    <dd>{money(params.amount)}</dd>
                  </div>
                  <div>
                    <dt>Срок</dt>
                    <dd>{months(params.term_months)}</dd>
                  </div>
                  <div>
                    <dt>Цель</dt>
                    <dd>{purposeTitle}</dd>
                  </div>
                  <div>
                    <dt>Платёж</dt>
                    <dd>≈{NBSP}{money(payment)}</dd>
                  </div>
                </ReviewSection>
                <ReviewSection title="Финансы" onEdit={() => goTo(indexOf('finance'))}>
                  <div>
                    <dt>Выручка в месяц</dt>
                    <dd>{money(revenue)}</dd>
                  </div>
                  <div>
                    <dt>Платежи по кредитам</dt>
                    <dd>{form.finance.debt_payments ? money(form.finance.debt_payments) : 'нет'}</dd>
                  </div>
                  {debtShare !== null && (
                    <div>
                      <dt>Нагрузка с новым</dt>
                      <dd>
                        {percent(debtShare, 0)} из {percent(MAX_DEBT_SHARE, 0)}
                      </dd>
                    </div>
                  )}
                </ReviewSection>
                {product.collateral && (
                  <ReviewSection title="Обеспечение" onEdit={() => goTo(indexOf('collateral'))}>
                    <div>
                      <dt>Залог</dt>
                      <dd>{COLLATERAL_KINDS.find((k) => k.value === form.collateral?.kind)?.label ?? 'не указан'}</dd>
                    </div>
                    <div>
                      <dt>Стоимость</dt>
                      <dd>{form.collateral?.value ? money(form.collateral.value) : 'не указана'}</dd>
                    </div>
                  </ReviewSection>
                )}
                <ReviewSection title="Документы" onEdit={() => goTo(indexOf('documents'))}>
                  <div className="potok-kv-full">
                    <dt>Приложено</dt>
                    <dd>
                      {documents.data?.length
                        ? `${documents.data.length} ${plural(documents.data.length, ['файл', 'файла', 'файлов'])}`
                        : 'Не приложены, банк запросит, если понадобятся'}
                    </dd>
                  </div>
                </ReviewSection>
              </div>
              {/* Согласие не отмечено заранее: без него заявку не отправить (правило анкеты). */}
              <Checkbox
                mt="lg"
                checked={form.consent_bki}
                onChange={(e) => setForm({ ...form, consent_bki: e.currentTarget.checked })}
                label="Согласен на запрос кредитной истории компании в бюро кредитных историй и проверку данных в ЕГРЮЛ и ФНС"
                error={err('consent')}
              />
            </>
          )}

          <div className="potok-wz-actions">
            {back || <span />}
            {next}
          </div>
        </section>
      </div>

      {/* Телефон: свёрнутая сводка над закреплёнными «Назад/Далее»; нижних вкладок в анкете нет. */}
      <button type="button" className="potok-wz-sheet" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}>
        <span className="potok-wz-sheet-grab" aria-hidden="true" />
        <span className="potok-wz-sheet-line">
          <span>
            {nb(product.name)}, {monthsShort(params.term_months)}
          </span>
          <b>{moneyBig(params.amount)}</b>
        </span>
        {sheetOpen && (
          <span className="potok-wz-sheet-more">
            Платёж ≈{NBSP}{money(payment)} в месяц, ставка от {rate(product.rate)}, решение {product.decision_time}
          </span>
        )}
      </button>
      <div className="potok-wz-bar">
        {back}
        {next}
      </div>
    </div>
  );
}

export function ApplicationWizardPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const query = useApplication(applicationId);
  const products = useProducts();
  const meta = useMeta();

  if (query.isLoading || products.isLoading || meta.isLoading) {
    return (
      <Stack>
        <Skeleton h={40} w="100%" maw={320} />
        <Skeleton h={80} radius="lg" />
        <Skeleton h={360} radius="lg" />
      </Stack>
    );
  }
  if (query.isError || products.isError || meta.isError) {
    return (
      <LoadError
        error={query.error ?? products.error ?? meta.error}
        what="анкету"
        back={
          <Button component={Link} to="/applications" size="lg" variant="default">
            К списку заявок
          </Button>
        }
      />
    );
  }
  if (!query.data || !products.data || !meta.data) return <Navigate to="/applications" replace />;
  if (query.data.status.code !== 'draft') return <Navigate to={`/applications/${applicationId}`} replace />;
  return <Wizard app={query.data} products={products.data} purposes={meta.data.purposes} />;
}
