import { useState, useCallback } from 'react';

const KEY = 'rndev.notificationsPanelExpanded';

export function useNotificationsPanelExpanded() {
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return { expanded, toggle };
}
