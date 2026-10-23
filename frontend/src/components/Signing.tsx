import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Paper,
  PinInput,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconConfetti, IconFileText, IconInfoCircle, IconSignature } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import {
  useConfirmSigning,
  useContract,
  useInterestOnly,
  useRequestSigningCode,
} from '../api/hooks';
import type { Application, SigningCode } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { money, moneyShort, months, rate } from '../lib/format';
import { nb } from '../lib/nobreak';
import { Stat } from './ui';

function useCountdown(until: string | null): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return left;
}

// Последний код подписи живёт только в этой вкладке (sessionStorage, как и токен): после перезагрузки или
// возврата со страницы договора окно покажет его снова, пока он действует, и не запросит новый. На сервере
// открытого кода нет — только его HMAC.
function savedCode(key: string): SigningCode | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as SigningCode | null;
    return saved && new Date(saved.expires_at).getTime() > Date.now() ? saved : null;
  } catch {
    return null;
  }
}

function saveCode(key: string, challenge: SigningCode | null) {
  try {
    if (challenge) sessionStorage.setItem(key, JSON.stringify(challenge));
    else sessionStorage.removeItem(key);
  } catch {
    /* приватный режим браузера — код живёт до перезагрузки */
  }
}

function CodeModal({ app, opened, onClose }: { app: Application; opened: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const storeKey = `credit.signing.${user?.id ?? 0}.${app.id}`;
  const request = useRequestSigningCode(app.id);
  const confirm = useConfirmSigning(app.id);
  const [challenge, setChallenge] = useState<SigningCode | null>(() => savedCode(storeKey));
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(challenge?.expires_at ?? null);

  const send = () => {
    setError(null);
    setCode('');
    request.mutate(undefined, {
      onSuccess: (fresh) => {
        saveCode(storeKey, fresh);
        setChallenge(fresh);
      },
      onError: (e) => setError(e instanceof ApiError ? e.message : 'Не удалось получить код'),
    });
  };

  useEffect(() => {
    const expired = challenge !== null && new Date(challenge.expires_at).getTime() <= Date.now();
    if (opened && (!challenge || expired) && !request.isPending) send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const submit = (value: string) => {
    if (!challenge || value.length < 6) return;
    setError(null);
    confirm.mutate(
      { challenge_id: challenge.challenge_id, code: value },
      {
        onSuccess: () => {
          saveCode(storeKey, null);
          onClose();
        },
        onError: (e) => {
          setCode('');
          // После любой неудачи сохранённый код не показываем: после перезагрузки окно запросит новый.
          saveCode(storeKey, null);
          setError(e instanceof ApiError ? e.message : 'Не удалось подписать договор');
        },
      },
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={800}>Подписание договора</Text>} centered radius="lg">
      <Stack align="center" gap="md" ta="center">
        <ThemeIcon size={56} radius="xl" variant="light">
          <IconSignature size={30} />
        </ThemeIcon>
        <Text fz="sm" c="dimmed" maw={340}>
          Введите одноразовый код, чтобы подписать договор простой электронной подписью.
        </Text>
        <Paper withBorder radius="md" p="sm" w="100%" bg="gray.0">
          <Text fz="xs" c="dimmed">
            Демо: электронная подпись смоделирована. В банке код пришёл бы в мобильное приложение — здесь он
            показан прямо в кабинете, SMS и почта не используются.
          </Text>
          <Text fw={800} fz={26} lts={6} mt={4} ff="monospace">
            {challenge?.demo_code ?? '······'}
          </Text>
        </Paper>
        <PinInput
          length={6}
          type="number"
          oneTimeCode
          size="lg"
          value={code}
          onChange={setCode}
          onComplete={submit}
          error={!!error}
          disabled={!challenge || confirm.isPending}
          autoFocus
        />
        {error && (
          <Text c="red" fz="sm">
            {error}
          </Text>
        )}
        {confirm.isPending && <Loader size="sm" />}
        <Text fz="xs" c="dimmed">
          {challenge && left > 0
            ? `Код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
            : challenge
              ? 'Срок действия кода истёк'
              : request.isPending
                ? 'Отправляем код…'
                : null}
        </Text>
        <Button variant="subtle" size="xs" onClick={send} loading={request.isPending}>
          Отправить новый код
        </Button>
      </Stack>
    </Modal>
  );
}

/** Этап «Подписание»: договор, согласие и подпись кодом; после подписи — ожидание выдачи. */
export function SigningCard({ app }: { app: Application }) {
  const contract = useContract(app.id, true);
  const interestOnly = useInterestOnly(app.offer?.product_code);
  const [agreed, setAgreed] = useState(false);
  const [modalOpened, setModalOpened] = useState(false);
  const signed = app.offer?.status === 'signed';
  const canSign = app.allowed_actions.includes('sign');
  const c = contract.data;

  return (
    <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in" style={{ border: '2px solid var(--mantine-color-brand-5)' }}>
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={40} radius="md" color={signed ? 'teal' : 'brand'}>
          {signed ? <IconSignature size={22} /> : <IconFileText size={22} />}
        </ThemeIcon>
        <div>
          <Title order={3}>{signed ? 'Договор подписан' : 'Договор готов к подписанию'}</Title>
          <Text c="dimmed" fz="sm">
            {c ? nb(`Кредитный договор № ${c.number}`) : 'Готовим договор…'}
          </Text>
        </div>
      </Group>

      {c && (
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="lg" spacing="lg">
          <Stat label="Сумма" value={moneyShort(c.amount)} />
          <Stat label="Срок" value={months(c.term_months)} />
          <Stat label="Ставка" value={rate(c.rate)} />
          <Stat label={interestOnly ? 'Проценты в месяц' : 'Платёж в месяц'} value={money(c.monthly_payment)} accent />
        </SimpleGrid>
      )}

      <Anchor component={Link} to={`/applications/${app.id}/contract`} fz="sm" fw={600} mt="md" display="inline-block">
        Открыть договор и график платежей
      </Anchor>

      {c && (
        <Text fz="xs" c="dimmed" mt="xs">
          Подпись привязана к условиям договора и графику: SHA-256 {c.terms_hash.slice(0, 16)}…
        </Text>
      )}

      {signed ? (
        <Paper bg={c?.issue_delayed || app.open_tasks > 0 ? 'orange.0' : 'teal.0'} p="md" radius="md" mt="lg">
          <Group gap="sm" wrap="nowrap">
            {app.open_tasks > 0 ? null : <Loader size="sm" color={c?.issue_delayed ? 'orange' : 'teal'} />}
            <Text fz="sm">
              {app.open_tasks > 0
                ? 'Договор подписан. Деньги поступят, как только вы закроете условия выдачи — они выше на странице.'
                : c?.issue_delayed
                  ? 'Система банка временно не отвечает — перевод задерживается, мы повторяем его автоматически. Договор подписан, ничего делать не нужно.'
                  : interestOnly
                    ? 'Открываем лимит овердрафта на расчётном счёте компании — это займёт несколько секунд.'
                    : 'Перечисляем деньги на расчётный счёт компании — это займёт несколько секунд.'}
            </Text>
          </Group>
        </Paper>
      ) : canSign ? (
        <Stack mt="lg" gap="md">
          <Checkbox
            checked={agreed}
            onChange={(e) => setAgreed(e.currentTarget.checked)}
            label="Я ознакомился с договором и графиком платежей и согласен с условиями"
          />
          <Group>
            <Button size="md" leftSection={<IconSignature size={18} />} disabled={!agreed} onClick={() => setModalOpened(true)}>
              Подписать кодом
            </Button>
          </Group>
          <CodeModal app={app} opened={modalOpened} onClose={() => setModalOpened(false)} />
        </Stack>
      ) : (
        <Alert icon={<IconInfoCircle />} color="blue" variant="light" radius="md" mt="lg">
          Подписать договор может только руководитель компании.
        </Alert>
      )}
    </Card>
  );
}

/** Финал: деньги на счёте или, для овердрафта, открытый лимит. */
export function IssuedCard({ app }: { app: Application }) {
  const offer = app.offer;
  const interestOnly = useInterestOnly(offer?.product_code);
  return (
    <Card p={{ base: 'lg', sm: 'xl' }} className="fade-in hero" radius="lg">
      <Stack gap="sm" style={{ position: 'relative', zIndex: 1 }}>
        <Group gap="sm">
          <ThemeIcon size={44} radius="md" color="white" variant="white">
            <IconConfetti size={26} color="#ef3124" />
          </ThemeIcon>
          <Title order={2} c="white">
            {interestOnly ? 'Лимит открыт!' : 'Деньги на счёте!'}
          </Title>
        </Group>
        {offer && (
          <Text c="rgba(255,255,255,0.92)" fz="lg">
            {interestOnly ? (
              <>
                Лимит овердрафта {money(offer.amount)} открыт на расчётном счёте компании. Через месяц — первый
                платёж: проценты {money(offer.monthly_payment)}; основной долг возвращается в конце срока.
              </>
            ) : (
              <>
                {money(offer.amount)} зачислены на расчётный счёт компании. Первый платёж — {money(offer.monthly_payment)}{' '}
                через месяц.
              </>
            )}
          </Text>
        )}
        {app.loan_id && (
          <Group mt="xs">
            <Button component={Link} to={`/loans/${app.loan_id}`} variant="white" rightSection={<IconArrowRight size={18} />}>
              Кредит и график платежей
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
