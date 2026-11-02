import type { ReactNode } from 'react';

/**
 * Console primitives.
 *
 * Deliberately few: a panel, a header, a numeric readout, a status pill, a
 * button, a form field and a modal. Every page is assembled from these so the
 * instrument language stays identical across the three services.
 */

export function Panel({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <section className={`arl-panel flex min-h-0 flex-col ${padded ? 'p-3' : ''} ${className}`}>{children}</section>;
}

export function PanelHead({
  title,
  hint,
  icon,
  right,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="mb-2 flex items-baseline justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {icon ? <span className="text-ink-400">{icon}</span> : null}
        <h2 className="truncate text-xs font-medium uppercase tracking-wider text-ink-300">{title}</h2>
        {hint ? <span className="truncate text-2xs text-ink-500">{hint}</span> : null}
      </div>
      {right ? <div className="flex flex-none items-center gap-1">{right}</div> : null}
    </header>
  );
}

const TONES = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  inhand: 'text-inhand',
  inert: 'text-ink-500',
  neutral: 'text-ink-100',
  rta: 'text-rta',
  mhe: 'text-mhe',
  opg: 'text-opg',
  replay: 'text-replay',
} as const;

export type Tone = keyof typeof TONES;

/** Primary telemetry readout: big, monospaced, tabular. */
export function Readout({
  value,
  unit,
  label,
  tone = 'neutral',
  size = 'md',
  className = '',
}: {
  value: ReactNode;
  unit?: string;
  label?: string;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const scale = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-lg';
  return (
    <div className={`min-w-0 ${className}`}>
      {label ? (
        <div className="mb-0.5 truncate text-2xs font-medium uppercase tracking-wider text-ink-400">{label}</div>
      ) : null}
      <div className={`telemetry-readout ${scale} font-bold leading-tight ${TONES[tone]}`}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-ink-400">{unit}</span> : null}
      </div>
    </div>
  );
}

export function Led({ state, className = '' }: { state: 'ok' | 'warn' | 'crit' | 'inert'; className?: string }) {
  const cls =
    state === 'ok' ? 'led-nominal' : state === 'warn' ? 'led-caution' : state === 'crit' ? 'led-alarm' : 'led-inert';
  return <span className={`led ${cls} ${className}`} aria-hidden />;
}

const PILL_TONES: Record<string, string> = {
  ok: 'border-ok/40 bg-ok/10 text-ok',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  crit: 'border-crit/50 bg-crit/15 text-crit',
  inhand: 'border-inhand/40 bg-inhand/10 text-inhand',
  neutral: 'border-base-600 bg-base-800 text-ink-300',
  inert: 'border-base-600 bg-base-800 text-ink-500',
  replay: 'border-replay/40 bg-replay/10 text-replay',
  rta: 'border-rta/40 bg-rta/10 text-rta',
  mhe: 'border-mhe/40 bg-mhe/10 text-mhe',
  opg: 'border-opg/40 bg-opg/10 text-opg',
};

export function Pill({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide ${
        PILL_TONES[tone] ?? PILL_TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  tone = 'default',
  disabled,
  busy,
  type = 'button',
  className = '',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger' | 'ghost' | 'warn';
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
}) {
  const tones = {
    default: 'border-base-600 bg-base-800 text-ink-200 hover:border-base-600 hover:bg-base-700',
    primary: 'border-rta/50 bg-rta/15 text-rta hover:bg-rta/25',
    danger: 'border-crit/50 bg-crit/15 text-crit hover:bg-crit/25',
    warn: 'border-warn/50 bg-warn/15 text-warn hover:bg-warn/25',
    ghost: 'border-transparent bg-transparent text-ink-300 hover:bg-base-800',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {busy ? <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-400">{label}</span>
        {hint ? <span className="telemetry-readout text-2xs text-ink-500">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  'w-full rounded border border-base-600 bg-base-950 px-2 py-1.5 text-xs text-ink-100 ' +
  'placeholder:text-ink-500 focus:border-rta/60 focus:outline-none';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} telemetry-readout ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`${inputClass} appearance-none bg-[length:10px] pr-6 ${props.className ?? ''}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8' fill='%2364748b'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2364748b' stroke-width='1.5' fill='none'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
        ...props.style,
      }}
    />
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[8vh]">
      <div
        className={`w-full ${width} rounded-md border border-base-600 bg-base-900 shadow-2xl`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-start justify-between gap-3 border-b border-base-700 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-2xs text-ink-400">{subtitle}</p> : null}
          </div>
          <button
            onClick={onClose}
            className="rounded px-1.5 text-lg leading-none text-ink-400 hover:bg-base-800 hover:text-ink-100"
            aria-label="Close"
          >
            &times;
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto scroll-thin px-4 py-3">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-base-700 px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Label + value used everywhere in dense sidebars. */
export function Datum({
  label,
  value,
  tone = 'neutral',
  mono = true,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-base-700/50 py-1 last:border-0">
      <span className="truncate text-2xs uppercase tracking-wide text-ink-400">{label}</span>
      <span className={`flex-none text-xs ${mono ? 'telemetry-readout' : ''} ${TONES[tone]}`}>{value}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded border border-dashed border-base-700 px-3 py-6 text-center text-2xs text-ink-500">
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 mt-3 flex items-center gap-2 first:mt-0">
      <span className="text-2xs font-bold uppercase tracking-widest text-ink-400">{children}</span>
      <span className="h-px flex-1 bg-base-700" />
    </div>
  );
}
