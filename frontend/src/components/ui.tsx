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

export function Logo({ inverted = false }: { inverted?: boolean }) {
  return (
    <Group gap={10} wrap="nowrap">
      <svg width="38" height="38" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill={inverted ? '#ffffff' : '#ef3124'} />
        <path
          d="M14 40c8 0 10-16 18-16s10 16 18 16"
          fill="none"
          stroke={inverted ? '#ef3124' : '#ffffff'}
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
      <div>
        <Text fw={800} fz={20} lh={1.1} c={inverted ? 'white' : undefined}>
          {BRAND.name}
        </Text>
        <Text fz={11} lh={1.2} c={inverted ? 'rgba(255,255,255,0.85)' : 'dimmed'}>
          {BRAND.caption}
        </Text>
      </div>
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

export function Stat({ label, value, accent = false }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div>
      <Text fz="xs" c="dimmed" tt="uppercase" fw={600} lts={0.4}>
        {label}
      </Text>
      <Text fz={accent ? 24 : 'lg'} fw={800} c={accent ? 'brand.6' : undefined} lh={1.3}>
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
