import React from 'react';

export function LintTest() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--muted)',
      fontSize: 14,
      padding: '24px 28px',
      background: 'var(--surface)',
      borderRadius: 'var(--radius-panel)',
      boxShadow: 'var(--neu-raised)',
      overflow: 'hidden',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 22, marginBottom: 10, color: 'var(--ink)', fontWeight: 600 }}>Lint & Test</div>
        <div>Run [l] to lint or [t] to type-check</div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
          Results will appear here
        </div>
      </div>
    </div>
  );
}
