import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, ApiError, health, requestId } from './client';
import type {
  PolicySimulation,
  Replay,
  FeedItem,
  AnalystDecision,
  HealthDeps,
  SystemJob,
  Assessment,
  ApplicationRisk,
  AppNotification,
  Application,
  ApplicationEvent,
  ApprovalMap,
  Calculation,
  ClientTask,
  Company,
  CompanyLookup,
  Contract,
  DecisionExplanation,
  DemoAccount,
  Financials,
  Loan,
  LoanDetail,
  Meta,
  Product,
  ProductMatch,
  Purpose,
  SigningCode,
  SourceCheck,
  UploadedDocument,
} from './types';

export function notifyError(error: unknown) {
  const e = error instanceof ApiError ? error : new ApiError(0, null);
  notifications.show({
    color: 'red',
    title: e.title,
    message: e.errors?.length ? e.errors.map((x) => x.message).join('. ') : e.message,
  });
}

/** 409: экран отстал от сервера — перечитываем заявку и список, чтобы он показал актуальное состояние. */
function refreshOnConflict(qc: QueryClient, error: unknown, id?: number) {
  if (!(error instanceof ApiError) || error.status !== 409) return;
  qc.invalidateQueries({ queryKey: id === undefined ? ['application'] : ['application', id] });
  qc.invalidateQueries({ queryKey: ['applications'] });
}

/** Общий onError действий по заявке: показать ошибку и на 409 обновить экран. */
function useActionError(id?: number) {
  const qc = useQueryClient();
  return (error: unknown, applicationId: number | undefined = id) => {
    notifyError(error);
    refreshOnConflict(qc, error, applicationId);
  };
}

export const keys = {
  meta: ['meta'] as const,
  products: ['products'] as const,
  applications: (status?: string) => ['applications', status ?? 'all'] as const,
  application: (id: number) => ['application', id] as const,
  /** Ключ сохранения черновика (мутация): анкета ждёт его, прежде чем открыться снова. */
  saveApplication: (id: number) => ['application', id, 'save'] as const,
  events: (id: number) => ['application', id, 'events'] as const,
  explanation: (id: number, decidedAt: string | null) => ['application', id, 'explanation', decidedAt] as const,
};

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: () => api<Meta>('/meta'), staleTime: Infinity });
}

export function useProducts() {
  return useQuery({ queryKey: keys.products, queryFn: () => api<Product[]>('/products'), staleTime: Infinity });
}

/** У овердрафта каждый месяц платятся только проценты, а основной долг возвращается в конце срока. */
export function useInterestOnly(code: string | undefined): boolean {
  const products = useProducts();
  return products.data?.find((p) => p.code === code)?.repayment === 'interest_only';
}

export function useDemoAccounts() {
  return useQuery({ queryKey: ['demo-accounts'], queryFn: () => api<DemoAccount[]>('/auth/demo-accounts') });
}

export function useMatch(params: { purpose: Purpose | null; amount: number; term_months: number }) {
  return useQuery({
    queryKey: ['match', params],
    queryFn: () => api<ProductMatch[]>('/products/match', { method: 'POST', json: params }),
    enabled: params.purpose !== null && params.amount > 0,
    placeholderData: keepPreviousData,
  });
}

export function useCalculation(code: string | null, amount: number, term: number) {
  return useQuery({
    queryKey: ['calc', code, amount, term],
    queryFn: () => api<Calculation>(`/products/${code}/calculate?amount=${amount}&term_months=${term}`),
    enabled: code !== null,
  });
}

const ACTIVE_POLL_MS = 3000;
const FALLBACK_POLL_MS = 10000;

function isMoving(app: Application | undefined) {
  return !!app && !app.status.terminal && app.status.code !== 'draft' && !app.status.action_required;
}

/** live — опрашивать всегда (очередь аналитика: новые заявки появляются без перезагрузки). */
export function useApplications(status?: string, live = false) {
  return useQuery({
    queryKey: keys.applications(status),
    queryFn: () => api<Application[]>(status ? `/applications?status=${status}` : '/applications'),
    refetchInterval: (query) => (live || query.state.data?.some(isMoving) ? ACTIVE_POLL_MS : false),
  });
}

