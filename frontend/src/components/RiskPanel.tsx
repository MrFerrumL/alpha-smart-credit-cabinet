import { Alert, Button, Group, Skeleton, Table, Text, Title } from '@mantine/core';

import { useApplicationRisk } from '../api/hooks';
import { dateTime, decimal, percent } from '../lib/format';

const LABELS: Record<string, string> = {
  business_age_years: 'Возраст бизнеса', dsr: 'Долговая нагрузка', margin: 'Рентабельность',
  max_overdue_days_24m: 'Историческая просрочка', inquiries_90d: 'Запросы в БКИ',
  tax_debt_ratio: 'Налоговый долг к выручке', has_credit_history: 'Наличие кредитной истории',
  revenue_monthly: 'Подтверждённая выручка', tax_debt: 'Налоговый долг', scoring_snapshot: 'Снимок признаков',
};

export function RiskPanel({ id }: { id: number }) {
  const query = useApplicationRisk(id, true);
  const result = query.data;
  const prediction = result?.prediction;
  return (
    <section className="potok-panel" aria-label="Учебная ML-оценка">
      <Title order={3}>Учебная ML-оценка</Title>
      <Text size="sm" c="dimmed" mt="xs">
        Модель обучена на синтетических данных. Прогноз не влияет на решение и условия кредита.
      </Text>
      {query.isLoading && <Skeleton h={80} mt="sm" />}
      {query.isError && (
        <Alert color="gray" mt="sm" title="Модель временно недоступна">
          Обработка заявки продолжается по правилам банка.
          <Button variant="subtle" size="xs" onClick={() => void query.refetch()}>Повторить расчёт</Button>
        </Alert>
      )}
      {result?.status === 'unavailable' && (
        <Text mt="sm">Недостаточно корректных данных: {result.unavailable_fields.map(f => LABELS[f] ?? f).join(', ')}.</Text>
      )}
      {prediction && (
        <>
          <Group mt="md" justify="space-between" align="start">
            <div>
              <Text size="sm" c="dimmed">Выход учебной модели</Text>
              <Text fw={700} size="xl" data-testid="ml-probability">{percent(prediction.probability_default, 1)}</Text>
            </div>
            <Text size="sm">{prediction.above_threshold ? 'Выше' : 'Ниже'} экспериментального порога {percent(prediction.threshold, 0)}</Text>
          </Group>
          {prediction.out_of_training_range.length > 0 && (
            <Alert color="yellow" mt="sm" title="Вне диапазонов обучения">
              {prediction.out_of_training_range.map(f => LABELS[f] ?? f).join(', ')}. Такой прогноз требует осторожной интерпретации.
            </Alert>
          )}
          <Text size="xs" c="dimmed" mt="sm">
            Сохранённая оценка №{result.scoring_id}{result.scored_at ? ` от ${dateTime(result.scored_at)}` : ''}.
          </Text>
          <details style={{ marginTop: 12 }}>
            <summary>Вклады признаков и версия модели</summary>
            <Text size="sm" c="dimmed" mt="xs">Положительный вклад повышает логит, отрицательный понижает. Это не причинное объяснение.</Text>
            <Table mt="xs" aria-label="Вклады ML-признаков">
              <Table.Thead><Table.Tr><Table.Th>Признак</Table.Th><Table.Th>Вклад в log-odds</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {prediction.contributions.map(c => <Table.Tr key={c.feature}><Table.Td>{LABELS[c.feature] ?? c.feature}</Table.Td><Table.Td>{decimal(c.log_odds, 3)}</Table.Td></Table.Tr>)}
              </Table.Tbody>
            </Table>
            <Text size="xs" mt="xs">Версия: {prediction.model_version}</Text>
            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>SHA-256: {prediction.artifact_sha256}</Text>
          </details>
        </>
      )}
    </section>
  );
}
