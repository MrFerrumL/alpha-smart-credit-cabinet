import { Anchor, Button, Checkbox, FileButton, Radio, Select, Skeleton, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconArrowLeft } from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { tokenStore } from '../api/client';
import {
  keys,
  useApplication,
  useDocuments,
  useFinancials,
  useMeta,
  useProducts,
  useSubmitApplication,
  useUpdateApplication,
  useUploadDocument,
  type ApplicationUpdate,
} from '../api/hooks';
import type { Application, ApplicationForm, Product, Purpose, PurposeInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DocumentList } from '../components/ApplicationBlocks';
import { ChoiceList, ChoiceMark } from '../components/Choice';
import { AmountTermFields, MoneyInput } from '../components/Money';
import { Stepper } from '../components/Status';
import { MAX_DEBT_SHARE, MIN_COVERAGE, REVENUE_MULTIPLIER, monthlyPayment, revenueLimit, servicePayment } from '../lib/finance';
import { NBSP, amountRange, date, decimal, money, moneyBig, moneyShort, months, monthsShort, percent, plural, rate } from '../lib/format';
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

type FieldErrors = Partial<Record<string, string>>;

/** Шаги анкеты продукта: «Обеспечение» — только если продукт его требует. */
function stepsFor(product: Product): StepKey[] {
  return (['company', 'params', 'finance', 'collateral', 'documents', 'review'] as StepKey[]).filter(
    (s) => s !== 'collateral' || !!product.collateral,
  );
}

/** Ошибки шага: поле → текст. Пустой объект — шаг заполнен, дальше можно. */
function stepErrors(step: StepKey, params: Params, form: ApplicationForm, product: Product): FieldErrors {
  const errors: FieldErrors = {};
  if (step === 'company' && !form.contact_name?.trim()) errors.contact_name = 'Укажите, с кем связаться';
  if (step === 'params') {
    if (params.amount < product.min_amount || params.amount > product.max_amount) {
      errors.amount = `От ${moneyShort(product.min_amount)} до ${moneyShort(product.max_amount)}`;
    }
    if (!product.purposes.includes(params.purpose)) errors.purpose = 'Этот продукт не подходит для выбранной цели';
  }
  if (step === 'finance' && !((form.finance.monthly_revenue ?? 0) > 0)) errors.monthly_revenue = 'Без выручки банк не сможет оценить заявку';
  if (step === 'collateral') {
    if (!form.collateral?.kind) errors.collateral_kind = 'Выберите вид обеспечения';
    if (!form.collateral?.value) errors.collateral_value = 'Укажите примерную стоимость';
  }
  if (step === 'review' && !form.consent_bki) errors.consent = 'Без согласия банк не сможет проверить кредитную историю';
  return errors;
}

/** То, что лежит на сервере, в том же виде, в каком анкета его сохраняет. */
function savedBody(app: Application): ApplicationUpdate {
  return { product_code: app.product.code, purpose: app.purpose, amount: app.amount, term_months: app.term_months, form: app.form };
}

/**
 * С какого шага открыть черновик: с первого, где в сохранённой заявке не хватает обязательных данных, иначе — с
 * проверки. Адрес не меняется: шаг выводится из самой заявки. Данные ФНС подставляются только на шаге «Финансы» и
 * без правок клиента сами не сохраняются, поэтому выручка в черновике значит, что клиент до этого шага дошёл.
 */
function resumeStep(app: Application, product: Product): number {
  const saved = savedBody(app);
  const steps = stepsFor(product);
  const i = steps.findIndex((s) => s !== 'review' && Object.keys(stepErrors(s, saved, app.form, product)).length > 0);
  return i === -1 ? steps.length - 1 : i;
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

const AUTOSAVE_MS = 1000;

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  pending: 'Сохраняем…',
  saving: 'Сохраняем…',
  saved: 'Черновик сохранён',
  failed: 'Черновик не сохранён',
};

/**
 * Черновик сохраняется сам — через секунду после последней правки клиента. Все запросы идут одной очередью, и
 * отправка в банк встаёт в ту же очередь: параллельный PATCH поднял бы версию заявки, и соседний запрос (или
 * отправка с ключом идемпотентности) получил бы 409.
 */
