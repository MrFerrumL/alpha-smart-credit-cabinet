import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  FileButton,
  Group,
  NumberInput,
  Paper,
  Progress,
  Select,
  SimpleGrid,
  Skeleton,
  Slider,
  Stack,
  Stepper,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconArrowRight,
  IconBuildingStore,
  IconCheck,
  IconCloudCheck,
  IconFileUpload,
  IconInfoCircle,
  IconSend,
} from '@tabler/icons-react';
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
import { PurposeIcon, Stat } from '../components/ui';
import { MAX_DEBT_SHARE, monthlyPayment } from '../lib/finance';
import { money, moneyShort, months, rate } from '../lib/format';

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

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" py={6} style={{ borderBottom: '1px solid var(--app-line)' }}>
      <Text fz="sm" c="dimmed">
        {label}
      </Text>
      <Text fz="sm" fw={600} ta="right">
        {value}
      </Text>
    </Group>
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

  return (
    <Stack gap="xl">
      <div>
        <Anchor component={Link} to={`/applications/${app.id}`} fz="sm" c="dimmed">
          <Group gap={4}>
            <IconArrowLeft size={16} /> К заявке
          </Group>
        </Anchor>
        <Group mt="sm" justify="space-between" align="flex-end">
          <div>
            <Title order={2}>Оформление заявки</Title>
            <Text c="dimmed" mt={4}>
              № {app.number} · {product.name}
            </Text>
          </div>
          {savedAt && (
            <Group gap={6}>
              <IconCloudCheck size={18} color="var(--mantine-color-teal-6)" />
              <Text fz="sm" c="dimmed">
                Черновик сохранён
              </Text>
            </Group>
          )}
        </Group>
      </div>

      {mobile ? (
        <div>
          <Text fz="sm" fw={700}>
            Шаг {active + 1} из {steps.length} · {STEP_LABELS[step]}
          </Text>
          <Progress value={((active + 1) / steps.length) * 100} mt="xs" radius="xl" />
        </div>
      ) : (
        <Card p="lg">
          <Stepper active={active} onStepClick={(i) => (i < active ? void goTo(i) : undefined)} size="sm" allowNextStepsSelect={false}>
            {steps.map((s) => (
              <Stepper.Step key={s} label={STEP_LABELS[s]} />
            ))}
          </Stepper>
        </Card>
      )}

      <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" key={step}>
        {step === 'company' && company && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Проверьте данные компании</Title>
              <Text c="dimmed" mt={4}>
                Мы получили их из ЕГРЮЛ — вводить ничего не нужно.
              </Text>
            </div>
            <Paper bg="gray.0" p="lg" radius="md">
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon size={42} radius="md" variant="light">
                  <IconBuildingStore size={22} />
                </ThemeIcon>
                <div style={{ flex: 1 }}>
                  <Group gap="xs">
                    <Text fw={800}>{company.short_name}</Text>
                    <Badge color="teal" variant="light" size="sm">
                      из ЕГРЮЛ
                    </Badge>
                  </Group>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm" spacing="xs">
                    <Text fz="sm">ИНН {company.inn}</Text>
                    {company.ogrn && <Text fz="sm">ОГРН {company.ogrn}</Text>}
                    {company.okved && (
                      <Text fz="sm">
                        ОКВЭД {company.okved} — {company.okved_name}
                      </Text>
                    )}
                    {company.director && <Text fz="sm">Руководитель: {company.director}</Text>}
                  </SimpleGrid>
                </div>
              </Group>
            </Paper>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Контактное лицо"
                value={form.contact_name ?? ''}
                onChange={(e) => setForm({ ...form, contact_name: e.currentTarget.value })}
                error={err('contact_name')}
                withAsterisk
              />
              <TextInput
                label="Должность"
                value={form.contact_position ?? ''}
                onChange={(e) => setForm({ ...form, contact_position: e.currentTarget.value })}
              />
            </SimpleGrid>
            {!user?.can_sign && (
              <Alert icon={<IconInfoCircle />} color="blue" variant="light" radius="md">
                Вы можете заполнить и отправить заявку. Подписать договор сможет только руководитель компании.
              </Alert>
            )}
          </Stack>
        )}

        {step === 'params' && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Какой кредит нужен</Title>
              <Text c="dimmed" mt={4}>
                Можно поменять продукт — сумма и срок подстроятся под его условия.
              </Text>
            </div>
            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
              {products.map((p) => (
                <UnstyledButton key={p.code} onClick={() => selectProduct(p)}>
                  <Paper
                    className="selectable clickable"
                    data-selected={p.code === product.code}
                    p="md"
                    h="100%"
                    bg={p.code === product.code ? undefined : 'gray.0'}
                  >
                    <Text fw={800}>{p.name}</Text>
                    <Text fz="xs" c="dimmed" mt={2}>
                      от {rate(p.rate)} · {p.decision_time}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {moneyShort(p.min_amount)} – {moneyShort(p.max_amount)}
                    </Text>
                  </Paper>
                </UnstyledButton>
              ))}
            </SimpleGrid>
            <Select
              label="Цель кредита"
              data={productPurposes.map((p) => ({ value: p.code, label: p.title }))}
              value={params.purpose}
              onChange={(v) => v && setParams({ ...params, purpose: v as Purpose })}
              leftSection={<PurposeIcon name={purposes.find((p) => p.code === params.purpose)?.icon ?? 'boxes'} size={18} />}
              error={err('purpose')}
              allowDeselect={false}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xl">
              <NumberInput
                label="Сумма"
                value={params.amount}
                onChange={(v) => setParams({ ...params, amount: num(v) ?? 0 })}
                min={product.min_amount}
                max={product.max_amount}
                step={50_000}
                thousandSeparator=" "
                suffix=" ₽"
                allowNegative={false}
                allowDecimal={false}
                description={`от ${moneyShort(product.min_amount)} до ${moneyShort(product.max_amount)}`}
                error={err('amount')}
              />
              <div>
                <Text fz="sm" fw={500}>
                  Срок: {months(params.term_months)}
                </Text>
                {product.min_term === product.max_term ? (
                  <Text fz="xs" c="dimmed" mt={6}>
                    Лимит открывается на {product.min_term} месяцев и продлевается
                  </Text>
                ) : (
                  <Slider
                    mt="md"
                    min={product.min_term}
                    max={product.max_term}
                    step={product.min_term >= 12 ? 6 : 3}
                    value={params.term_months}
                    onChange={(v) => setParams({ ...params, term_months: v })}
                    label={(v) => months(v)}
                  />
                )}
              </div>
            </SimpleGrid>
            <Paper bg="brand.0" p="md" radius="md">
              <Group justify="space-between">
                <Text fz="sm">
                  {product.repayment === 'interest_only' ? 'Проценты в месяц при полном использовании' : 'Ежемесячный платёж'}
                </Text>
                <Text fz="xl" fw={800} c="brand.6">
                  ≈ {money(payment)}
                </Text>
              </Group>
            </Paper>
          </Stack>
        )}

        {step === 'finance' && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Финансы компании</Title>
              <Text c="dimmed" mt={4}>
                Примерные цифры за последние полгода — по ним банк посчитает комфортный платёж.
              </Text>
            </div>
            {financials.data?.available ? (
              <Alert icon={<IconCheck />} color="teal" variant="light" radius="md">
                Заполнили выручку и расходы по данным ФНС за {financials.data.reporting_year} год. Проверьте и при
                необходимости поправьте.
              </Alert>
            ) : financials.data ? (
              <Alert icon={<IconInfoCircle />} color="orange" variant="light" radius="md">
                В налоговой нет данных о выручке компании. Укажите её сами — банк может попросить выписку, чтобы
                подтвердить цифры. Можно сразу приложить её на шаге «Документы».
              </Alert>
            ) : null}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                label="Выручка в месяц"
                value={form.finance.monthly_revenue ?? ''}
                onChange={(v) => setFinance('monthly_revenue', v)}
                thousandSeparator=" "
                suffix=" ₽"
                allowNegative={false}
                allowDecimal={false}
                error={err('monthly_revenue')}
                withAsterisk
              />
              <NumberInput
                label="Расходы в месяц"
                value={form.finance.monthly_expenses ?? ''}
                onChange={(v) => setFinance('monthly_expenses', v)}
                thousandSeparator=" "
                suffix=" ₽"
                allowNegative={false}
                allowDecimal={false}
              />
              <NumberInput
                label="Платежи по текущим кредитам в месяц"
                description="Если кредитов нет — оставьте пустым"
                value={form.finance.debt_payments ?? ''}
                onChange={(v) => setFinance('debt_payments', v)}
                thousandSeparator=" "
                suffix=" ₽"
                allowNegative={false}
                allowDecimal={false}
              />
              <NumberInput
                label="Сотрудников"
                description="Включая вас"
                value={form.finance.employees ?? ''}
                onChange={(v) => setFinance('employees', v)}
                allowNegative={false}
                allowDecimal={false}
              />
            </SimpleGrid>
            {debtShare !== null && (
              <Paper p="md" radius="md" bg={debtShare <= MAX_DEBT_SHARE ? 'teal.0' : 'orange.0'}>
                <Text fz="sm">
                  С новым кредитом все платежи по кредитам займут <b>{Math.round(debtShare * 100)}%</b> выручки.{' '}
                  {debtShare <= MAX_DEBT_SHARE
                    ? 'Это комфортная нагрузка.'
                    : 'Это больше половины — банк, скорее всего, предложит меньшую сумму или больший срок.'}
                </Text>
              </Paper>
            )}
          </Stack>
        )}

        {step === 'collateral' && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Обеспечение</Title>
              <Text c="dimmed" mt={4}>
                Для продукта «{product.name}» нужно обеспечение: {product.collateral?.toLowerCase()}.
              </Text>
            </div>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="Что предлагаете в залог"
                data={COLLATERAL_KINDS}
                value={form.collateral?.kind ?? null}
                onChange={(v) =>
                  setForm({ ...form, collateral: { kind: v, value: form.collateral?.value ?? null, description: form.collateral?.description ?? null } })
                }
                error={err('collateral_kind')}
                withAsterisk
              />
              <NumberInput
                label="Примерная стоимость"
                value={form.collateral?.value ?? ''}
                onChange={(v) =>
                  setForm({ ...form, collateral: { kind: form.collateral?.kind ?? null, value: num(v), description: form.collateral?.description ?? null } })
                }
                thousandSeparator=" "
                suffix=" ₽"
                allowNegative={false}
                allowDecimal={false}
                error={err('collateral_value')}
                withAsterisk
              />
            </SimpleGrid>
            <Textarea
              label="Описание"
              placeholder="Например: станок ЧПУ 2022 года, приобретается на кредитные средства"
              value={form.collateral?.description ?? ''}
              onChange={(e) =>
                setForm({ ...form, collateral: { kind: form.collateral?.kind ?? null, value: form.collateral?.value ?? null, description: e.currentTarget.value } })
              }
              autosize
              minRows={2}
            />
          </Stack>
        )}

        {step === 'documents' && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Документы</Title>
              <Text c="dimmed" mt={4}>
                Необязательно, но с документами решение будет быстрее: банку не придётся их запрашивать.
              </Text>
            </div>
            <Stack gap="sm">
              {product.documents.map((title) => {
                const kind = documentKind(title);
                const uploaded = documents.data?.filter((d) => d.kind === kind) ?? [];
                return (
                  <Paper key={title} withBorder p="md" radius="md">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon color={uploaded.length ? 'teal' : 'gray'} variant="light" radius="xl" size={30}>
                          {uploaded.length ? <IconCheck size={16} /> : <IconFileUpload size={16} />}
                        </ThemeIcon>
                        <Text fz="sm" fw={600}>
                          {title}
                        </Text>
                      </Group>
                      <FileButton
                        onChange={(file) => file && upload.mutate({ file, kind })}
                        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.doc,.docx,.txt"
                      >
                        {(props) => (
                          <Button {...props} variant="light" size="xs" loading={upload.isPending && upload.variables?.kind === kind}>
                            {uploaded.length ? 'Добавить ещё' : 'Загрузить'}
                          </Button>
                        )}
                      </FileButton>
                    </Group>
                    {uploaded.length > 0 && (
                      <div style={{ marginTop: 10, marginLeft: 42 }}>
                        <DocumentList documents={uploaded} />
                      </div>
                    )}
                  </Paper>
                );
              })}
            </Stack>
            <Text fz="xs" c="dimmed">
              PDF, изображения, Excel или Word до 10 МБ.
            </Text>
          </Stack>
        )}

        {step === 'review' && (
          <Stack gap="lg">
            <div>
              <Title order={3}>Всё верно?</Title>
              <Text c="dimmed" mt={4}>
                После отправки изменить заявку будет нельзя. Статус обновится сам — следить можно в кабинете.
              </Text>
            </div>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xl">
              <div>
                <Text fw={700} mb={4}>
                  Кредит
                </Text>
                <SummaryRow label="Продукт" value={product.name} />
                <SummaryRow label="Цель" value={purposes.find((p) => p.code === params.purpose)?.title} />
                <SummaryRow label="Сумма" value={money(params.amount)} />
                <SummaryRow label="Срок" value={months(params.term_months)} />
                <SummaryRow label="Платёж" value={`≈ ${money(payment)}`} />
              </div>
              <div>
                <Text fw={700} mb={4}>
                  Компания и финансы
                </Text>
                <SummaryRow label="Компания" value={company?.short_name} />
                <SummaryRow label="Контактное лицо" value={form.contact_name} />
                <SummaryRow label="Выручка в месяц" value={money(revenue)} />
                {form.finance.debt_payments ? (
                  <SummaryRow label="Платежи по кредитам" value={money(form.finance.debt_payments)} />
                ) : null}
                <SummaryRow label="Документы" value={documents.data?.length ? `${documents.data.length} шт.` : 'не приложены'} />
              </div>
            </SimpleGrid>
            <Paper withBorder p="md" radius="md">
              <Checkbox
                checked={form.consent_bki}
                onChange={(e) => setForm({ ...form, consent_bki: e.currentTarget.checked })}
                label="Согласен на запрос кредитной истории компании в бюро кредитных историй и проверку данных в ЕГРЮЛ и ФНС"
                error={err('consent')}
              />
            </Paper>
            <Group gap="xs">
              <Stat label="Решение" value={product.decision === 'auto' ? product.decision_time : `специалист, ${product.decision_time}`} />
            </Group>
          </Stack>
        )}
      </Card>

      <Group justify="space-between">
        <Button
          variant="default"
          leftSection={<IconArrowLeft size={18} />}
          onClick={() => goTo(active - 1)}
          disabled={active === 0}
        >
          Назад
        </Button>
        {step === 'review' ? (
          <Button size="md" leftSection={<IconSend size={18} />} onClick={send} loading={submit.isPending || update.isPending}>
            Отправить в банк
          </Button>
        ) : (
          <Button size="md" rightSection={<IconArrowRight size={18} />} onClick={() => goTo(active + 1)} loading={update.isPending}>
            Далее
          </Button>
        )}
      </Group>
    </Stack>
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
        <Skeleton h={40} w={320} />
        <Skeleton h={80} radius="lg" />
        <Skeleton h={360} radius="lg" />
      </Stack>
    );
  }
  if (!query.data || !products.data || !meta.data) return <Navigate to="/applications" replace />;
  if (query.data.status.code !== 'draft') return <Navigate to={`/applications/${applicationId}`} replace />;
  return <Wizard app={query.data} products={products.data} purposes={meta.data.purposes} />;
}
