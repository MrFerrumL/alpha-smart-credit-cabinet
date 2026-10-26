import { Anchor, Button, Group, Modal, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import {
  useApplication,
  useCancelApplication,
  useChecks,
  useDocuments,
  useEvents,
  useProducts,
  useTasks,
} from '../api/hooks';
import { useApplicationStream } from '../api/stream';
import type { Application, ClientTask } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AnalystCard } from '../components/AnalystPanel';
import { COLLATERAL_TITLES, ChecksCard, DocumentList, TasksCard, shownTerms } from '../components/ApplicationBlocks';
import { AutoExplanation, DecisionBlock, DecisionReasons, NextSteps } from '../components/Decision';
import { IssuedCard, SigningCard } from '../components/Signing';
import { History } from '../components/History';
import { MyCompany } from '../components/Side';
import { DecisionSkeleton, LoadError } from '../components/States';
import { nb } from '../lib/nobreak';
import { StatusBlock, StatusChip } from '../components/Status';
import { dateTime, lowerFirst, money, months, monthsShort, typo } from '../lib/format';

/** Заявка с предложением банка: отзыв равен отказу от него, и клиенту важно увидеть, что именно он теряет. */
const OFFER_STAGE = ['approved', 'counter_offer', 'signing'];

function CancelAction({ app }: { app: Application }) {
  const cancel = useCancelApplication();
  const [opened, setOpened] = useState(false);
  const [comment, setComment] = useState('');
  const draft = app.status.code === 'draft';
  const offer = OFFER_STAGE.includes(app.status.code) ? app.offer : null;
  return (
    <>
      <Button variant="subtle" size="md" px={0} onClick={() => setOpened(true)}>
        {draft ? 'Закрыть черновик' : 'Отозвать заявку'}
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={<Text fw={600}>{draft ? 'Закрыть черновик?' : 'Отозвать заявку?'}</Text>}
      >
        <Stack>
          <Text fz="sm" c="dimmed">
            {draft ? (
              'Черновик будет закрыт без отправки в банк. Новую заявку можно подать в любой момент — данные компании подставятся автоматически.'
            ) : offer ? (
              <>
                Одобренное предложение банка — {money(offer.amount)} на {monthsShort(offer.term_months)} — перестанет
                действовать. Чтобы получить кредит, понадобится новая заявка и новая проверка.
              </>
            ) : (
              'Заявка будет закрыта. Новую можно подать в любой момент — данные компании подставятся автоматически.'
            )}
          </Text>
          {!draft && (
            <Textarea
              label="Почему отзываете, необязательно"
              placeholder="Например: нашли другое финансирование"
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              autosize
              minRows={2}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              {draft ? 'Оставить' : 'Не отзывать'}
            </Button>
            <Button
              loading={cancel.isPending}
              onClick={() => cancel.mutate({ id: app.id, comment: comment || undefined }, { onSuccess: () => setOpened(false) })}
            >
              {draft ? 'Закрыть' : 'Отозвать'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * Статус без решения: проверки, ожидание специалиста, запрос информации. Пока заявка ждёт, в одном блоке — где она,
 * почему, открытый запрос банка с его кнопкой и «Отозвать заявку» в строке статуса.
 */
function StatusSection({ app, live, tasks }: { app: Application; live: boolean; tasks: ClientTask[] }) {
  const moving = !app.status.terminal && !app.status.action_required && app.status.code !== 'draft';
  const canCancel = app.allowed_actions.includes('cancel') && !app.allowed_actions.includes('decline_offer');
  const why = app.status.code === 'manual_review' ? (app.decision?.reasons ?? []) : [];
  const asking = app.status.code === 'needs_info';
  return (
    <section className={asking ? 'potok-decision potok-status-asking' : 'potok-decision'}>
      <StatusBlock
        app={app}
        onPage
        showLabels
        hintTail={
          moving && (
            <span className="potok-live-tail">
              <span className="potok-live" data-live={live} />
              {live ? 'Статус обновляется сам' : 'Подключаемся к обновлениям…'}
            </span>
          )
        }
        aside={canCancel ? <CancelAction app={app} /> : undefined}
      >
        {why.length > 0 && (
          <div className="potok-status-why">
            <Title order={3} className="potok-status-why-h">
              Почему заявку смотрит специалист
            </Title>
            : {typo(why.map(lowerFirst).join('; '))}
          </div>
        )}
      </StatusBlock>
      {asking && <TasksCard app={app} tasks={tasks} embedded />}
    </section>
  );
}

/** Согласованные условия после выдачи — парами «подпись — значение» в боковой колонке. */
function AgreedTerms({ app }: { app: Application }) {
  const products = useProducts();
  const terms = shownTerms(app, products.data);
  if (!terms.agreed || app.status.code !== 'issued') return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Условия кредита</Title>
      <dl className="potok-pairs">
        <div>
          <dt>Продукт</dt>
          <dd>{nb(terms.product)}</dd>
        </div>
        <div>
          <dt>Сумма</dt>
          <dd>{money(terms.amount)}</dd>
        </div>
        <div>
          <dt>Срок</dt>
          <dd>{months(terms.term)}</dd>
        </div>
        <div>
          <dt>Ставка</dt>
          <dd>{terms.rate}</dd>
        </div>
        <div>
          <dt>{terms.interestOnly ? 'Проценты в месяц' : 'Платёж в месяц'}</dt>
          <dd>{terms.payment}</dd>
        </div>
      </dl>
      {terms.asked && (
        <Text fz="sm" c="dimmed" mt="md">
          Вы просили: {terms.asked}
        </Text>
      )}
    </section>
  );
}

const CHECKING = ['submitted', 'validation', 'enrichment', 'scoring', 'manual_review', 'needs_info'];

/** Пока банк проверяет заявку — то, что клиент просил: сумма, срок, оценка платежа и залог. */
function RequestedTerms({ app }: { app: Application }) {
  const products = useProducts();
  const terms = shownTerms(app, products.data);
  const collateral = app.form?.collateral;
  if (!CHECKING.includes(app.status.code)) return null;
  return (
    // На телефоне стоит сразу за «Что дальше», а не в конце страницы.
    <section className="potok-panel potok-phone-first">
      <Title order={3}>Ваша заявка</Title>
      <dl className="potok-pairs">
        <div>
          <dt>Сумма</dt>
          <dd>{money(terms.amount)}</dd>
        </div>
        <div>
          <dt>Срок</dt>
          <dd>{months(terms.term)}</dd>
        </div>
        <div>
          <dt>{terms.interestOnly ? 'Проценты в месяц' : 'Платёж в месяц'}</dt>
          <dd>{terms.payment}</dd>
        </div>
        {collateral?.kind && (
          <div>
            <dt>Залог</dt>
            <dd>
              {COLLATERAL_TITLES[collateral.kind] ?? 'Указан'}
              {collateral.value ? `, ${money(collateral.value)}` : ''}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function ApplicationPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const { user } = useAuth();
  const query = useApplication(applicationId);
  const app = query.data;
  const products = useProducts();
  const live = useApplicationStream(applicationId, !!app && !app.status.terminal && app.status.code !== 'draft');
  const events = useEvents(applicationId, app);
  const tasks = useTasks(applicationId, app);
  const checks = useChecks(applicationId, app);
  const documents = useDocuments(applicationId, !!app);
  const bank = user?.role === 'analyst';
  const backTo = bank ? '/queue' : '/applications';
  const back = (
    <Anchor component={Link} to={backTo} fz="sm" c="dimmed" className="potok-back">
      <IconArrowLeft size={16} /> {bank ? 'Очередь заявок' : 'Все заявки'}
    </Anchor>
  );

  if (query.isLoading) return <DecisionSkeleton />;
  if (!app) {
    return (
      <LoadError
        error={query.error}
        what="заявку"
        back={
          <Button component={Link} to={backTo} variant="subtle" size="md">
            {bank ? 'К очереди заявок' : 'К списку заявок'}
          </Button>
        }
      />
    );
  }
  if (bank) return <AnalystCard app={app} back={back} events={events.data} tasks={tasks.data} documents={documents.data} />;

  const code = app.status.code;
  const decided = ['approved', 'counter_offer', 'rejected'].includes(code) && !!app.decision;
  const sent = app.submitted_at ?? app.created_at;
  const taskList = tasks.data ?? [];
  // После принятия предложения заголовок — продукт договора; запрошенный продукт остаётся в строке под ним.
  const terms = shownTerms(app, products.data);
  const otherProduct = terms.agreed && terms.product !== app.product.name;

  return (
    <div className="potok-col">
      <div>
        {back}
        <Group mt="sm" gap="md" align="center">
          <Title order={1}>{nb(terms.agreed ? terms.product : app.product.name)}</Title>
          <StatusChip app={app} />
        </Group>
        <Text c="dimmed" mt={4} fz="sm">
          Заявка {nb(app.number)}, {app.submitted_at ? 'отправлена' : 'создана'} {dateTime(sent)}
          {otherProduct && <>, вы просили {nb(app.product.name)}</>}
        </Text>
      </div>

      {/* Главный блок — один на экране: решение, подписание, выдача или статус с запросом банка. */}
      {decided ? (
        <DecisionBlock app={app} />
      ) : code === 'signing' ? (
        <SigningCard app={app} extra={app.allowed_actions.includes('cancel') ? <CancelAction app={app} /> : undefined} />
      ) : code === 'issued' ? (
        <IssuedCard app={app} />
      ) : (
        <StatusSection app={app} live={live} tasks={taskList} />
      )}

      {/* Условия выдачи — следующий шаг после подписи, поэтому сразу под договором и во всю ширину. */}
      {code === 'signing' && <TasksCard app={app} tasks={taskList} />}

      {/* Слева — почему, проверки и история; справа — что дальше, условия, документы и компания. Последняя панель
          более короткой колонки дотягивается до низа соседней. */}
      <div className="potok-below potok-even">
        <div className="potok-col">
          <DecisionReasons app={app} />
          {/* Пояснение дополняет причины банка — сразу после них и вне блока решения, чтобы его появление не сдвигало
              кнопки. */}
          {decided && <AutoExplanation app={app} />}
          {/* Проверки видны, пока банк проверяет заявку; после решения они уже в истории. */}
          {checks.data && CHECKING.includes(code) && <ChecksCard checks={checks.data} active={code === 'enrichment'} />}
          {code !== 'needs_info' && code !== 'signing' && <TasksCard app={app} tasks={taskList} />}
          <section className="potok-panel">
            <Title order={3}>История</Title>
            {events.data && <History events={events.data} />}
          </section>
        </div>
        <div className="potok-col">
          <NextSteps app={app} />
          <RequestedTerms app={app} />
          <AgreedTerms app={app} />
          {documents.data && documents.data.length > 0 && (
            <section className="potok-panel">
              <Title order={3}>Документы</Title>
              <div style={{ marginTop: 12 }}>
                <DocumentList documents={documents.data} />
              </div>
            </section>
          )}
          <MyCompany />
        </div>
      </div>
    </div>
  );
}
