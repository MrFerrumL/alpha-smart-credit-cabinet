import { Badge, Center, Group, Loader, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import {
  IconClockHour4,
  IconFileCertificate,
  IconPackages,
  IconRocket,
  IconTruck,
  type Icon,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { StatusInfo, Tone } from '../api/types';
import { BRAND } from '../theme';

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'gray',
  info: 'blue',
  warning: 'orange',
  success: 'teal',
  danger: 'red',
};

export function toneColor(tone: Tone): string {
  return TONE_COLOR[tone];
}

export function StatusBadge({ status, size = 'md' }: { status: StatusInfo; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Badge color={toneColor(status.tone)} variant="light" size={size}>
      {status.title}
    </Badge>
  );
}

const PURPOSE_ICONS: Record<string, Icon> = {
  boxes: IconPackages,
  clock: IconClockHour4,
  truck: IconTruck,
  rocket: IconRocket,
  contract: IconFileCertificate,
};

export function PurposeIcon({ name, size = 22 }: { name: string; size?: number }) {
  const Cmp = PURPOSE_ICONS[name] ?? IconPackages;
  return <Cmp size={size} stroke={1.8} />;
}

/** Знак «Поток» — волна потока — и название. Цвет знака — акцент Альфы, без подложки. */
export function Logo({ inverted = false, size = 20 }: { inverted?: boolean; size?: number }) {
  return (
    <Group gap={10} wrap="nowrap" aria-label={BRAND.name}>
      <svg height={Math.round(size * 0.85)} viewBox="2 16 60 32" aria-hidden="true" style={{ flex: 'none' }}>
        <path
          d="M6 36c6 0 8-14 14-14s8 20 14 20 8-20 14-20 8 14 10 14"
          fill="none"
          stroke={inverted ? '#ffffff' : 'var(--potok-accent)'}
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <Text component="span" ff="var(--font-display)" fw={600} fz={size} lh={1} c={inverted ? 'white' : undefined}>
        {BRAND.name}
      </Text>
    </Group>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="baseline">
        <Title order={4}>{title}</Title>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: Icon;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <Paper p="xl" withBorder style={{ borderStyle: 'dashed', background: 'transparent' }}>
      <Stack align="center" gap="xs" ta="center">
        <ThemeIcon size={52} radius="xl" variant="light">
          <Icon size={26} />
        </ThemeIcon>
        <Text fw={700} mt="xs">
          {title}
        </Text>
        <Text c="dimmed" fz="sm" maw={420}>
          {text}
        </Text>
        {action && <div style={{ marginTop: 8 }}>{action}</div>}
      </Stack>
    </Paper>
  );
}

/** Подпись и значение: подпись обычным регистром, сталью; значение графитом — суммы никогда не красные. */
export function Stat({ label, value, accent = false }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div>
      <Text fz="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={accent ? 22 : 'lg'} fw={600} lh={1.3} mt={2}>
        {value}
      </Text>
    </div>
  );
}

export function FullScreenLoader() {
  return (
    <Center h="100vh">
      <Loader />
    </Center>
  );
}
