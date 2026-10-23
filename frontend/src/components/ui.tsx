import { Center, Group, Loader, Text } from '@mantine/core';
import type { ReactNode } from 'react';

import { BRAND } from '../theme';

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