function useDraftSaver(id: number, body: ApplicationUpdate, saved: ApplicationUpdate) {
  const update = useUpdateApplication(id);
  const mutate = useRef(update.mutateAsync);
  mutate.current = update.mutateAsync;
  const latest = useRef(body);
  latest.current = body;
  const savedJson = useRef(JSON.stringify(saved));
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const edits = useRef(0); // правки клиента
  const savedEdits = useRef(0); // сколько из них уже на сервере
  const paused = useRef(false); // идёт отправка в банк — фоновых сохранений нет
  const timer = useRef<number | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<SaveState>('idle');

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const dirty = () => edits.current > savedEdits.current;

  /** Сохранить то, что сейчас в анкете, если оно отличается от сохранённого. false — сервер не принял. */
  const save = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    return enqueue(async () => {
      const next = latest.current;
      const json = JSON.stringify(next);
      const upTo = edits.current;
      if (json !== savedJson.current) {
        setState('saving');
        try {
          await mutate.current(next);
        } catch {
          setState('failed');
          return false;
        }
        savedJson.current = json;
      }
      savedEdits.current = Math.max(savedEdits.current, upTo);
      setState(edits.current > savedEdits.current ? 'pending' : 'saved');
      return true;
    });
  }, [enqueue]);

  /** Правка клиента. Подстановка данных ФНС правкой не считается и сама по себе не сохраняется. */
  const touch = useCallback(() => {
    edits.current += 1;
    setTick((t) => t + 1);
    setState('pending');
  }, []);

  useEffect(() => {
    if (tick === 0 || paused.current) return;
    timer.current = window.setTimeout(() => {
      if (!paused.current) void save();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer.current);
  }, [tick, save]);

  // Ушли по вкладке шапки или кнопкой «Назад» браузера — несохранённое уходит сразу, не дожидаясь таймера.
  // После выхода из кабинета сохранять уже некому: токена нет.
  useEffect(
    () => () => {
      if (!paused.current && dirty() && tokenStore.get()) void save();
    },
    [save],
  );

  /** Перед уходом из анкеты: сохранить правки и дождаться очереди. */
  const flush = (): Promise<boolean> => (dirty() ? save() : enqueue(async () => true));

  /** Отправка в банк: фоновые сохранения останавливаются, последнее сохранение и отправка идут подряд. */
  const finish = async (task: () => Promise<unknown>): Promise<boolean> => {
    paused.current = true;
    window.clearTimeout(timer.current);
    const ok = (await save()) && (await enqueue(task).then(() => true, () => false));
    if (!ok) {
      paused.current = false;
      if (dirty()) setTick((t) => t + 1);
    }
    return ok;
  };

  return { touch, save, flush, finish, label: SAVE_LABEL[state] };
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

/** Нагрузка: доля всех кредитных платежей в выручке — графитовая полоса на шкале с меткой лимита. */
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
        Платежи по всем кредитам вместе с новым — {percent(share, 0)} выручки,{' '}
        {over ? 'больше' : 'в пределах'} лимита {percent(MAX_DEBT_SHARE, 0)}
      </p>
    </div>
  );
}

/** «1,5 месячной выручки», «6 месячных выручек». */
function revenueTimes(multiplier: number): string {
  if (!Number.isInteger(multiplier)) return `${decimal(multiplier, 1)}${NBSP}месячной выручки`;
  return `${multiplier}${NBSP}${plural(multiplier, ['месячной выручки', 'месячных выручек', 'месячных выручек'])}`;
}

/** «в 0,44 раза», «в 3 раза», «в 12 раз». Округление вниз: 1,199 не покажется как «1,2» рядом с порогом 1,2. */
function coverageTimes(value: number): string {
  const shown = value >= 10 ? Math.floor(value) : Math.floor(value * 100) / 100;
  const word = Number.isInteger(shown) ? plural(shown, ['раз', 'раза', 'раз']) : 'раза';
  return `в${NBSP}${decimal(shown, 2)}${NBSP}${word}`;
}

/**
 * Три проверки банка — те же, что в правилах решения (docs/scoring.md): нагрузка к выручке, лимит по выручке и
 * покрытие платежа прибылью. Видны до отправки, чтобы контрпредложение не стало неожиданностью.
 */