export function useApplication(id: number) {
  return useQuery({
    queryKey: keys.application(id),
    queryFn: () => api<Application>(`/applications/${id}`),
    // Живой статус приходит потоком (useApplicationStream); опрос — запасной вариант, если поток оборвался.
    refetchInterval: (query) => (isMoving(query.state.data) ? FALLBACK_POLL_MS : false),
  });
}

/**
 * Пока запрос с новым ключом (сменился статус заявки) загружается, показываем прежние данные той же заявки:
 * иначе блок на мгновение пропадает, и, например, недописанный ответ на условие выдачи теряется.
 */
function sameApplication<T>(id: number) {
  return (previous: T | undefined, query?: { queryKey: readonly unknown[] }) =>
    query?.queryKey[1] === id ? previous : undefined;
}

export function useEvents(id: number, app?: Application, enabled = true) {
  return useQuery({
    queryKey: [...keys.events(id), app?.status.code],
    queryFn: () => api<ApplicationEvent[]>(`/applications/${id}/events`),
    enabled: !!app && enabled,
    placeholderData: sameApplication<ApplicationEvent[]>(id),
  });
}

const EXPLAINED_STATUSES = ['approved', 'counter_offer', 'rejected'];
const EXPLANATION_POLL_MS = 2500;

/**
 * Пояснение решения простыми словами. Запрос уходит, только если функция включена на сервере (meta.llm_explanation)
 * и по заявке есть решение: одобрение, контрпредложение или отказ. Пока текст готовится (pending) — опрос.
 */
export function useDecisionExplanation(app: Application) {
  const meta = useMeta();
  return useQuery({
    queryKey: keys.explanation(app.id, app.decided_at),
    queryFn: () => api<DecisionExplanation>(`/applications/${app.id}/explanation`),
    enabled: meta.data?.llm_explanation === true && EXPLAINED_STATUSES.includes(app.status.code),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? EXPLANATION_POLL_MS : false),
    retry: false,
  });
}

/**
 * Сколько банк одобрит по тому же продукту на каждом сроке. Решение по заявке уже принято и не меняется, поэтому
 * карта запрашивается один раз на решение (ключ — время решения).
 */
export function useApprovalMap(app: Application, enabled: boolean) {
  return useQuery({
    queryKey: ['application', app.id, 'approval-map', app.decided_at],
    queryFn: () => api<ApprovalMap>(`/applications/${app.id}/approval-map`),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  const failed = useActionError();
  return useMutation({
    mutationFn: (body: {
      product_code: string;
      purpose: Purpose;
      amount: number;
      term_months: number;
      /** Анкета новой заявки — например, из прежней, чтобы не заполнять её заново. */
      form?: Application['form'];
    }) => api<Application>('/applications', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['applications'] }),
    onError: (error) => failed(error),
  });
}

// Один ключ идемпотентности на заявку: повтор после сетевой ошибки отправляет тот же ключ, и сервер вернёт
// уже отправленную заявку вместо 409. Одновременные запросы дополнительно отсекает блокировка версии заявки.
const submitKeys = new Map<number, string>();

function submitKey(id: number): string {
  let key = submitKeys.get(id);
  if (!key) {
    key = requestId();
    submitKeys.set(id, key);
  }
  return key;
}

function useApplicationAction(action: 'submit' | 'cancel') {
  const qc = useQueryClient();
  const failed = useActionError();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      api<Application>(`/applications/${id}/${action}`, {
        method: 'POST',
        headers: action === 'submit' ? { 'Idempotency-Key': submitKey(id) } : undefined,
        json: action === 'cancel' ? { comment: comment ?? null } : undefined,
      }),
    onSuccess: (app) => {
      qc.setQueryData(keys.application(app.id), app);
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: keys.events(app.id) });
    },
    onError: (error, { id }) => failed(error, id),
  });
}

export const useSubmitApplication = () => useApplicationAction('submit');
export const useCancelApplication = () => useApplicationAction('cancel');

