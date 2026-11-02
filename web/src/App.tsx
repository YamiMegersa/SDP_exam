import { useCallback, useEffect, useState } from 'react';
import { Shell, type Route } from './components/Shell';
import { AlertsPage } from './pages/Alerts';
import { MhePage } from './pages/Mhe';
import { OpgPage } from './pages/Opg';
import { OverviewPage } from './pages/Overview';
import { ReplayPage } from './pages/Replay';
import { RtaPage } from './pages/Rta';

/**
 * Routing.
 *
 * Hash routing, not history routing: the console is served as a static bundle by
 * the same process that owns the API, and a hash keeps deep links working even
 * when the SPA fallback is not in front of it (a bare `file://` build, a reverse
 * proxy that only forwards `/api`, a saved bookmark from a laptop).
 */

const ROUTES: Route[] = ['overview', 'rta', 'mhe', 'opg', 'alerts', 'replay'];

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  return (ROUTES as string[]).includes(hash) ? (hash as Route) : 'overview';
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: Route) => {
    if (readRoute() !== next) window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  return (
    <Shell route={route} onRoute={navigate}>
      {route === 'overview' ? <OverviewPage onRoute={navigate} /> : null}
      {route === 'rta' ? <RtaPage /> : null}
      {route === 'mhe' ? <MhePage /> : null}
      {route === 'opg' ? <OpgPage /> : null}
      {route === 'alerts' ? <AlertsPage /> : null}
      {route === 'replay' ? <ReplayPage /> : null}
    </Shell>
  );
}
