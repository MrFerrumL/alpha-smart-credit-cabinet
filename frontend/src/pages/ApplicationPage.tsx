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
import type { Application, ApplicationAction } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AnalystCard } from '../components/AnalystPanel';
import { ChecksCard, DocumentList, TasksCard, shownTerms } from '../components/ApplicationBlocks';
import { DecisionBlock, DecisionReasons, NextSteps } from '../components/Decision';
import { IssuedCard, SigningCard } from '../components/Signing';
import { History } from '../components/History';
import { MyCompany } from '../components/Side';
import { DecisionSkeleton, LoadError } from '../components/States';
import { nb } from '../lib/nobreak';
import { StatusBlock, StatusChip } from '../components/Status';
import { dateTime, money, months, rate } from '../lib/format';

function CancelAction({ app }: { app: Application }) {
  const cancel = useCancelApplication();
  const [opened, setOpened] = useState(false);
  const [comment, setComment] = useState('');
  const draft = app.status.code === 'draft';
  return (
    <>
      <Button variant="subtle" size="md" px={0} onClick={() => setOpened(true)}>
        {draft ? 'Закрыть черновик' : 'Отозвать заявку'}
      </Button>
      <Modal opened={opened} onClose={() => setOpened(false)} title={<Text fw={600}>Отозвать заявку?</Text>}>
        <Stack>
          <Text fz="sm" c="dimmed">
            Заявка будет закрыта. Новую можно подать в любой момент — данные компании подставятся автоматически.
          </Text>
          <Textarea
            label="Почему отзываете, необязательно"
            placeholder="Например: нашли другое финансирование"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpened(false)}>
              Не отзывать
            </Button>
            <Button
              loading={cancel.isPending}
              onClick={() => cancel.mutate({ id: app.id, comment: comment || undefined }, { onSuccess: () => setOpened(false) })}
            >
              Отозвать
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Статус без решения: проверки, запрос информации, подписание, выдача. */
function StatusSection({ app, live }: { app: Application; live: boolean }) {
  const can = (action: ApplicationAction) => app.allowed_actions.includes(action);
  const moving = !app.status.terminal && !app.status.action_required && app.status.code !== 'draft';
  return (
    <section className="potok-decision">
      <StatusBlock app={app} onPage showLabels />
      {moving && (
        <Group gap={8} mt="md">
          <span className="potok-live" data-live={live} />
          <Text fz="sm" c="dimmed">
            {live ? 'Статус обновляется сам' : 'Подключаемся к обновлениям…'}
          </Text>
        </Group>
      )}
      {can('cancel') && !can('decline_offer') && (
        <div className="potok-cta">
          <CancelAction app={app} />
        </div>
      )}
    </section>
  );
}

/** Согласованные условия после принятия предложения: подписание и выдача. */
function AgreedTerms({ app }: { app: Application }) {
  const products = useProducts();
  const terms = shownTerms(app, products.data);
  if (!terms.agreed) return null;
  return (
    <section className="potok-panel">
      <Title order={3}>Условия кредита</Title>
      <dl className="potok-kv">
        <div>
          <dt>Продукт</dt>
          <dd>{terms.product}</dd>
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
          <dd>{app.offer ? rate(app.offer.rate) : terms.rate}</dd>
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

export function ApplicationPage() {
  const { id } = useParams();
  const applicationId = Number(id);
  const { user } = useAuth();
  const query = useApplication(applicationId);
  const app = query.data;
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
  if (bank) return <AnalystCard app={app} back={back} events={events.data} />;

  const decided = ['approved', 'counter_offer', 'rejected'].includes(app.status.code) && !!app.decision;
  const sent = app.submitted_at ?? app.created_at;

  return (
    <Stack gap="lg">
      <div>
        {back}
        <Group mt="sm" gap="md" align="center">
          <Title order={1}>{nb(app.product.name)}</Title>
          <StatusChip app={app} />
        </Group>
        <Text c="dimmed" mt={4} fz="sm">
          Заявка {nb(app.number)}, {app.submitted_at ? 'отправлена' : 'создана'} {dateTime(sent)}
        </Text>
      </div>

      {decided ? <DecisionBlock app={app} /> : <StatusSection app={app} live={live} />}

      {tasks.data && tasks.data.length > 0 && (
        <div id="tasks">
          <TasksCard app={app} tasks={tasks.data} readOnly={false} />
        </div>
      )}
      {app.status.code === 'signing' && (
        <div id="signing">
          <SigningCard app={app} />
        </div>
      )}
      {app.status.code === 'issued' && <IssuedCard app={app} />}

      {/* Одна раскладка для всех статусов: слева «почему» и история, справа «что дальше», документы и компания —
          ни одна колонка не остаётся пустой. */}
      <div className="potok-below">
        <Stack gap="lg">
          <DecisionReasons app={app} />
          <AgreedTerms app={app} />
          {checks.data && !decided && <ChecksCard checks={checks.data} active={app.status.code === 'enrichment'} />}
          <section className="potok-panel">
            <Title order={3}>История</Title>
            {events.data && <History events={events.data} />}
          </section>
        </Stack>
        <Stack gap="lg">
          <NextSteps app={app} />
          {documents.data && documents.data.length > 0 && (
            <section className="potok-panel">
              <Title order={3}>Документы</Title>
              <div style={{ marginTop: 12 }}>
                <DocumentList documents={documents.data} />
              </div>
            </section>
          )}
          <MyCompany />
        </Stack>
      </div>
    </Stack>
  );
}
