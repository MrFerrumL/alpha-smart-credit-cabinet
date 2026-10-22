import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, ApiError, requestId } from './client';
import type {
  AppNotification,
  Application,
  ApplicationEvent,
  Calculation,
  ClientTask,
  Company,
  CompanyLookup,
  Contract,
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

export const keys = {
  meta: ['meta'] as const,
  products: ['products'] as const,
  applications: (status?: string) => ['applications', status ?? 'all'] as const,
  application: (id: number) => ['application', id] as const,
  events: (id: number) => ['application', id, 'events'] as const,
};

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: () => api<Meta>('/meta'), staleTime: Infinity });
}

export function useProducts() {
  return useQuery({ queryKey: keys.products, queryFn: () => api<Product[]>('/products'), staleTime: Infinity });
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

export function useApplications(status?: string) {
  return useQuery({
    queryKey: keys.applications(status),
    queryFn: () => api<Application[]>(status ? `/applications?status=${status}` : '/applications'),
    refetchInterval: (query) => (query.state.data?.some(isMoving) ? ACTIVE_POLL_MS : false),
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

export function useEvents(id: number, app?: Application) {
  return useQuery({
    queryKey: [...keys.events(id), app?.status.code],
    queryFn: () => api<ApplicationEvent[]>(`/applications/${id}/events`),
    enabled: !!app,
  });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { product_code: string; purpose: Purpose; amount: number; term_months: number }) =>
      api<Application>('/applications', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['applications'] }),
    onError: notifyError,
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
    onError: notifyError,
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
  return useMutation({
    mutationFn: (body: Partial<ApplicationUpdate>) =>
      api<Application>(`/applications/${id}`, { method: 'PATCH', json: body }),
    onSuccess: (app) => qc.setQueryData(keys.application(app.id), app),
    onError: notifyError,
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
  return useMutation({
    mutationFn: ({ file, kind, taskId }: { file: File; kind: string; taskId?: number }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      if (taskId !== undefined) form.append('task_id', String(taskId));
      return api<UploadedDocument>(`/applications/${id}/documents`, { method: 'POST', form });
    },
    onSuccess: invalidate,
    onError: notifyError,
  });
}

export function useAnswerTask(id: number) {
  const invalidate = useInvalidateApplication(id);
  return useMutation({
    mutationFn: ({ taskId, answer }: { taskId: number; answer: string }) =>
      api<ClientTask>(`/applications/${id}/tasks/${taskId}/answer`, { method: 'POST', json: { answer } }),
    onSuccess: invalidate,
    onError: notifyError,
  });
}

// --- Предложение, договор, подписание ----------------------------------------------------------

function useApplicationMutation<TVars>(id: number, request: (vars: TVars) => Promise<Application>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (app) => {
      qc.setQueryData(keys.application(app.id), app);
      qc.invalidateQueries({ queryKey: ['application', id] });
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: notifyError,
  });
}

export const useAcceptOffer = (id: number) =>
  useApplicationMutation<void>(id, () => api<Application>(`/applications/${id}/offer/accept`, { method: 'POST' }));

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
  return useMutation({
    mutationFn: () => api<SigningCode>(`/applications/${id}/signing/code`, { method: 'POST' }),
    // Код приходит в уведомления кабинета — сразу подтягиваем их, не дожидаясь опроса.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: notifyError,
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
  });
}

// --- Кредиты и уведомления ---------------------------------------------------------------------

export function useLoans(enabled = true) {
  return useQuery({ queryKey: ['loans'], queryFn: () => api<Loan[]>('/loans'), enabled });
}

export function useLoan(id: number) {
  return useQuery({ queryKey: ['loans', id], queryFn: () => api<LoanDetail>(`/loans/${id}`) });
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
