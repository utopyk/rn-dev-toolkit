import React from 'react';
import { LogPanel } from '../components/LogPanel';

interface MetroLogsProps {
  lines: string[];
}

export function MetroLogs({ lines }: MetroLogsProps) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      padding: '24px 28px',
      minHeight: 0,
      background: 'var(--surface)',
      borderRadius: 'var(--radius-panel)',
      boxShadow: 'var(--neu-raised)',
      overflow: 'hidden',
    }}>
      <LogPanel title="Metro Output (Full)" lines={lines} focused />
    </div>
  );
}
