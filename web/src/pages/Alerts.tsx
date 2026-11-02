import { useEffect, useMemo, useState } from 'react';
import { Download, Filter, RefreshCw } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { AlertActionModal } from '../components/AlertAction';
import { Button, Empty, Panel, PanelHead, Pill } from '../components/ui';
import { clockTime, dateTime } from '../lib/format';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import type { AlertRecord, AlertTransition } from '../lib/types';

/**
 * The permanent alert record.
 *
 * Three different questions live here, and the filters are the questions:
 * what is in alarm (active), what did a service clear but nobody has closed out
 * (cleared), and what has been dealt with (resolved). The transition list is the
 * audit trail - every raise, escalation, clear, acknowledgement and resolution,
 * with the researcher code that performed it.
 */

type FilterId = 'active' | 'cleared' | 'unacknowledged' | 'resolved' | 'all';

const FILTERS: Array<{ id: FilterId; label: string; status: string }> = [
  { id: 'active', label: 'In alarm', status: 'raised' },
  { id: 'unacknowledged', label: 'Unacknowledged', status: 'unacknowledged' },
  { id: 'cleared', label: 'Cleared', status: 'cleared' },
  { id: 'resolved', label: 'Resolved', status: 'resolved' },
  { id: 'all', label: 'All', status: '' },
];