export function useCompanyLookup() {
  return useMutation({
    mutationFn: (inn: string) => api<CompanyLookup>(`/companies/lookup?inn=${inn}`),
  });
}

export function useLinkCompany() {
  return useMutation({
    mutationFn: (inn: string) => api<Company>('/companies/link', { method: 'POST', json: { inn } }),
    onError: notifyError,
  });
}

export function useTasks(id: number, app?: Application) {
  return useQuery({
    queryKey: ['application', id, 'tasks', app?.status.code, app?.open_tasks],
    queryFn: () => api<ClientTask[]>(`/applications/${id}/tasks`),
    enabled: !!app && app.status.code !== 'draft',
    placeholderData: sameApplication<ClientTask[]>(id),
  });
}

export function useDocuments(id: number, enabled = true) {
  return useQuery({
    queryKey: ['application', id, 'documents'],
    queryFn: () => api<UploadedDocument[]>(`/applications/${id}/documents`),
    enabled,
  });
}

export function useChecks(id: number, app?: Application) {
  return useQuery({
    queryKey: ['application', id, 'checks', app?.status.code],
    queryFn: () => api<SourceCheck[]>(`/applications/${id}/checks`),
    enabled: !!app && app.status.code !== 'draft' && app.status.code !== 'submitted',
    placeholderData: sameApplication<SourceCheck[]>(id),
  });
}

export function useFinancials(enabled: boolean) {
  return useQuery({
    queryKey: ['financials'],
    queryFn: () => api<Financials>('/companies/me/financials'),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}

export interface ApplicationUpdate {
  product_code: string;
  purpose: Purpose;
  amount: number;
  term_months: number;
  form: Application['form'];
}

export function useUpdateApplication(id: number) {
  const qc = useQueryClient();
  const failed = useActionError(id);
  return useMutation({
    mutationKey: keys.saveApplication(id),
    mutationFn: (body: Partial<ApplicationUpdate>) =>
      api<Application>(`/applications/${id}`, { method: 'PATCH', json: body }),
    onSuccess: (app) => qc.setQueryData(keys.application(app.id), app),
    onError: (error) => failed(error),
  });
}

function useInvalidateApplication(id: number) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['application', id] });
    qc.invalidateQueries({ queryKey: ['applications'] });
  };
}

export function useUploadDocument(id: number) {
  const invalidate = useInvalidateApplication(id);
  const failed = useActionError(id);
  return useMutation({
    mutationFn: ({ file, kind, taskId }: { file: File; kind: string; taskId?: number }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      if (taskId !== undefined) form.append('task_id', String(taskId));
      return api<UploadedDocument>(`/applications/${id}/documents`, { method: 'POST', form });
    },
    onSuccess: invalidate,
    onError: (error) => failed(error),
  });
}

export function useAnswerTask(id: number) {
  const invalidate = useInvalidateApplication(id);
  const failed = useActionError(id);
  return useMutation({
    mutationFn: ({ taskId, answer }: { taskId: number; answer: string }) =>
      api<ClientTask>(`/applications/${id}/tasks/${taskId}/answer`, { method: 'POST', json: { answer } }),
    onSuccess: invalidate,
    onError: (error) => failed(error),
  });
}

// --- Предложение, договор, подписание ----------------------------------------------------------

