import { useEffect, useRef } from 'react';
import { useIpcInvoke } from '../hooks/useIpc';

export interface ModulePanelProps {
  moduleId: string;
  panelId: string;
  /** Optional class for the container. */
  className?: string;
}

/**
 * Empty-container React component that marks the viewport for a
 * module-contributed `WebContentsView` in the Electron main process.
 *
 * Lifecycle:
 *   - mount → `invoke('modules:activate-panel', { moduleId, panelId, bounds })`
 *   - own DOMRect changes → `invoke('modules:set-panel-bounds', ...)`
 *   - unmount → `invoke('modules:deactivate-panel', ...)`
 *
 * The WebContentsView is composited BELOW the React app by Electron — this
 * component doesn't render the panel's HTML itself, it only reserves a
 * rectangle and tells main where to mount the view.
 */
export function ModulePanel({ moduleId, panelId, className }: ModulePanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const invoke = useIpcInvoke();
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };

    const initial = measure();
    lastBoundsRef.current = initial;
    invoke('modules:activate-panel', { moduleId, panelId, bounds: initial });

    const observer = new ResizeObserver(() => {
      const next = measure();
      const prev = lastBoundsRef.current;
      if (
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        return;
      }
      lastBoundsRef.current = next;
      invoke('modules:set-panel-bounds', { moduleId, panelId, bounds: next });
    });
    observer.observe(el);

    // Position changes that don't resize the element (sidebar collapse, banner
    // toggle) — catch these via window resize + next animation-frame remeasure.
    const onWindowResize = () => {
      const next = measure();
      lastBoundsRef.current = next;
      invoke('modules:set-panel-bounds', { moduleId, panelId, bounds: next });
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      invoke('modules:deactivate-panel', { moduleId, panelId });
    };
  }, [moduleId, panelId, invoke]);

  return <div ref={ref} className={className} style={{ flex: 1, width: '100%', height: '100%' }} />;
}
