import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../lib/api';
import type { AlertRecord } from '../lib/types';
import { Pill } from './ui';
import { dateTime, num as fmtNum } from '../lib/format';

/**
 * Alert context card (Planning Docs/05 §4.3).
 *
 * Shows the full context pack for an alert: measured values, history, siblings, related alerts,
 * suggested controls, and a narrative summary. Loaded lazily from `GET /api/alerts/:id/context`.
 */

interface MeasuredValue {
  key: string;
  value: number;
  unit: string | null;
  limit: number | null;
  limitKey: string | null;
  direction: 'above' | 'below' | null;
}

interface HistoryEntry {
  ts: number;
  value: number;
}

interface SiblingValue {
  entity: string;
  value: number;
  state: 'ok' | 'warn' | 'crit' | 'unknown';
}

interface RelatedAlert {
  service: string;
  type: string;
  alert_id: string;
  ts: number;
}

interface ControlSuggestion {
  service: string;
  entity: string;
  control: string;
  label: string;
  value: unknown;
  rationale: string;
}

interface AlertContext {
  alert: AlertRecord;
  measured: MeasuredValue[];
  history: HistoryEntry[];
  siblings: SiblingValue[];
  related: RelatedAlert[];
  suggested_controls: ControlSuggestion[];
  suppressed_controls: Array<{ control: string; why: string }>;
  narrative: string;
  context_quality: 'complete' | 'partial';
}

export function AlertContextCard({ alert }: { alert: AlertRecord }) {
  const [context, setContext] = useState<AlertContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .alertContext(alert.alert_id)
      .then((data) => {
        if (!cancelled) setContext(data as AlertContext);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? errorText(err) : 'Failed to load context');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [alert.alert_id]);

  if (loading) {
    return <div className="text-sm text-gray-500">Loading context…</div>;
  }

  if (error) {
    return <div className="text-sm text-red-600">{error}</div>;
  }

  if (!context) {
    return null;
  }

  return (
    <div className="space-y-4 text-sm">
      {context.context_quality === 'partial' && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800">
          Some context data is unavailable.
        </div>
      )}

      {context.narrative && (
        <section>
          <h4 className="mb-1 font-semibold">Summary</h4>
          <p className="whitespace-pre-line text-gray-700">{context.narrative}</p>
        </section>
      )}

      {context.measured.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Measured Values</h4>
          <table className="w-full text-left">
            <tbody>
              {context.measured.map((m) => (
                <tr key={m.key} className="border-t border-gray-200">
                  <td className="py-1 pr-2 text-gray-600">{formatKey(m.key)}</td>
                  <td className="py-1 pr-2 font-mono">
                    {fmtNum(m.value)}
                    {m.unit ? ` ${m.unit}` : ''}
                  </td>
                  <td className="py-1 text-gray-500">
                    {m.limit !== null && (
                      <>
                        {m.direction === 'above' ? '≥' : '≤'} {fmtNum(m.limit)}
                        {m.unit ? ` ${m.unit}` : ''}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {context.history.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">
            History ({context.history.length} samples over 30 min)
          </h4>
          <div className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs">
            {context.history.map((h, i) => (
              <div key={i} className="flex justify-between">
                <span>{dateTime(h.ts)}</span>
                <span>{fmtNum(h.value)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {context.siblings.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Siblings ({context.siblings.length})</h4>
          <div className="flex flex-wrap gap-1">
            {context.siblings.map((s) => (
              <Pill key={s.entity} tone={stateTone(s.state)}>
                {s.entity}: {fmtNum(s.value)}
              </Pill>
            ))}
          </div>
        </section>
      )}

      {context.related.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Related Alerts ({context.related.length})</h4>
          <ul className="list-disc space-y-1 pl-5">
            {context.related.map((r) => (
              <li key={r.alert_id}>
                <span className="font-mono text-xs">
                  {r.service}/{r.type}
                </span>{' '}
                at {dateTime(r.ts)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {context.suggested_controls.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Suggested Controls</h4>
          <ul className="list-disc space-y-1 pl-5">
            {context.suggested_controls.map((s) => (
              <li key={s.control}>
                <strong>{s.label}</strong>: {s.rationale}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function formatKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function stateTone(state: 'ok' | 'warn' | 'crit' | 'unknown'): 'green' | 'amber' | 'red' | 'grey' {
  switch (state) {
    case 'ok':
      return 'green';
    case 'warn':
      return 'amber';
    case 'crit':
      return 'red';
    default:
      return 'grey';
  }
}
