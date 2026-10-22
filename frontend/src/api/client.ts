import type { Problem } from './types';

const TOKEN_KEY = 'credit.token';

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* приватный режим браузера — сессия живёт до перезагрузки */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly errors: Problem['errors'];

  constructor(status: number, body: Partial<Problem> | null) {
    super(body?.detail ?? 'Не удалось выполнить запрос');
    this.status = status;
    this.code = body?.code ?? 'network_error';
    this.title = body?.title ?? 'Ошибка';
    this.errors = body?.errors;
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

type RequestOptions = Omit<RequestInit, 'body'> & { json?: unknown; form?: FormData };

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { json, form, headers: rawHeaders, ...rest } = options;
  const headers = new Headers(rawHeaders);
  const token = tokenStore.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body: BodyInit | undefined;
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // Content-Type с границей multipart браузер проставит сам
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...rest, headers, body });
  } catch {
    throw new ApiError(0, { title: 'Нет связи с сервером', detail: 'Проверьте подключение и попробуйте ещё раз.' });
  }

  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && token) onUnauthorized?.();
    throw new ApiError(response.status, data);
  }
  return data as T;
}

/** Уникальный ключ запроса (Idempotency-Key). crypto.randomUUID есть только в защищённом контексте (https/localhost). */
export function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
