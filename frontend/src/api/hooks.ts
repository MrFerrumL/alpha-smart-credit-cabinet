import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, ApiError, requestId } from './client';
import type {
  Application,
  ApplicationEvent,
  Calculation,
  Company,
  CompanyLookup,
  DemoAccount,
  Meta,
  Product,
  ProductMatch,
  Purpose,
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
    // Пока заявка идёт по конвейеру, статус обновляется сам.
    refetchInterval: (query) => (isMoving(query.state.data) ? ACTIVE_POLL_MS : false),
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

function useApplicationAction(action: 'submit' | 'cancel') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      api<Application>(`/applications/${id}/${action}`, {
        method: 'POST',
        headers: action === 'submit' ? { 'Idempotency-Key': requestId() } : undefined,
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