function BankChecks({ product, amount, term, finance }: { product: Product; amount: number; term: number; finance: ApplicationForm['finance'] }) {
  const revenue = finance.monthly_revenue ?? 0;
  // Овердрафт банк проверяет по аннуитету на тот же срок, а не по одним процентам.
  const payment = servicePayment(amount, product.rate, term);
  const share = revenue > 0 ? (payment + (finance.debt_payments ?? 0)) / revenue : null;
  const multiplier = REVENUE_MULTIPLIER[product.code];
  const limit = revenueLimit(revenue, product.code, product.max_amount);
  const profit = revenue > 0 && finance.monthly_expenses != null ? revenue - finance.monthly_expenses : null;
  const coverage = profit !== null && payment > 0 ? profit / payment : null;

  const overLimit = limit !== null && amount > limit;
  const exceeded = (share !== null && share > MAX_DEBT_SHARE) || overLimit || (coverage !== null && coverage < MIN_COVERAGE);
  const minCoverage = decimal(MIN_COVERAGE, 1);

  return (
    <section className="potok-wz-inset potok-wz-group" aria-label="Что проверит банк">
      <Title order={3}>Что проверит банк</Title>
      <ul className="potok-checks">
        <li>
          <span className="potok-checks-what">Кредитная нагрузка</span>
          {share !== null ? (
            <DebtMeter share={share} />
          ) : (
            <p className="potok-checks-text">Все платежи по кредитам вместе с новым — не больше {percent(MAX_DEBT_SHARE, 0)} выручки</p>
          )}
        </li>
        {multiplier !== undefined && (
          <li>
            <span className="potok-checks-what">Лимит по выручке</span>
            <p className="potok-checks-text">
              По продукту банк даёт до {revenueTimes(multiplier)}
              {limit !== null && <> — до {money(limit)}</>}
            </p>
            {overLimit && <p className="potok-checks-sub">Вы просите {money(amount)} — больше лимита</p>}
          </li>
        )}
        <li>
          <span className="potok-checks-what">Покрытие платежа прибылью</span>
          <p className="potok-checks-text">
            {profit !== null && profit <= 0
              ? `Расходы не меньше выручки — платёж нечем покрыть, банку нужно покрытие от ${minCoverage}`
              : coverage !== null
                ? `Прибыль покрывает платёж ${coverageTimes(coverage)}, банку нужно от ${minCoverage}`
                : `Прибыль, выручка минус расходы, должна покрывать платёж хотя бы в ${minCoverage} раза`}
          </p>
          {coverage === null && revenue > 0 && <p className="potok-checks-sub">Укажите расходы — и покрытие посчитается</p>}
        </li>
      </ul>
      {exceeded && (
        <p className="potok-checks-note">
          Скорее всего, банк предложит другие условия: меньшую сумму или срок длиннее. Отправить заявку можно и так — в
          решении банк объяснит, что и почему изменил.
        </p>
      )}
      <Text fz="sm" c="dimmed" mt="xs">
        Оценка по вашим цифрам: банк сверит их с ФНС и бюро кредитных историй.
        {product.repayment === 'interest_only' && ' Овердрафт он проверяет так, будто лимит гасится равными платежами за срок.'}
      </Text>
    </section>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="potok-review-sec" aria-labelledby={headingId}>
      <div className="potok-review-head">
        <Title order={3} id={headingId}>
          {title}
        </Title>
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
  const [active, setActive] = useState(() => resumeStep(app, products.find((p) => p.code === app.product.code) ?? products[0]));
  const [showErrors, setShowErrors] = useState(false);
  const [hasDebts, setHasDebts] = useState(() => !!app.form.finance.debt_payments);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState<'step' | 'send' | null>(null);
  const [focusInvalid, setFocusInvalid] = useState(0);
  const prefilled = useRef(false);
  const formRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const draft = useDraftSaver(app.id, { ...params, form }, savedBody(app));

  const product = products.find((p) => p.code === params.product_code) ?? products[0];
  const steps = useMemo(() => stepsFor(product), [product]);
  const step = steps[Math.min(active, steps.length - 1)];

  // Выручку и расходы подставляем из «Прозрачного бизнеса», чтобы клиенту не вводить их вручную. Только на шаге
  // «Финансы»: так выручка попадает в черновик, когда клиент её увидел, и по ней видно, докуда он дошёл.
  useEffect(() => {
    const data = financials.data;
    if (step !== 'finance' || !data?.available || prefilled.current || form.finance.monthly_revenue) return;
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
  }, [step, financials.data, form.finance.monthly_revenue]);

  // Новый шаг — фокус на его заголовок: экранный диктор прочитает, где клиент оказался.
  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Не пустили дальше — к первому полю с ошибкой: прокрутить и поставить в него фокус.
  useEffect(() => {
    if (!focusInvalid) return;
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!field) return;
    field.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    field.focus({ preventScroll: true });
  }, [focusInvalid]);

  const payment = monthlyPayment(params.amount, product.rate, params.term_months, product.repayment);
  const revenue = form.finance.monthly_revenue ?? 0;
  // Нагрузку банк считает по аннуитету и для овердрафта — так же, как в блоке «Что проверит банк».
  const servicing = servicePayment(params.amount, product.rate, params.term_months);
  const debtShare = revenue > 0 ? (servicing + (form.finance.debt_payments ?? 0)) / revenue : null;
  const productPurposes = purposes.filter((p) => product.purposes.includes(p.code));

  const errors = stepErrors(step, params, form, product);
  const err = (key: string) => (showErrors ? errors[key] : undefined);
  const blocked = () => {
    if (Object.keys(errors).length === 0) return false;
    setShowErrors(true);
    setFocusInvalid((n) => n + 1);
    return true;
  };

  const goTo = async (index: number) => {
    if (busy || (index > active && blocked())) return;
    setBusy('step');
    const saved = await draft.save();
    setBusy(null);
    if (!saved) return;
    setShowErrors(false);
    focusHeading.current = true;
    setActive(index);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  };

  const send = async () => {
    if (busy || blocked()) return;
    setBusy('send');
    // Последнее сохранение и отправка — одной очередью, без фоновых сохранений между ними.
    if (await draft.finish(() => submit.mutateAsync({ id: app.id }))) navigate(`/applications/${app.id}`);
    else setBusy(null);
  };

  // «К заявке»: сначала сохраняем правки, потом уходим. Вкладки шапки и «Назад» браузера — без ожидания, правки
  // сохраняются при уходе (useDraftSaver).
  const leave = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (await draft.flush()) navigate(`/applications/${app.id}`);
  };

  /** Правки клиента — через них, чтобы черновик сохранился сам. Без изменений (уход из поля) — не правка. */
  const editParams = (next: Params) => {
    if (JSON.stringify(next) === JSON.stringify(params)) return;
    draft.touch();
    setParams(next);
  };
  const editForm = (next: ApplicationForm) => {
    if (JSON.stringify(next) === JSON.stringify(form)) return;
    draft.touch();
    setForm(next);
  };

  const selectProduct = (p: Product) =>
    editParams({
      product_code: p.code,
      purpose: p.purposes.includes(params.purpose) ? params.purpose : p.purposes[0],
      amount: Math.min(Math.max(params.amount, p.min_amount), p.max_amount),
      term_months: Math.min(Math.max(params.term_months, p.min_term), p.max_term),
    });

  const setFinance = (key: keyof ApplicationForm['finance'], value: string | number) =>
    editForm({ ...form, finance: { ...form.finance, [key]: num(value) } });

  const setCollateral = (patch: Partial<NonNullable<ApplicationForm['collateral']>>) =>
    editForm({
      ...form,
      collateral: {
        kind: form.collateral?.kind ?? null,
        value: form.collateral?.value ?? null,
        description: form.collateral?.description ?? null,
        ...patch,
      },
    });

  const stepTitle = (text: string) => (
    <Title order={1} className="potok-wz-h" tabIndex={-1} ref={headingRef}>
      {text}
    </Title>
  );

  const company = user?.company;
  const stepNo = Math.min(active, steps.length - 1);
  const purposeTitle = purposes.find((p) => p.code === params.purpose)?.title;
  const fromFns = !!financials.data?.available;
  const indexOf = (s: StepKey) => steps.indexOf(s);
  const back = stepNo > 0 && (
    <Button variant="default" size="lg" onClick={() => goTo(active - 1)} disabled={busy !== null}>
      Назад
    </Button>
  );
  // Кнопка не выключается: без согласия на запрос в БКИ нажатие покажет ошибку у галочки и поставит на неё фокус.
  const next =
    step === 'review' ? (
      <Button size="lg" onClick={send} loading={busy === 'send'}>
        Отправить в банк
      </Button>
    ) : (
      <Button size="lg" onClick={() => goTo(active + 1)} loading={busy === 'step'}>
        Далее
      </Button>
    );

  return (
    <div className="potok-wz-page">
      <div className="potok-wz-head">
        <div>
          <Anchor component={Link} to={`/applications/${app.id}`} onClick={leave} fz="sm" c="dimmed" className="potok-back">
            <IconArrowLeft size={16} /> К заявке
          </Anchor>
          <Title order={2} mt={4}>
            Заявка на кредит
          </Title>
          <Text fz="sm" c="dimmed" mt={2}>
            Заявка {nb(app.number)}
            {/* Честный статус: «сохранён» — только когда все правки клиента уже на сервере. */}
            <span role="status" data-testid="draft-status">
              {draft.label ? ` · ${draft.label}` : ''}
            </span>
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
                По выручке, расходам и платежам банк считает, какой кредит бизнесу по силам. Проверки на этом шаге —
                те же, что банк сделает при оценке заявки.
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

        <section className="potok-panel potok-wz-form fade-in" key={step} ref={formRef}>
          <div className="potok-wz-stepno">
            Анкета: {stepNo + 1} из {steps.length}
            {mobile ? `, ${STEP_LABELS[step].toLowerCase()}` : ''}
          </div>

          {step === 'company' && company && (
            <>
              {stepTitle('Проверьте данные компании')}
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
                  onChange={(e) => editForm({ ...form, contact_name: e.currentTarget.value })}
                  error={err('contact_name')}
                  maxLength={255}
                />
                <TextInput
                  label="Должность"
                  value={form.contact_position ?? ''}
                  onChange={(e) => editForm({ ...form, contact_position: e.currentTarget.value })}
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
              {stepTitle('Какой кредит нужен')}
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
                onChange={(v) => v && editParams({ ...params, purpose: v as Purpose })}
                error={err('purpose')}
                allowDeselect={false}
              />
              <div style={{ marginTop: 24 }}>
                <AmountTermFields
                  amount={params.amount}
                  onAmount={(v) => editParams({ ...params, amount: v })}
                  term={params.term_months}
                  onTerm={(v) => editParams({ ...params, term_months: v })}
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
              {stepTitle('Финансы компании')}
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
                  if (v === 'no') editForm({ ...form, finance: { ...form.finance, debt_payments: null } });
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

              <BankChecks product={product} amount={params.amount} term={params.term_months} finance={form.finance} />
            </>
          )}

          {step === 'collateral' && (
            <>
              {stepTitle('Обеспечение')}
              <Text className="potok-note">
                Для продукта «{nb(product.name)}» нужно обеспечение: {product.collateral?.toLowerCase()}.
              </Text>
              <div className="potok-wz-row2" style={{ marginTop: 24 }}>
                <Select
                  label="Что предлагаете в залог"
                  data={COLLATERAL_KINDS}
                  value={form.collateral?.kind ?? null}
                  onChange={(v) => setCollateral({ kind: v })}
                  error={err('collateral_kind')}
                />
                <MoneyInput
                  label="Примерная стоимость"
                  value={form.collateral?.value ?? ''}
                  onChange={(v) => setCollateral({ value: num(v) })}
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
                onChange={(e) => setCollateral({ description: e.currentTarget.value })}
                maxLength={1000}
                autosize
                minRows={2}
              />
            </>
          )}

          {step === 'documents' && (
            <>
              {stepTitle('Документы')}
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
              {stepTitle('Всё верно?')}
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
                onChange={(e) => editForm({ ...form, consent_bki: e.currentTarget.checked })}
                label="Согласен на запрос кредитной истории компании в бюро кредитных историй и проверку данных в ЕГРЮЛ и ФНС"
                error={err('consent')}
                aria-invalid={!!err('consent')}
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
  // Ушли из анкеты и сразу вернулись, а черновик ещё сохраняется — открываем анкету, когда сохранение закончится,
  // иначе она начнётся с прежних данных. Пока анкета открыта, её собственные сохранения её не прячут.
  const saving = useIsMutating({ mutationKey: keys.saveApplication(applicationId) }) > 0;
  const opened = useRef<number | null>(null);

  if (query.isLoading || products.isLoading || meta.isLoading || (saving && opened.current !== applicationId)) {
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
  opened.current = applicationId;
  return <Wizard key={applicationId} app={query.data} products={products.data} purposes={meta.data.purposes} />;
}