function useApplicationMutation<TVars>(id: number, request: (vars: TVars) => Promise<Application>) {
  const qc = useQueryClient();
  const failed = useActionError(id);
  return useMutation({
    mutationFn: request,
    onSuccess: (app) => {
      qc.setQueryData(keys.application(app.id), app);
      qc.invalidateQueries({ queryKey: ['application', id] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => failed(error),
  });
}

export const useAcceptOffer = (id: number) =>
  useApplicationMutation<void>(id, () => api<Application>(`/applications/${id}/offer/accept`, { method: 'POST' }));

export const useHandoffOffer = (id: number) =>
  useApplicationMutation<void>(id, () => api<Application>(`/applications/${id}/offer/handoff`, { method: 'POST' }));

export const useDeclineOffer = (id: number) =>
  useApplicationMutation<{ comment?: string }>(id, ({ comment }) =>
    api<Application>(`/applications/${id}/offer/decline`, { method: 'POST', json: { comment: comment ?? null } }),
  );

export function useContract(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ['application', id, 'contract'],
    queryFn: () => api<Contract>(`/applications/${id}/contract`),
    enabled,
  });
}

export function useRequestSigningCode(id: number) {
  const qc = useQueryClient();
  const failed = useActionError(id);
  return useMutation({
    mutationFn: () => api<SigningCode>(`/applications/${id}/signing/code`, { method: 'POST' }),
    // Код показывается в окне подписания; в уведомлениях — только напоминание, что код готов.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (error) => failed(error),
  });
}

export function useConfirmSigning(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { challenge_id: number; code: string }) =>
      api<Application>(`/applications/${id}/signing/confirm`, { method: 'POST', json: body }),
    onSuccess: (app) => {
      qc.setQueryData(keys.application(app.id), app);
      qc.invalidateQueries({ queryKey: ['application', id] });
    },
    // Текст ошибки показывает окно подписания; здесь только обновляем экран.
    onError: (error) => refreshOnConflict(qc, error, id),
  });
}

// --- Кредиты и уведомления ---------------------------------------------------------------------

export function useLoans(enabled = true) {
  return useQuery({ queryKey: ['loans'], queryFn: () => api<Loan[]>('/loans'), enabled });
}

export function useLoan(id: number, enabled = true) {
  return useQuery({ queryKey: ['loans', id], queryFn: () => api<LoanDetail>(`/loans/${id}`), enabled });
}

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<AppNotification[]>('/notifications'),
    enabled,
    refetchInterval: 10_000,
  });
}

export function useReadAllNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

// --- Кабинет аналитика ---------------------------------------------------------------------

export function useAssessment(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ['application', id, 'assessment'],
    queryFn: () => api<Assessment>(`/applications/${id}/assessment`),
    enabled,
  });
}

export function useApplicationRisk(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ['application', id, 'ml-risk'],
    queryFn: () => api<ApplicationRisk>(`/applications/${id}/ml-risk`),
    enabled,
    retry: false,
  });
}

export function useAnalystDecision(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AnalystDecision) => api<Application>(`/applications/${id}/decision`, { method: 'POST', json: body }),
    onSuccess: (app) => {
      qc.setQueryData(keys.application(app.id), app);
      qc.invalidateQueries({ queryKey: ['application', id] });
      qc.invalidateQueries({ queryKey: ['applications'] });
    },
    // Текст ошибки показывает панель решения; здесь только обновляем экран.
    onError: (error) => refreshOnConflict(qc, error, id),
  });
}

/** Лента новостей; version — снимок статусов заявок, чтобы лента пересчитывалась при их смене. */
export function useFeed(version: string) {
  return useQuery({ queryKey: ['feed', version], queryFn: () => api<FeedItem[]>('/feed'), placeholderData: keepPreviousData });
}

export function useReplay(id: number) {
  return useMutation({ mutationFn: () => api<Replay>(`/applications/${id}/assessment/replay`, { method: 'POST' }) });
}

export function usePolicySimulation() {
  return useMutation({
    mutationFn: (body: { max_dsr: number; min_coverage: number }) =>
      api<PolicySimulation>('/policy/simulate', { method: 'POST', json: body }),
  });
}

// --- Состояние системы ---------------------------------------------------------------------

/** Страница «Состояние системы» обновляется сама с этим шагом. */
export const SYSTEM_POLL_MS = 5000;

export function useHealthDeps() {
  return useQuery({ queryKey: ['system', 'deps'], queryFn: () => health<HealthDeps>('/deps'), refetchInterval: SYSTEM_POLL_MS });
}

export function useSystemJobs(limit = 10) {
  return useQuery({
    queryKey: ['system', 'jobs', limit],
    queryFn: () => api<SystemJob[]>(`/system/jobs?limit=${limit}`),
    refetchInterval: SYSTEM_POLL_MS,
  });
}
