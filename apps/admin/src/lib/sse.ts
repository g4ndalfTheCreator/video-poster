import { useEffect } from 'react';

/** Subscribes to a Server-Sent Events endpoint under /api/admin. */
export function useSse(path: string | null, event: string, onMessage: (data: unknown) => void) {
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(`/api/admin${path}`, { withCredentials: true });
    const handler = (e: MessageEvent) => {
      try {
        onMessage(JSON.parse(e.data as string));
      } catch {
        /* ignore malformed */
      }
    };
    es.addEventListener(event, handler);
    return () => es.close();
  }, [path, event]);
}
