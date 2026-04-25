import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIpcInvoke, useIpcOn } from '../hooks/useIpc';
import './ModuleConfigForm.css';

interface JsonSchemaProperty {
  type?: 'string' | 'boolean';
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  title?: string;
}

interface ObjectSchema {
  type?: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

export interface ModuleConfigFormProps {
  moduleId: string;
  scopeUnit?: string;
  schema: ObjectSchema;
  /**
   * Fires after a successful `modules:config-set`. Parent components can
   * use this to re-read dependent state (e.g. the Settings panel
   * re-applies the theme).
   */
  onSaved?: (config: Record<string, unknown>) => void;
}

type ConfigGetReply =
  | { moduleId: string; config: Record<string, unknown> }
  | { error: string }
  // Phase 13.4.1 — the Electron handler also returns this shape when
  // the daemon-client adapter hasn't published yet
  // (`E_CONFIG_SERVICES_PENDING`). Without this branch, the renderer
  // falls through to `setConfig(reply.config)` where `reply.config`
  // is undefined and the form crashes during the next render.
  | { kind: 'error'; code: string; message: string };

type ConfigSetReply =
  | { kind: 'ok'; config: Record<string, unknown> }
  | { kind: 'error'; code: string; message: string };

type ConfigChangedEvent = {
  kind: 'config-changed';
  moduleId: string;
  scopeUnit?: string;
  config: Record<string, unknown>;
};

export function ModuleConfigForm({
  moduleId,
  scopeUnit,
  schema,
  onSaved,
}: ModuleConfigFormProps): React.JSX.Element {
  const invoke = useIpcInvoke();
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [justSaved, setJustSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadPending, setLoadPending] = useState(true);

  // Kept in sync with state so the modules:event handler can read the
  // latest config + draft without depending on them (closure stability
  // keeps useIpcOn from churning subscriptions on every keystroke).
  const configRef = useRef(config);
  const draftRef = useRef(draft);
  useEffect(() => {
    configRef.current = config;
    draftRef.current = draft;
  }, [config, draft]);

  // Phase 13.4.1 — the Electron handler's `getDeps()` is now an
  // awaitable promise that resolves once the daemon-client adapter
  // publishes. The renderer's `invoke` pends until the main process
  // has live deps, so we no longer need a "retry on ready" path or a
  // pending-vs-error code split. The only remaining error shapes
  // are: missing-reply, daemon `{error: string}`, and a residual
  // `{kind:'error'}` from genuine errors (sender-mismatch, validation).
  useEffect(() => {
    let active = true;
    setStatus({ kind: 'idle' });
    setLoadPending(true);
    invoke<ConfigGetReply | null>('modules:config-get', { moduleId, scopeUnit }).then(
      (reply) => {
        if (!active) return;
        setLoadPending(false);
        if (!reply) {
          setLoadError('IPC returned no response');
          return;
        }
        if ('error' in reply) {
          setLoadError(reply.error);
          return;
        }
        if ('kind' in reply && reply.kind === 'error') {
          setLoadError(`${reply.code}: ${reply.message}`);
          return;
        }
        if (!('config' in reply)) {
          setLoadError('Unexpected modules:config-get reply shape');
          return;
        }
        setLoadError(null);
        setConfig(reply.config);
        setDraft(reply.config);
      },
      (err: unknown) => {
        if (!active) return;
        setLoadPending(false);
        setLoadError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      active = false;
    };
  }, [invoke, moduleId, scopeUnit]);

  // Live-update from external config-changed events (another window / the
  // TUI, or `modules:config-set` from a subprocess module). Reads latest
  // config + draft via refs so the callback identity is stable across
  // renders — otherwise `useIpcOn` would churn subscriptions per keystroke.
  useIpcOn(
    'modules:event',
    useCallback(
      (event: ConfigChangedEvent | { kind: string; moduleId: string }) => {
        if (event.kind !== 'config-changed') return;
        if (event.moduleId !== moduleId) return;
        const fresh = (event as ConfigChangedEvent).config ?? {};
        setConfig(fresh);
        // Preserve in-flight edits when the draft diverges from the
        // previously-persisted config.
        if (shallowEqual(draftRef.current, configRef.current)) {
          setDraft(fresh);
        }
      },
      [moduleId],
    ),
  );

  const commit = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setJustSaved(false);
    const reply = await invoke<ConfigSetReply>('modules:config-set', {
      moduleId,
      scopeUnit,
      patch: draft,
    });
    if (reply.kind === 'ok') {
      setConfig(reply.config);
      setStatus({ kind: 'idle' });
      setJustSaved(true);
      onSaved?.(reply.config);
    } else {
      setStatus({ kind: 'error', message: reply.message });
    }
  }, [draft, invoke, moduleId, onSaved, scopeUnit]);

