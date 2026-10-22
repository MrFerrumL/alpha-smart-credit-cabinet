// Типы ответов core API. Повторяют схемы из backend/app/schemas.py (см. /api/openapi.json).

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export type Purpose = 'working_capital' | 'cash_gap' | 'equipment' | 'expansion' | 'contract';

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail: string;
  errors?: { field: string; message: string }[];
}

export interface StatusInfo {
  code: string;
  title: string;
  hint: string;
  stage: number;
  tone: Tone;
  action_required: boolean;
  terminal: boolean;
}

export interface PurposeInfo {
  code: Purpose;
  title: string;
  description: string;
  icon: string;
}

export interface Meta {
  stages: string[];
  statuses: StatusInfo[];
  purposes: PurposeInfo[];
}

export interface Company {
  id: number;
  inn: string;
  name: string;
  short_name: string;
  legal_form: string;
  ogrn: string | null;
  registered_at: string | null;
  okved: string | null;
  okved_name: string | null;
  address: string | null;
  director: string | null;
}

export interface User {
  id: number;
  email: string;
  full_name: string;
  position: string;
  role: 'client' | 'analyst';
  can_sign: boolean;
  company: Company | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface DemoAccount {
  email: string;
  full_name: string;
  position: string;
  role: 'client' | 'analyst';
  company_name: string | null;
  scenario: string;
  scenario_tone: Tone;
}

export interface CompanyLookup {
  inn: string;
  name: string;
  short_name: string;
  legal_form: string;
  ogrn: string | null;
  registered_at: string | null;
  okved: string | null;
  okved_name: string | null;
  address: string | null;
  director: string | null;
  status: string;
  status_title: string;
}

export interface Product {
  code: string;
  name: string;
  tagline: string;
  min_amount: number;
  max_amount: number;
  min_term: number;
  max_term: number;
  rate: number;
  purposes: Purpose[];
  repayment: 'annuity' | 'interest_only';
  collateral: string | null;
  decision: 'auto' | 'manual';
  decision_time: string;
  documents: string[];
  highlights: string[];
}

export interface ProductMatch {
  product: Product;
  fit: 'best' | 'good' | 'partial';
  amount: number;
  term_months: number;
  monthly_payment: number;
  overpayment: number;
  reasons: string[];
  caveats: string[];
}

export interface ScheduleRow {
  n: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

export interface Calculation {
  product_code: string;
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  overpayment: number;
  total: number;
  schedule: ScheduleRow[];
}

export interface ApplicationForm {
  finance: {
    monthly_revenue: number | null;
    monthly_expenses: number | null;
    debt_payments: number | null;
    employees: number | null;
  };
  collateral: { kind: string | null; value: number | null; description: string | null } | null;
  contact_name: string | null;
  contact_position: string | null;
  comment: string | null;
}

export type ApplicationAction = 'edit' | 'submit' | 'cancel' | 'answer_tasks' | 'accept_offer' | 'sign' | 'decide';

export interface Application {
  id: number;
  number: string | null;
  status: StatusInfo;
  product: { code: string; name: string; rate: number };
  purpose: Purpose;
  purpose_title: string;
  amount: number;
  term_months: number;
  monthly_payment: number;
  form: ApplicationForm;
  company: { id: number; inn: string; name: string };
  allowed_actions: ApplicationAction[];
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  decided_at: string | null;
}

export interface ApplicationEvent {
  id: number;
  created_at: string;
  actor_type: 'client' | 'analyst' | 'system';
  actor_name: string | null;
  event: string;
  title: string;
  from_status: string | null;
  to_status: string | null;
  comment: string | null;
}
