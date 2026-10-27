import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import type { Me } from '../../src/contracts.ts';
import { AccountPage } from './account.tsx';
import { ActionCenterPage } from './actions.tsx';
import { ApiError, api, authClient, getActiveTenant, setActiveTenant } from './api.ts';
import { AssistantPage } from './assistant.tsx';
import { DashboardPage } from './dashboard.tsx';
import { ForecastPage } from './forecast.tsx';
import { BrandMark, Icon } from './icons.tsx';
import { MonitoringPage } from './monitoring.tsx';
import { OperationsPage } from './operations.tsx';
import { AccountsPage, ClientsPage, ConnectionsPage, ErrorBox } from './pages.tsx';
import { Shell } from './workspace.tsx';

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/v1/me'),
    retry: (attempt, error) => !(error instanceof ApiError && error.status === 401) && attempt < 2,
  });

  if (me.isPending) return <p className="p-6 text-sm text-gray-500">Cargando…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
  if (me.error) return <ErrorBox error={me.error} />;

  const memberships = me.data.memberships;
  if (memberships.length === 0) {
    return (
      <p className="p-6">Tu usuario no pertenece a ninguna organización. Pide una invitación.</p>
    );
  }
  const active = memberships.find((m) => m.tenantId === getActiveTenant()) ?? memberships[0];
  if (active && active.tenantId !== getActiveTenant()) setActiveTenant(active.tenantId);
  if (!active) return null;

  return (
    <Shell me={me.data} activeTenantId={active.tenantId}>
      <Routes>
        <Route path="/" element={<Navigate to="/analitica" replace />} />
        <Route path="/analitica" element={<DashboardPage role={active.role} />} />
        <Route path="/analitica/:level/:id" element={<DashboardPage role={active.role} />} />
        <Route path="/prevision" element={<ForecastPage />} />
        <Route path="/monitoreo" element={<MonitoringPage role={active.role} />} />
        {['owner', 'admin'].includes(active.role) && (
          <Route path="/operaciones" element={<OperationsPage />} />
        )}
        <Route path="/monitoreo/:accountId" element={<MonitoringPage role={active.role} />} />
        <Route path="/prevision/:level/:id" element={<ForecastPage />} />
        <Route
          path="/acciones"
          element={<ActionCenterPage role={active.role} userId={me.data.user.id} />}
        />
        <Route
          path="/acciones/:accountId"
          element={<ActionCenterPage role={active.role} userId={me.data.user.id} />}
        />
        <Route path="/asistente" element={<AssistantPage role={active.role} />} />
        <Route path="/clientes" element={<ClientsPage role={active.role} />} />
        <Route path="/cuentas" element={<AccountsPage role={active.role} />} />
        <Route path="/conexiones" element={<ConnectionsPage role={active.role} />} />
        <Route path="/cuenta" element={<AccountPage />} />
        <Route path="*" element={<p>Página no encontrada.</p>} />
      </Routes>
    </Shell>
  );
}

function Login() {
  const options = useQuery({
    queryKey: ['access-options'],
    queryFn: () => api<{ mode: 'workspace' | 'password' }>('/v1/access-options'),
  });
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({ email, password, rememberMe: false });
      setPassword('');
      if (result.error)
        setError('No se pudo iniciar sesión. Revisa tus credenciales o consulta al administrador.');
      else window.location.assign('/');
    } catch {
      setError('No se pudo conectar. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-story" aria-label="Ad Astra, tu espacio de campañas">
        <div className="login-wordmark">
          <BrandMark />
          <span>ad astra.</span>
        </div>
        <div className="login-story-body">
          <h2>Una perspectiva clara de cada campaña.</h2>
          <p>
            Reúne la información, revisa las oportunidades y decide con evidencia. Todo tu equipo,
            en el mismo espacio.
          </p>
          <section className="login-flow" aria-label="Flujo de trabajo">
            <span>
              <Icon name="trend" size={17} /> Analiza
            </span>
            <Icon name="arrow" size={15} />
            <span>
              <Icon name="action" size={17} /> Decide
            </span>
            <Icon name="arrow" size={15} />
            <span>
              <Icon name="monitor" size={17} /> Da seguimiento
            </span>
          </section>
        </div>
        <p className="login-story-foot">Tu equipo. Tus cuentas. Tus decisiones.</p>
      </section>
      <section className="login-form-side" aria-label="Inicio de sesión">
        <div className="login-form">
          <h1 className="mb-1 text-xl font-semibold">Ad Astra</h1>
          <p>
            Qué bueno tenerte de vuelta.
            <br />
            Entra a tu espacio de trabajo.
          </p>
          {options.isPending && <p role="status">Cargando acceso…</p>}
          {options.error && <ErrorBox error={options.error} />}
          {options.data?.mode === 'password' && (
            <form onSubmit={signIn} className="space-y-4">
              <label className="block text-sm">
                Correo
                <input
                  className="mt-1 w-full rounded border border-gray-300 bg-transparent p-2"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                Contraseña
                <input
                  className="mt-1 w-full rounded border border-gray-300 bg-transparent p-2"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}
              <button
                disabled={busy}
                className="w-full rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
                type="submit"
              >
                {busy ? 'Entrando…' : 'Iniciar sesión'}
              </button>
              <p className="text-xs text-gray-500">
                Solo cuentas invitadas. Para recuperar el acceso, contacta al administrador.
              </p>
            </form>
          )}
          {options.data?.mode === 'workspace' && (
            <button
              type="button"
              className="w-full rounded bg-gray-900 px-4 py-2 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900"
              onClick={() =>
                void authClient.signIn.social({ provider: 'google', callbackURL: '/' })
              }
            >
              Continuar con Google
            </button>
          )}
          <div className="login-privacy">
            <Icon name="lock" size={12} /> Acceso privado, solo por invitación
          </div>
        </div>
      </section>
    </main>
  );
}