export function AlertsPage() {
  const version = useLive();
  const [filter, setFilter] = useState<FilterId>('active');
  const [service, setService] = useState<string>('');
  const [rows, setRows] = useState<AlertRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AlertRecord | null>(null);
  const [transitions, setTransitions] = useState<AlertTransition[]>([]);
  const [action, setAction] = useState<'acknowledge' | 'resolve' | null>(null);

  const status = FILTERS.find((entry) => entry.id === filter)?.status ?? '';

  const load = useMemo(() => {
    return async () => {
      setLoading(true);
      try {
        const response = await api.alerts({ status: status || undefined, service: service || undefined, limit: 300 });
        setRows(response.alerts);
        setError(null);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setLoading(false);
      }
    };
  }, [status, service]);

  useEffect(() => {
    void load();
  }, [load]);

  // The list itself is fetched; anything that changed since then is overlaid from
  // the live map, so an acknowledgement made in another tab shows up without a reload.
  const displayed = useMemo(
    () => rows.map((row) => live.alerts.get(row.alert_id) ?? row),
    [rows, version],
  );

  useEffect(() => {
    if (!selected) {
      setTransitions([]);
      return;
    }
    let cancelled = false;
    api
      .alert(selected.alert_id)
      .then((detail) => {
        if (cancelled) return;
        setSelected(detail.alert);
        setTransitions(detail.transitions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selected?.alert_id]);

  const onDone = (alert: AlertRecord) => {
    live.upsertAlert(alert);
    setSelected(alert);
    void load();
  };

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-hidden p-2 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Panel className="min-h-0">
        <PanelHead
          title="Alert log"
          hint={`${displayed.length} shown \u00b7 ${live.counts.open} in alarm \u00b7 ${live.counts.total} recorded`}
          icon={<Filter size={13} />}
          right={
            <Button tone="ghost" onClick={() => void load()} busy={loading}>
              <RefreshCw size={12} /> refresh
            </Button>
          }
        />

        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setFilter(entry.id)}
              className={`rounded border px-2 py-1 text-2xs font-medium uppercase tracking-wide transition-colors ${
                filter === entry.id
                  ? 'border-rta/60 bg-rta/15 text-rta'
                  : 'border-base-700 bg-base-800 text-ink-400 hover:text-ink-200'
              }`}
            >
              {entry.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {['', 'rta', 'mhe', 'opg', 'platform'].map((code) => (
              <button
                key={code || 'all'}
                onClick={() => setService(code)}
                className={`rounded border px-2 py-1 text-2xs uppercase tracking-wide ${
                  service === code ? 'border-base-600 bg-base-700 text-ink-100' : 'border-base-700 text-ink-400'
                }`}
              >
                {code || 'all svc'}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <p className="mb-2 rounded border border-crit/40 bg-crit/10 px-2 py-1.5 text-2xs text-crit">{error}</p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          {rows.length === 0 ? (
            <Empty>nothing matches this filter</Empty>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-base-900">
                <tr className="text-left text-2xs uppercase tracking-wider text-ink-500">
                  <th className="pb-1 pr-2 font-medium">severity</th>
                  <th className="pb-1 pr-2 font-medium">service</th>
                  <th className="pb-1 pr-2 font-medium">source</th>
                  <th className="pb-1 pr-2 font-medium">message</th>
                  <th className="pb-1 pr-2 font-medium">raised</th>
                  <th className="pb-1 pr-2 font-medium">status</th>
                  <th className="pb-1 font-medium">by</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((alert) => (
                  <tr
                    key={alert.alert_id}
                    onClick={() => setSelected(alert)}
                    className={`cursor-pointer border-t border-base-700/60 hover:bg-base-800/50 ${
                      selected?.alert_id === alert.alert_id ? 'bg-base-800/70' : ''
                    }`}
                  >
                    <td className="py-1 pr-2">
                      <Pill tone={alert.severity === 'critical' ? 'crit' : alert.severity === 'warning' ? 'warn' : 'neutral'}>
                        {alert.severity}
                      </Pill>
                    </td>
                    <td className="py-1 pr-2 text-2xs uppercase tracking-wide text-ink-300">{alert.service}</td>
                    <td className="telemetry-readout py-1 pr-2 text-2xs text-ink-400">
                      {alert.entity ?? alert.type}
                    </td>
                    <td className="max-w-[280px] truncate py-1 pr-2 text-ink-200">{alert.message ?? alert.type}</td>
                    <td className="telemetry-readout py-1 pr-2 text-2xs text-ink-500">{clockTime(alert.raised_ts)}</td>
                    <td className="py-1 pr-2">
                      <StatusPill alert={alert} />
                    </td>
                    <td className="telemetry-readout py-1 text-2xs text-ink-500">
                      {alert.resolved_by ?? alert.ack_by ?? '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-2">
        <Panel className="min-h-0 overflow-y-auto scroll-thin">
          <PanelHead title="Detail" hint={selected ? selected.alert_id : 'select a row'} />
          {!selected ? (
            <Empty>no alert selected</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <Pill tone={selected.severity === 'critical' ? 'crit' : selected.severity === 'warning' ? 'warn' : 'neutral'}>
                    {selected.severity}
                  </Pill>
                  <Pill tone="neutral">{selected.origin}</Pill>
                  <StatusPill alert={selected} />
                  {selected.escalate_count > 0 ? <Pill tone="warn">escalated x{selected.escalate_count}</Pill> : null}
                </div>
                <p className="text-xs text-ink-100">{selected.message ?? selected.type}</p>
                <p className="telemetry-readout mt-1 text-2xs text-ink-500">
                  {selected.service}/{selected.entity ?? 'service'}{' \u00b7 '}type {selected.type}
                  {selected.value !== null ? ` \u00b7 value ${selected.value}${selected.unit ?? ''}` : ''}
                  {selected.limit_value !== null ? ` \u00b7 limit ${selected.limit_value}` : ''}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                <Line label="raised" value={dateTime(selected.raised_ts)} />
                <Line label="last update" value={clockTime(selected.last_ts)} />
                <Line label="cleared" value={selected.cleared_ts ? dateTime(selected.cleared_ts) : '\u2014'} />
                <Line label="acknowledged" value={selected.ack_ts ? dateTime(selected.ack_ts) : '\u2014'} />
                <Line label="ack by" value={selected.ack_by ?? '\u2014'} />
                <Line label="resolved" value={selected.resolved_ts ? dateTime(selected.resolved_ts) : '\u2014'} />
                <Line label="resolved by" value={selected.resolved_by ?? '\u2014'} />
                <Line label="cause" value={selected.cause ?? '\u2014'} />
              </div>

              {selected.ack_note ? (
                <p className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5 text-2xs text-ink-300">
                  <span className="text-ink-500">ack note: </span>
                  {selected.ack_note}
                </p>
              ) : null}
              {selected.resolution ? (
                <p className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5 text-2xs text-ink-300">
                  <span className="text-ink-500">resolution: </span>
                  {selected.resolution}
                </p>
              ) : null}

              <div className="flex gap-1.5">
                <Button
                  tone="primary"
                  disabled={selected.ack_ts !== null}
                  onClick={() => setAction('acknowledge')}
                >
                  acknowledge
                </Button>
                <Button
                  tone="danger"
                  disabled={selected.resolved_ts !== null}
                  onClick={() => setAction('resolve')}
                >
                  resolve
                </Button>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-2xs font-bold uppercase tracking-widest text-ink-400">audit trail</span>
                  <span className="h-px flex-1 bg-base-700" />
                  <Download size={11} className="text-ink-500" />
                </div>
                <ol className="flex flex-col gap-1">
                  {transitions.length === 0 ? (
                    <li className="text-2xs text-ink-500">no transitions recorded</li>
                  ) : (
                    transitions.map((transition) => (
                      <li key={transition.id} className="flex items-baseline gap-2 text-2xs">
                        <span className="telemetry-readout w-16 flex-none text-ink-500">{clockTime(transition.ts)}</span>
                        <span className="w-20 flex-none font-medium uppercase tracking-wide text-ink-300">
                          {transition.action}
                        </span>
                        <span className="telemetry-readout flex-none text-rta">{transition.actor ?? '\u2014'}</span>
                        <span className="truncate text-ink-500">{transition.note ?? ''}</span>
                      </li>
                    ))
                  )}
                </ol>
              </div>
            </div>
          )}
        </Panel>
      </div>

      <AlertActionModal
        alert={selected}
        mode={action}
        onClose={() => setAction(null)}
        onDone={onDone}
      />
    </div>
  );
}

function StatusPill({ alert }: { alert: AlertRecord }) {
  if (alert.resolved_ts !== null) return <Pill tone="inert">resolved</Pill>;
  if (alert.status === 'cleared') return <Pill tone="neutral">cleared</Pill>;
  if (alert.ack_ts !== null) return <Pill tone="inhand">ack</Pill>;
  return <Pill tone="warn">in alarm</Pill>;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-base-700/40 py-0.5">
      <span className="text-ink-500">{label}</span>
      <span className="telemetry-readout text-ink-200">{value}</span>
    </div>
  );
}
