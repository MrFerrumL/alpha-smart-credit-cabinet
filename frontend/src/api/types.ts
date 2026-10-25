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
  llm_explanation: boolean;
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
  | 'confirm_guarantee'
  | 'accept_offer'
  | 'decline_offer'
  | 'handoff_to_signer'
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
  awaiting_signer: boolean;
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
  internal_comment: string | null;
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

/** Пояснение решения простыми словами, составленное языковой моделью (необязательная функция). */
export interface DecisionExplanation {
  status: 'pending' | 'ready' | 'none';
  text: string | null;
  generated_at: string | null;
}

export interface ClientTask {
  id: number;
  kind: 'document' | 'field' | 'question';
  title: string;
  description: string | null;
  status: 'open' | 'done' | 'expired';
  answer: string | null;
  payload: { document_kind?: string; field?: string; input?: string; condition?: string } | null;
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
  terms_hash: string;
  issue_delayed: boolean;
}

export interface SigningCode {
  challenge_id: number;
  expires_at: string;
  attempts_left: number;
  delivery: 'in_app';
  demo_code: string | null;
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
  kind: 'status' | 'signing_code' | 'signature_requested' | 'info';
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

// --- Кабинет аналитика ---------------------------------------------------------------------

export interface ScoreFactor {
  code: string;
  title: string;
  value: string;
  points: number;
  client_text: string;
  tip: string | null;
}

export interface Terms {
  amount: number;
  term_months: number;
  rate: number;
  monthly_payment: number;
  dsr: number | null;
  coverage: number | null;
}

export interface Assessment {
  review_reason: 'manual_product' | 'grade' | 'source_failure' | 'pipeline_failure' | 'other' | null;
  review_reason_title: string | null;
  scored: boolean;
  failed_sources: string[];
  method: string | null;
  model_version: string | null;
  score: number | null;
  grade: string | null;
  probability_default: number | null;
  factors: ScoreFactor[];
  stop_checks: { title: string; passed: boolean }[];
  revenue: {
    declared_monthly: number | null;
    confirmed_monthly: number | null;
    source: 'fns' | 'statement' | null;
    gap_pct: number | null;
  } | null;
  existing_payments: number | null;
  declared_debt_payments: number | null;
  monthly_profit: number | null;
  requested: Terms;
  recommendation: Terms | null;
  min_rate: number | null;
  max_dsr: number;
  min_coverage: number;
  policy_version: string;
  authority_limit: number;
  revenue_limit: number | null;
  repayment: 'annuity' | 'interest_only';
  product_limits: { min_amount: number; max_amount: number; min_term: number; max_term: number };
  can_decide: boolean;
  trace: TraceStep[];
}

export interface TraceStep {
  title: string;
  detail: string;
  result: 'pass' | 'fail' | 'info' | 'triggered';
}

export interface Replay {
  matches: boolean;
  differences: string[];
  policy_version_stored: string | null;
  policy_version_current: string;
}

export type DecisionOutcome = 'approve' | 'counter_offer' | 'request_info' | 'reject' | 'retry_checks';

export interface AnalystDecision {
  outcome: DecisionOutcome;
  comment: string;
  client_message?: string;
  amount?: number;
  term_months?: number;
  rate?: number;
  reasons?: string[];
  tips?: string[];
  task_kind?: 'document' | 'question';
  task_title?: string;
  task_description?: string;
}

export interface FeedItem {
  id: string;
  published_at: string;
  title: string;
  summary: string;
  reasons: string[];
  is_synthetic: boolean;
  /** Заявка, этап которой поднял новость (главная заявка клиента); у остальных новостей — null. */
  application_id: number | null;
}

export interface PolicySummary {
  max_dsr: number;
  min_coverage: number;
  counts: Record<string, number>;
  approval_share: number;
  offered_total: number;
}

export interface PolicySimulation {
  applications: number;
  current: PolicySummary;
  simulated: PolicySummary;
  changed: {
    id: number;
    number: string | null;
    company: string;
    product: string;
    status: string;
    requested: number;
    outcome_now: string;
    outcome_then: string;
    offered_now: number;
    offered_then: number;
  }[];
}
