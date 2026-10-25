import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import type { Me } from '../../src/contracts.ts';
import { ApiError, api, authClient, getActiveTenant, setActiveTenant } from './api.ts';
import { AssistantPage } from './assistant.tsx';
import { DashboardPage } from './dashboard.tsx';
import { AccountsPage, ClientsPage, ConnectionsPage, ErrorBox } from './pages.tsx';

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me') });

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
        <Route path="/asistente" element={<AssistantPage role={active.role} />} />
        <Route path="/clientes" element={<ClientsPage role={active.role} />} />
        <Route path="/cuentas" element={<AccountsPage role={active.role} />} />
        <Route path="/conexiones" element={<ConnectionsPage role={active.role} />} />
        <Route path="*" element={<p>Página no encontrada.</p>} />
      </Routes>
    </Shell>
  );
}

function Shell({
  me,
  activeTenantId,
  children,
}: {
  me: Me;
  activeTenantId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const isAdmin = me.memberships.some(
    (m) => m.tenantId === activeTenantId && ['owner', 'admin'].includes(m.role),
  );
  const canUseAi = me.memberships.some((m) => m.tenantId === activeTenantId && m.role !== 'viewer');
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded px-3 py-1.5 text-sm ${isActive ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'hover:bg-gray-100 dark:hover:bg-gray-800'}`;

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <strong>Ad Astra</strong>
        {me.memberships.length > 1 ? (
          <label className="text-sm">
            <span className="sr-only">Organización activa</span>
            <select
              className="rounded border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-700"
              value={activeTenantId}
              onChange={(e) => {
                setActiveTenant(e.target.value);
                void queryClient.invalidateQueries();
              }}
            >
              {me.memberships.map((m) => (
                <option key={m.tenantId} value={m.tenantId}>
                  {m.tenantName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-sm text-gray-500">{me.memberships[0]?.tenantName}</span>
        )}
        <nav aria-label="Principal" className="flex gap-1">
          <NavLink to="/analitica" className={link}>
            Analítica
          </NavLink>
          {canUseAi && (
            <NavLink to="/asistente" className={link}>
              Asistente IA
            </NavLink>
          )}
          <NavLink to="/clientes" className={link}>
            Clientes
          </NavLink>
          <NavLink to="/cuentas" className={link}>
            Cuentas
          </NavLink>
          {isAdmin && (
            <NavLink to="/conexiones" className={link}>
              Conexiones Meta
            </NavLink>
          )}
        </nav>
        <span className="ml-auto text-sm text-gray-500">{me.user.email}</span>
        <button
          type="button"
          className="rounded border border-gray-300 px-3 py-1 text-sm dark:border-gray-700"
          onClick={async () => {
            await authClient.signOut();
            queryClient.clear();
            void queryClient.invalidateQueries({ queryKey: ['me'] });
          }}
        >
          Salir
        </button>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}

function Login() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-950">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h1 className="mb-1 text-xl font-semibold">Ad Astra</h1>
        <p className="mb-6 text-sm text-gray-500">Accede con tu cuenta de Google de la agencia.</p>
        <button
          type="button"
          className="w-full rounded bg-gray-900 px-4 py-2 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900"
          onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: '/' })}
        >
          Continuar con Google
        </button>
      </div>
    </main>
  );
}
