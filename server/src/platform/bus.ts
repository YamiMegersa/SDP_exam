import { logger } from '../util/log';

const log = logger('bus');

/**
 * In-process fan-out from the services that produce data (ingest, alerts, commands, replay) to the
 * consumers that shape it for browsers (websocket hub, replay recorder).
 *
 * Deliberately synchronous and allocation-light: at ARL_SPEEDUP=1 the RTA scan alone pushes roughly
 * 90 payloads a second, so a promise per message would be wasteful. A slow handler is a bug, not a
 * case to absorb, so handlers must not do I/O.
 */
export class Bus<T> {
  private readonly handlers = new Set<(event: T) => void>();

  on(handler: (event: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: T): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (error) {
        log.error(`handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
