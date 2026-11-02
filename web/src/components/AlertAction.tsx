import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../lib/api';
import { useResearcher } from '../lib/hooks';
import { dateTime } from '../lib/format';
import type { AlertRecord } from '../lib/types';
import { Button, Field, Modal, Pill, Select, TextInput } from './ui';

/**
 * Acknowledge / resolve flow.
 *
 * An alert transition is an audited statement about who is on duty, so the code is checked
 * against the ARL researcher directory before it can be submitted, and the server checks it
 * again before it writes anything (`GET /api/researchers/:code` -> 403 `unknown_researcher`).
 * The summary line below the field is the operator's own confirmation that the name about to
 * enter the permanent record is the right one.
 */

const CAUSES = [
  'Environmental drift',
  'Hardware fault',
  'Power instability',
  'Sensor / telemetry fault',
  'Planned maintenance',
  'Operator error',
  'Unknown / under investigation',
];

export function AlertActionModal({
  alert,
  mode,
  onClose,
  onDone,
}: {
  alert: AlertRecord | null;
  mode: 'acknowledge' | 'resolve' | null;
  onClose: () => void;
  onDone: (alert: AlertRecord) => void;
}) {
  const [code, setCode] = useResearcher();
  const [note, setNote] = useState('');
  const [cause, setCause] = useState(CAUSES[0]!);
  const [verified, setVerified] = useState<'idle' | 'checking' | 'valid' | 'invalid' | 'unavailable'>(
    'idle',
  );
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!alert) return;
    setNote('');
    setError(null);
    setVerified('idle');
    setName(null);
    // Keyed on the identity of the alert rather than the object, which is replaced on every
    // refetch of the board.
  }, [alert?.alert_id, mode]);

  useEffect(() => {
    const candidate = code.trim().toLowerCase();
    if (candidate.length < 3) {
      setVerified('idle');
      setName(null);
      return;
    }
    let cancelled = false;
    setVerified('checking');
    const timer = window.setTimeout(() => {
      api
        .researchers(candidate)
        .then((researcher) => {
          if (cancelled) return;
          setName(researcher.name);
          setVerified('valid');
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setName(null);
          // A 404 is the directory answering "no such code". Anything else means we could not
          // ask, which is also a refusal, but the operator deserves to know which it was.
          const answered =
            cause instanceof ApiError && (cause.status === 404 || cause.status === 400);
          setVerified(answered ? 'invalid' : 'unavailable');
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Re-checks when the dialog opens on a saved code, not only when it is edited.
  }, [code, alert?.alert_id, mode]);

  if (!alert || !mode) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const researcher = code.trim().toLowerCase();
      const result =
        mode === 'acknowledge'
          ? await api.acknowledge(alert.alert_id, { researcher, note: note.trim() || undefined })
          : await api.resolve(alert.alert_id, {
              researcher,
              resolution: note.trim(),
              cause: cause,
            });
      onDone(result.alert);
      onClose();
    } catch (causeError) {
      setError(errorText(causeError));
    } finally {
      setBusy(false);
    }
  };

  const alreadyAcknowledged = alert.ack_ts !== null;
  // No verified identity, no transition: the audit trail is only as trustworthy as the gate in
  // front of it. The server re-checks, so a code revoked mid-session is still refused there.
  const canSubmit =
    verified === 'valid' &&
    (mode === 'acknowledge' || note.trim().length >= 3) &&
    !busy;

  return (
    <Modal
      open
      title={mode === 'acknowledge' ? 'Acknowledge alert' : 'Resolve alert'}
      subtitle={
        mode === 'acknowledge'
          ? 'Records that an operator on duty has seen the hazard.'
          : 'Closes the alert out. The explanation is kept in the permanent audit trail.'
      }
      onClose={onClose}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone={mode === 'acknowledge' ? 'primary' : 'danger'}
            onClick={submit}
            disabled={!canSubmit}
            busy={busy}
          >
            {mode === 'acknowledge' ? 'Acknowledge' : 'Resolve'}
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded border border-base-700 bg-base-950 p-2.5">
        <div className="mb-1 flex items-center gap-2">
          <Pill tone={alert.severity === 'critical' ? 'crit' : alert.severity === 'warning' ? 'warn' : 'neutral'}>
            {alert.severity}
          </Pill>
          <Pill tone="neutral">{alert.service}</Pill>
          <span className="telemetry-readout text-2xs text-ink-400">{alert.alert_id}</span>
        </div>
        <p className="text-xs text-ink-200">{alert.message ?? alert.type}</p>
        <p className="mt-1 text-2xs text-ink-500">
          Raised {dateTime(alert.raised_ts)}
          {alert.entity ? ` \u00b7 ${alert.entity}` : ''}
          {alreadyAcknowledged && alert.ack_by ? ` \u00b7 acknowledged by ${alert.ack_by}` : ''}
        </p>
      </div>

      <div className="grid gap-3">
        <Field
          label="Researcher code"
          hint={
            verified === 'checking'
              ? 'verifying\u2026'
              : verified === 'valid'
                ? name ?? 'verified'
                : verified === 'invalid'
                  ? 'not in directory'
                  : verified === 'unavailable'
                    ? 'directory unreachable'
                    : 'ARL directory'
          }
        >
          <TextInput
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="arl-as3"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {verified === 'invalid' ? (
          <p className="-mt-2 text-2xs text-crit">
            No researcher with that code, so the alert cannot be signed off. Check the code or use
            another operator's.
          </p>
        ) : null}

        {verified === 'unavailable' ? (
          <p className="-mt-2 text-2xs text-warn">
            The ARL directory could not be reached, so the code cannot be verified. Retrying
            shortly is the only way through: an unsigned transition is not recorded.
          </p>
        ) : null}

        {mode === 'resolve' ? (
          <Field label="Cause">
            <Select value={cause} onChange={(event) => setCause(event.target.value)}>
              {CAUSES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field
          label={mode === 'acknowledge' ? 'Note (optional)' : 'Resolution'}
          hint={mode === 'resolve' ? `${note.trim().length}/500, min 3` : 'max 500'}
        >
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 500))}
            rows={3}
            placeholder={
              mode === 'acknowledge'
                ? 'What was observed / first action taken'
                : 'What was done, and what proves the hazard is gone'
            }
            className="w-full resize-none rounded border border-base-600 bg-base-950 px-2 py-1.5 text-xs text-ink-100 placeholder:text-ink-500 focus:border-rta/60 focus:outline-none"
          />
        </Field>

        {error ? (
          <p className="rounded border border-crit/40 bg-crit/10 px-2 py-1.5 text-2xs text-crit">{error}</p>
        ) : null}
      </div>
    </Modal>
  );
}