  const revert = useCallback(() => {
    setDraft(config);
    setStatus({ kind: 'idle' });
    setJustSaved(false);
  }, [config]);

  if (loadError) {
    return (
      <div className="module-config-form module-config-form--error">
        <p>Failed to load config: {loadError}</p>
      </div>
    );
  }

  if (loadPending) {
    return (
      <div className="module-config-form module-config-form--loading">
        <p>Loading config…</p>
      </div>
    );
  }

  const dirty = !shallowEqual(draft, config);
  // "Saved" fades as soon as the user edits again.
  const showSaved = justSaved && !dirty && status.kind === 'idle';
  const properties = schema.properties ?? {};
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return (
      <div className="module-config-form module-config-form--empty">
        <p>This module doesn't declare any configurable settings.</p>
      </div>
    );
  }

  return (
    <div className="module-config-form">
      <div className="module-config-form__fields">
        {keys.map((key) => (
          <FieldRow
            key={key}
            name={key}
            property={properties[key]}
            value={draft[key]}
            onChange={(value) =>
              setDraft((prev) => ({ ...prev, [key]: value }))
            }
          />
        ))}
      </div>

      <div className="module-config-form__actions">
        <button
          type="button"
          className="module-config-form__save"
          onClick={() => void commit()}
          disabled={!dirty || status.kind === 'saving'}
        >
          {status.kind === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="module-config-form__revert"
          onClick={revert}
          disabled={!dirty}
        >
          Revert
        </button>
        {showSaved && (
          <span className="module-config-form__status module-config-form__status--ok">
            ✓ Saved
          </span>
        )}
        {status.kind === 'error' && (
          <span className="module-config-form__status module-config-form__status--error">
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}

interface FieldRowProps {
  name: string;
  property: JsonSchemaProperty;
  value: unknown;
  onChange: (next: unknown) => void;
}

function FieldRow({
  name,
  property,
  value,
  onChange,
}: FieldRowProps): React.JSX.Element {
  const title = property.title ?? name;
  const description = property.description;

  return (
    <label className="module-config-form__field">
      <div className="module-config-form__field-label">
        <span className="module-config-form__field-name">{title}</span>
        {description && (
          <span className="module-config-form__field-description">
            {description}
          </span>
        )}
      </div>
      <div className="module-config-form__field-input">
        <FieldInput property={property} value={value} onChange={onChange} />
      </div>
    </label>
  );
}

function FieldInput({
  property,
  value,
  onChange,
}: Omit<FieldRowProps, 'name'>): React.JSX.Element {
  if (property.enum && property.enum.length > 0) {
    return (
      <select
        className="module-config-form__select"
        value={value == null ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = property.enum!.find((opt) => String(opt) === raw);
          onChange(match ?? raw);
        }}
      >
        {property.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  }

  if (property.type === 'boolean') {
    const checked = typeof value === 'boolean' ? value : false;
    return (
      <input
        type="checkbox"
        className="module-config-form__checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }

  // Default: string input. Add integer/number/object/array branches when
  // a manifest actually ships one (YAGNI — Phase 5c only exercises
  // string + boolean + enum).
  const stringValue =
    typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return (
    <input
      type="text"
      className="module-config-form__text"
      value={stringValue}
      minLength={property.minLength}
      maxLength={property.maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function shallowEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
