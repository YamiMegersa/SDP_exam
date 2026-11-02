import { useMemo, useState } from 'react';
import { AlertTriangle, BellOff, CheckCircle2, ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { live } from '../lib/live';
import { useLive, useTick } from '../lib/hooks';
import { clockTime, since } from '../lib/format';
import type { AlertRecord } from '../lib/types';
import { AlertActionModal } from './AlertAction';
import { Pill } from './ui';

/**
 * Zone 2 of the layout: the master alarm board.
 *
 * It never scrolls away, because the one thing an operator must not have to go
 * looking for is an active alarm. Unacknowledged tiles flash at ~1.5 Hz; the
 * strip stays on screen whether or not the current page is even about that
 * service, and the counts are always the platform-wide totals.
 *
 * Resolved (not merely cleared) alerts leave the board: a service clearing its
 * own alert means the reading came back, not that a human has dealt with it, so
 * cleared alerts stay listed until somebody resolves them.
 */
export function Annunciator({ onOpenLog }: { onOpenLog: () => void }) {
  const version = useLive();
  useTick(2000);
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<AlertRecord | null>(null);
  const [mode, setMode] = useState<'acknowledge' | 'resolve' | null>(null);

  const active = useMemo(() => live.activeAlerts(), [version]);
  const critical = active.filter((alert) => alert.severity === 'critical');
  const unacknowledged = active.filter((alert) => alert.ack_ts === null);
  const cleared = live.clearedAlerts().length;
  const worst = critical.length > 0 ? 'crit' : active.length > 0 ? 'warn' : 'ok';

  const open = (alert: AlertRecord, next: 'acknowledge' | 'resolve') => {
    setSelected(alert);
    setMode(next);
  };

  if (active.length === 0) {
    return (
      <div className="flex items-center gap-3 border-y border-base-700 bg-base-900 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-widest text-ok">
          <ShieldCheck size={13} /> annunciator clear
        </span>
        <span className="text-2xs text-ink-500">
          no alarms in alarm state
          {cleared > 0 ? ` \u00b7 ${cleared} cleared awaiting resolution` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onOpenLog} className="text-2xs uppercase tracking-wider text-ink-400 hover:text-ink-100">
            alert log
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        className={`border-y ${
          critical.length > 0 ? 'border-crit/40 bg-crit/10' : 'border-warn/40 bg-warn/10'
        }`}
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span
            className={`flex flex-none items-center gap-1.5 text-2xs font-bold uppercase tracking-widest ${
              worst === 'crit' ? 'text-crit' : 'text-warn'
            }`}
          >
            <AlertTriangle size={13} className="annunciator-flash" />
            {critical.length > 0 ? 'critical alarm' : 'alarm'}
          </span>

          <div className="flex flex-none items-center gap-1.5">
            <Pill tone={critical.length > 0 ? 'crit' : 'warn'}>{active.length} active</Pill>
            {critical.length > 0 ? <Pill tone="crit">{critical.length} critical</Pill> : null}
            {unacknowledged.length > 0 ? <Pill tone="warn">{unacknowledged.length} unack</Pill> : null}
            {cleared > 0 ? <Pill tone="inert">{cleared} cleared</Pill> : null}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto scroll-thin">
            <div className="flex items-stretch gap-1.5">
              {active.slice(0, 12).map((alert) => (
                <AnnunciatorTile
                  key={alert.alert_id}
                  alert={alert}
                  onAck={() => open(alert, 'acknowledge')}
                  onDetails={() => open(alert, alert.ack_ts ? 'resolve' : 'acknowledge')}
                />
              ))}
            </div>
          </div>

          <button
            onClick={() => setCollapsed((value) => !value)}
            className="flex-none rounded p-1 text-ink-400 hover:bg-base-800 hover:text-ink-100"
            aria-label={collapsed ? 'Expand annunciator' : 'Collapse annunciator'}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button
            onClick={onOpenLog}
            className="flex-none text-2xs uppercase tracking-wider text-ink-300 hover:text-ink-100"
          >
            log
          </button>
        </div>

        {!collapsed ? (
          <div className="flex items-center gap-3 border-t border-black/20 px-3 py-1 text-2xs text-ink-400">
            <span className="flex items-center gap-1">
              <BellOff size={11} />
              acknowledged alerts stay listed until resolved
            </span>
            <span className="telemetry-readout ml-auto">
              worst: {active[0]?.service}/{active[0]?.type}
            </span>
            <span className="telemetry-readout">{clockTime(active[0]?.raised_ts)}</span>
          </div>
        ) : null}
      </div>

      <AlertActionModal
        alert={selected}
        mode={mode}
        onClose={() => {
          setSelected(null);
          setMode(null);
        }}
        onDone={(alert) => live.upsertAlert(alert)}
      />
    </>
  );
}

function AnnunciatorTile({
  alert,
  onAck,
  onDetails,
}: {
  alert: AlertRecord;
  onAck: () => void;
  onDetails: () => void;
}) {
  const tone =
    alert.severity === 'critical'
      ? 'border-crit/70 text-crit'
      : alert.severity === 'warning'
        ? 'border-warn/70 text-warn'
        : 'border-base-600 text-ink-200';
  const flashing = alert.ack_ts === null && alert.severity !== 'info';

  return (
    <div
      className={`flex max-w-[320px] flex-none items-center gap-1.5 rounded border px-2 py-1 ${tone} ${
        flashing ? 'annunciator-flash' : 'bg-base-900/70'
      }`}
    >
      <button onClick={onDetails} className="min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-bold uppercase tracking-wide">{alert.service}</span>
          <span className="telemetry-readout text-2xs opacity-70">{alert.entity ?? alert.type}</span>
        </div>
        <div className="truncate text-2xs text-ink-200">{alert.message ?? alert.type}</div>
        <div className="telemetry-readout text-2xs text-ink-500">
          {clockTime(alert.last_ts)} · {since(alert.last_ts, live.simTime ?? alert.last_ts)}
        </div>
      </button>
      {alert.ack_ts === null ? (
        <button
          onClick={onAck}
          className="flex-none rounded border border-current/40 px-1 py-0.5 text-2xs font-bold uppercase tracking-wide hover:bg-black/30"
        >
          ack
        </button>
      ) : (
        <CheckCircle2 size={13} className="flex-none text-inhand" />
      )}
    </div>
  );
}
