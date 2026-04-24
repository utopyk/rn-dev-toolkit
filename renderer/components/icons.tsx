import React from 'react';
import {
  Terminal, Clock, Store, Settings as SettingsIcon,
  Wrench, FlaskConical, Radio, Bell, Zap, User,
  Search, Smartphone, Package, RefreshCw, Menu,
  Trash2, Eye, X, Plus, Play, Square, ChevronLeft,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2,
  Gauge, Box, History, type LucideIcon,
} from 'lucide-react';

export const Icons = {
  terminal: Terminal, clock: Clock, store: Store, settings: SettingsIcon,
  wrench: Wrench, flask: FlaskConical, radio: Radio, bell: Bell,
  zap: Zap, user: User, search: Search, phone: Smartphone,
  package: Package, refresh: RefreshCw, menu: Menu, trash: Trash2,
  eye: Eye, close: X, plus: Plus, play: Play, stop: Square,
  chevronLeft: ChevronLeft, chevronRight: ChevronRight, chevronDown: ChevronDown,
  alert: AlertTriangle, check: CheckCircle2, gauge: Gauge, box: Box,
  history: History,
} satisfies Record<string, LucideIcon>;

/** Map legacy emoji/string icon identifiers to lucide components. */
const LEGACY_MAP: Record<string, LucideIcon> = {
  '🚀': Terminal, '🔧': Wrench, '🧪': FlaskConical, '📡': Radio,
  '🛒': Store, '⚙': SettingsIcon, '📦': Package, '💻': Smartphone,
  '📱': Smartphone, '🗑': Trash2,
};

export function getModuleIcon(hint: string | undefined): LucideIcon {
  if (!hint) return Package;
  if (LEGACY_MAP[hint]) return LEGACY_MAP[hint];
  const k = hint.toLowerCase() as keyof typeof Icons;
  if (Icons[k]) return Icons[k];
  return Package;
}

export function ModuleIcon({ hint, size = 18 }: { hint?: string; size?: number }) {
  const Cmp = getModuleIcon(hint);
  return <Cmp size={size} strokeWidth={2} />;
}
