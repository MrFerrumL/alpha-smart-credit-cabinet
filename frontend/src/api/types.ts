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
  consent_bki: boolean;
}

export type ApplicationAction =
  | 'edit'
  | 'submit'
  | 'cancel'
  | 'answer_tasks'
  | 'accept_offer'
  | 'decline_offer'
  | 'sign'
  | 'decide';

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
  offer: Offer | null;
  decision: Decision | null;
  open_tasks: number;
  loan_id: number | null;
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

export interface Offer {
  id: number;
  kind: 'approved' | 'counter';
  product_code: string;
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  explanation: string[];
  status: 'active' | 'accepted' | 'signed' | 'declined' | 'expired';
  valid_until: string | null;
  contract_number: string | null;
  signed_at: string | null;
}

export interface Decision {
  outcome: string;
  reasons: string[];
  tips: string[];
}

export interface ClientTask {
  id: number;
  kind: 'document' | 'field' | 'question';
  title: string;
  description: string | null;
  status: 'open' | 'done';
  answer: string | null;
  payload: { document_kind?: string; field?: string; input?: string } | null;
  created_at: string;
  resolved_at: string | null;
}

export interface UploadedDocument {
  id: number;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

export interface SourceCheck {
  source: 'egrul' | 'fns' | 'bki';
  title: string;
  status: 'ok' | 'failed' | 'pending';
  attempts: number;
}

export interface Financials {
  available: boolean;
  reporting_year: number | null;
  revenue_monthly: number | null;
  expenses_monthly: number | null;
  employees: number | null;
  tax_regime: string | null;
}

export interface StreamSnapshot {
  status: string;
  title: string;
  tone: Tone;
  terminal: boolean;
  last_event_id: number;
  open_tasks: number;
}

export interface ContractSection {
  title: string;
  paragraphs: string[];
}

export interface Contract {
  number: string;
  date: string;
  bank_name: string;
  company_name: string;
  company_inn: string;
  product_name: string;
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  total_payments: number;
  sections: ContractSection[];
  schedule: ScheduleRow[];
  signed: boolean;
  signed_at: string | null;
  signed_by: string | null;
}

export interface SigningCode {
  challenge_id: number;
  expires_at: string;
  attempts_left: number;
  delivery: 'in_app';
}

export interface Loan {
  id: number;
  application_id: number;
  contract_number: string;
  product_code: string;
  product_name: string;
  amount: number;
  rate: number;
  term_months: number;
  monthly_payment: number;
  issued_at: string;
  status: 'active' | 'closed';
  next_payment_date: string | null;
  next_payment_amount: number | null;
  balance: number;
  paid_payments: number;
  total_payments: number;
}

export interface LoanScheduleRow extends ScheduleRow {
  date: string;
}

export interface LoanDetail extends Loan {
  schedule: LoanScheduleRow[];
}

export interface AppNotification {
  id: number;
  kind: 'status' | 'signing_code' | 'info';
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
}
