import { Button, Combobox, PasswordInput, Text, TextInput, Title, useCombobox } from '@mantine/core';
import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { api } from '../api/client';
import { notifyError, useDemoAccounts } from '../api/hooks';
import type { DemoAccount, Tone, TokenResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Chip } from '../components/Status';
import { Logo } from '../components/ui';
import { typo } from '../lib/format';

// Пароль всех тестовых учёток — он же написан в README; реальных учёток в демо нет.
const DEMO_PASSWORD = 'demo1234';

/** Короткая метка исхода у профиля — та же лексика, что у чипов статуса. */
const OUTCOME: Record<string, string> = {
  'bakery@demo.local': 'Одобрение',
  'sklad@demo.local': 'Другие условия',
  'clean@demo.local': 'Другой продукт',
  'smirnova@demo.local': 'Нужна выписка',
  'vector@demo.local': 'Специалист',
  'start@demo.local': 'Отказ',
  'zakat@demo.local': 'Стоп-фактор',
  'buh@demo.local': 'Подпись у директора',
  'new@demo.local': 'Новый клиент',
  'analyst@demo.local': 'Аналитик',
};

function outcome(a: DemoAccount): string {
  return OUTCOME[a.email] ?? (a.role === 'analyst' ? 'Аналитик' : 'Демо');
}

function matches(a: DemoAccount, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [a.full_name, a.company_name ?? '', a.email, a.position, outcome(a)].some((s) => s.toLowerCase().includes(q));
}

/** Поле почты с выпадающим списком демо-профилей: фокус открывает список, ввод фильтрует, выбор подставляет почту. */
function EmailField({
  value,
  onChange,
  accounts,
  onPick,
}: {
  value: string;
  onChange: (v: string) => void;
  accounts: DemoAccount[];
  onPick: (a: DemoAccount) => void;
}) {
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  const picked = accounts.find((a) => a.email === value);
  // Пока почта совпадает с выбранным профилем, список показывает всех — иначе после выбора он сузился бы до одного.
  const shown = picked ? accounts : accounts.filter((a) => matches(a, value));
  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(email) => {
        const a = accounts.find((x) => x.email === email);
        if (a) onPick(a);
        combobox.closeDropdown();
      }}
      position="bottom-start"
      offset={6}
      withinPortal
    >
      <Combobox.Target>
        <TextInput
          label="Почта"
          placeholder="name@company.ru"
          value={value}
          onChange={(e) => {
            onChange(e.currentTarget.value);
            combobox.openDropdown();
            combobox.updateSelectedOptionIndex();
          }}
          onClick={() => combobox.openDropdown()}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          autoComplete="username"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          required
          withAsterisk={false}
          description="Демо-профили — в списке поля"
          inputWrapperOrder={['label', 'input', 'description', 'error']}
        />
      </Combobox.Target>
      {accounts.length > 0 && (
        <Combobox.Dropdown className="potok-personas">
          <Combobox.Options mah="min(520px, 70dvh)" style={{ overflowY: 'auto' }} aria-label="Демо-профили">
            {shown.length === 0 ? (
              <Combobox.Empty>Такого профиля нет</Combobox.Empty>
            ) : (
              shown.map((a) => (
                <Combobox.Option key={a.email} value={a.email} active={a.email === value} className="potok-persona">
                  <span className="potok-persona-main">
                    <span className="potok-persona-name">{a.full_name}</span>
                    <span className="potok-persona-sub">{a.company_name ?? (a.role === 'analyst' ? 'Банк' : 'Компания ещё не подключена')}</span>
                  </span>
                  <Chip tone={a.scenario_tone as Tone}>{outcome(a)}</Chip>
                </Combobox.Option>
              ))
            )}
          </Combobox.Options>
        </Combobox.Dropdown>
      )}
    </Combobox>
  );
}

export function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const accounts = useDemoAccounts();
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submitRef = useRef<HTMLButtonElement>(null);
  const demo = accounts.data ?? [];

  if (user) return <Navigate to={user.role === 'analyst' ? '/queue' : '/'} replace />;

  const finish = (token: TokenResponse) => {
    signIn(token);
    navigate(token.user.role === 'analyst' ? '/queue' : '/', { replace: true });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    try {
      // Демо-профиль без пароля входит как раньше, в один шаг; с паролем — обычный вход по почте и паролю.
      const isDemo = demo.some((a) => a.email === email.trim().toLowerCase());
      finish(
        isDemo && !password
          ? await api<TokenResponse>('/auth/demo-login', { method: 'POST', json: { email: email.trim().toLowerCase() } })
          : await api<TokenResponse>('/auth/login', { method: 'POST', json: { email, password } }),
      );
    } catch (e) {
      notifyError(e);
    } finally {
      setPending(false);
    }
  };

  const pick = (a: DemoAccount) => {
    setEmail(a.email);
    setPassword(DEMO_PASSWORD);
    // После выбора профиля остаётся одно действие — «Войти».
    requestAnimationFrame(() => submitRef.current?.focus());
  };

  return (
    <main className="potok-login">
      <section className="potok-login-promo">
        <Logo size={32} />
        <Title order={1} className="potok-login-title">
          {typo('Кредит для бизнеса — от заявки до денег на счёте')}
        </Title>
        <Text className="potok-login-lead">
          {typo('Подбор, решение банка, подписание и выдача — в одном кабинете.')}
          <span className="potok-desktop-only"> Данные компании подтягиваются из ЕГРЮЛ и налоговой сами.</span>
        </Text>
        <ul className="potok-login-points">
          <li>Платёж виден ещё до заявки</li>
          <li>Статус обновляется сам</li>
          <li>Договор подписывается кодом в кабинете</li>
        </ul>
      </section>
      <section className="potok-panel potok-login-form">
        <Title order={2} className="potok-login-h">
          Вход в кабинет
        </Title>
        <form onSubmit={submit}>
          <EmailField value={email} onChange={setEmail} accounts={demo} onPick={pick} />
          <PasswordInput
            mt="md"
            label="Пароль"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <Button ref={submitRef} type="submit" size="lg" fullWidth mt="lg" loading={pending} disabled={!email.trim()}>
            Войти
          </Button>
        </form>
      </section>
      <p className="potok-login-note">Прототип для Альфа-Хакатона 2026. Все компании и люди вымышлены, данные синтетические.</p>
    </main>
  );
}
