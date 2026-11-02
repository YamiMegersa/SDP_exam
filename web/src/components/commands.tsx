import { useCallback, useState } from 'react';
import { CheckCircle2, CircleDashed, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { useLive } from '../lib/hooks';
import { live } from '../lib/live';
import { clockTime } from '../lib/format';
import type { CommandRow, CommandState } from '../lib/types';
import { Pill } from './ui';

/**
 * Command dispatch.
 *
 * The platform is the only place that knows both the researcher code and the
 * route to the service, so the browser never publishes to MQTT itself: it POSTs
 * and waits for the ack to come back over the same WebSocket that carries
 * telemetry. The service's own reason code is shown verbatim - `precondition_failed`
 * with `no_target` is actionable, "command failed" is not.
 */
export function useCommand() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const send = useCallback(
    async (input: { service: string; entity: string; control: string; value: unknown; researcher: string }) => {
      const label = `${input.entity}/${input.control}`;
      setPending(label);
      setError(null);
      setMessage(null);
      try {
        const command = await api.sendCommand(input);
        upsertCommand(command);
        setMessage(`${label} accepted`);
        return true;
      } catch (cause) {
        setError(errorText(cause));
        return false;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return { send, pending, error, message, clear: () => setError(null) };
}

function upsertCommand(command: CommandRow): void {
  const index = live.commands.findIndex((row) => row.command_id === command.command_id);
  if (index >= 0) live.commands[index] = command;
  else live.commands = [command, ...live.commands];
}

const STATE_TONE: Record<CommandState, string> = {
  pending: 'neutral',
  accepted: 'inhand',
  in_progress: 'rta',
  completed: 'ok',
  rejected: 'crit',
  failed: 'crit',
  timeout: 'warn',
};

export function CommandStatePill({ state }: { state: CommandState }) {
  return <Pill tone={STATE_TONE[state] ?? 'neutral'}>{state.replace('_', ' ')}</Pill>;
}

export function CommandStateIcon({ state }: { state: CommandState }) {
  if (state === 'completed') return <CheckCircle2 size={12} className="text-ok" />;
  if (state === 'rejected' || state === 'failed') return <XCircle size={12} className="text-crit" />;
  if (state === 'in_progress' || state === 'accepted') return <Loader2 size={12} className="animate-spin text-rta" />;
  if (state === 'timeout') return <ShieldAlert size={12} className="text-warn" />;
  return <CircleDashed size={12} className="text-ink-500" />;
}

/**
 * Recent command traffic for one service. Empty is the normal state: a control
 * panel is mostly idle.
 */
export function CommandLog({ service, limit = 8 }: { service: string; limit?: number }) {
  useLive();
  const rows = live.commands.filter((row) => row.service === service).slice(0, limit);

  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-base-700 px-2 py-3 text-center text-2xs text-ink-500">
        no commands sent this session
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row) => (
        <li
          key={row.command_id}
          className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5"
        >
          <div className="flex items-center gap-1.5">
            <CommandStateIcon state={row.state} />
            <span className="telemetry-readout truncate text-2xs text-ink-200">
              {row.entity}/{row.control}
            </span>
            <span className="ml-auto flex-none">
              <CommandStatePill state={row.state} />
            </span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2 text-2xs text-ink-500">
            <span className="telemetry-readout truncate">{truncateValue(row.value)}</span>
            <span className="telemetry-readout ml-auto flex-none">{clockTime(row.sent_ts)}</span>
          </div>
          {row.reason || row.detail ? (
            <div className="telemetry-readout mt-0.5 truncate text-2xs text-warn">
              {row.reason}
              {row.detail ? ` \u00b7 ${row.detail}` : ''}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function truncateValue(value: unknown): string {
  // The store hands back the decoded value, so a `set_target` command is an
  // object here. Rendering it raw is what crashed the workspace: stringify first,
  // then shorten, so the log line stays one line wide whatever the schema allows.
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 48 ? `${text.slice(0, 45)}\u2026` : text;
}

export function CommandFeedback({ error, message }: { error: string | null; message: string | null }) {
  if (!error && !message) return null;
  return (
    <div
      className={`rounded border px-2 py-1.5 text-2xs ${
        error ? 'border-crit/40 bg-crit/10 text-crit' : 'border-ok/40 bg-ok/10 text-ok'
      }`}
    >
      {error ?? message}
    </div>
  );
}
