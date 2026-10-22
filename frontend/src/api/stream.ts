import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { tokenStore } from './client';
import type { StreamSnapshot } from './types';

const TONE_COLOR: Record<StreamSnapshot['tone'], string> = {
  neutral: 'gray',
  info: 'blue',
  warning: 'orange',
  success: 'teal',
  danger: 'red',
};

/**
 * Живой статус заявки: читает поток Server-Sent Events /api/applications/{id}/stream.
 * EventSource не умеет передавать заголовок Authorization, поэтому поток читается через fetch.
 * При обрыве соединение восстанавливается с растущей паузой; когда заявка доходит до финального
 * статуса, сервер закрывает поток сам.
 */
export function useApplicationStream(id: number, enabled: boolean): boolean {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const lastStatus = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;

    const onSnapshot = (snap: StreamSnapshot) => {
      if (lastStatus.current && lastStatus.current !== snap.status) {
        notifications.show({ color: TONE_COLOR[snap.tone], title: 'Статус заявки обновился', message: snap.title });
      }
      lastStatus.current = snap.status;
      qc.invalidateQueries({ queryKey: ['application', id] });
      qc.invalidateQueries({ queryKey: ['applications'] });
    };

    const run = async () => {
      while (!controller.signal.aborted) {
        let finished = false;
        try {
          const response = await fetch(`/api/applications/${id}/stream`, {
            headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}`, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
          setLive(true);
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = chunk
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('');
              if (data) {
                const snap = JSON.parse(data) as StreamSnapshot;
                onSnapshot(snap);
                finished = snap.terminal;
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        setLive(false);
        if (finished) return;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)));
      }
    };

    void run();
    return () => {
      controller.abort();
      setLive(false);
    };
  }, [id, enabled, qc]);

  return live;
}
