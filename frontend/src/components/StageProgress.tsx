import { Box, Group, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconCheck, IconX } from '@tabler/icons-react';
import { Fragment } from 'react';

import type { StatusInfo } from '../api/types';

type StepState = 'done' | 'active' | 'failed' | 'stopped' | 'pending';

function stepState(index: number, status: StatusInfo): StepState {
  if (status.code === 'issued') return 'done';
  if (index < status.stage) return 'done';
  if (index > status.stage) return 'pending';
  if (status.code === 'rejected') return 'failed';
  if (status.code === 'cancelled' || status.code === 'expired') return 'stopped';
  return 'active';
}

const CIRCLE: Record<StepState, { bg: string; border: string; color: string }> = {
  done: { bg: 'var(--mantine-color-brand-6)', border: 'var(--mantine-color-brand-6)', color: '#fff' },
  active: { bg: '#fff', border: 'var(--mantine-color-brand-6)', color: 'var(--mantine-color-brand-6)' },
  failed: { bg: 'var(--mantine-color-red-7)', border: 'var(--mantine-color-red-7)', color: '#fff' },
  stopped: { bg: 'var(--mantine-color-gray-5)', border: 'var(--mantine-color-gray-5)', color: '#fff' },
  pending: { bg: '#fff', border: 'var(--app-line)', color: 'var(--mantine-color-gray-5)' },
};

function Circle({ state, index }: { state: StepState; index: number }) {
  const s = CIRCLE[state];
  return (
    <Box
      className={state === 'active' ? 'pulse' : undefined}
      w={30}
      h={30}
      style={{
        flex: '0 0 auto',
        borderRadius: '50%',
        background: s.bg,
        border: `2px solid ${s.border}`,
        color: s.color,
        display: 'grid',
        placeItems: 'center',
        fontSize: 13,
        fontWeight: 800,
      }}
    >
      {state === 'done' ? (
        <IconCheck size={16} stroke={3} />
      ) : state === 'failed' || state === 'stopped' ? (
        <IconX size={16} stroke={3} />
      ) : (
        index + 1
      )}
    </Box>
  );
}

/** Таймлайн этапов заявки: где она сейчас и что уже пройдено. */
export function StageProgress({ stages, status }: { stages: string[]; status: StatusInfo }) {
  const mobile = useMediaQuery('(max-width: 48em)');

  if (mobile) {
    return (
      <Stack gap="sm">
        {stages.map((label, i) => {
          const state = stepState(i, status);
          return (
            <Group key={label} gap="sm" wrap="nowrap">
              <Circle state={state} index={i} />
              <Text fz="sm" fw={state === 'pending' ? 500 : 700} c={state === 'pending' ? 'dimmed' : undefined}>
                {label}
              </Text>
            </Group>
          );
        })}
      </Stack>
    );
  }

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      {stages.map((label, i) => {
        const state = stepState(i, status);
        return (
          <Fragment key={label}>
            {i > 0 && <div className="stage-line" data-done={stepState(i - 1, status) === 'done' && state !== 'pending'} />}
            <Stack gap={6} align="center" w={84} style={{ flex: '0 0 auto' }}>
              <Circle state={state} index={i} />
              <Text
                fz={12}
                ta="center"
                lh={1.25}
                fw={state === 'pending' ? 500 : 700}
                c={state === 'pending' ? 'dimmed' : undefined}
              >
                {label}
              </Text>
            </Stack>
          </Fragment>
        );
      })}
    </Group>
  );
}
