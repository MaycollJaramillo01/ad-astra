import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Client } from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import { PRESETS } from '../../src/modules/insights/catalog.ts';
import type { Signal } from '../../src/modules/monitoring/model.ts';
import type { MonitoringOverview } from '../../src/modules/monitoring/service.ts';
import type { WorkspaceAccount } from '../../src/workspace-contracts.ts';
import {
  ACCOUNT_VIEWS,
  type AccountView,
  accountPath,
  attention,
  dataState,
} from './account-context.ts';
import { AccountActionPolicy, ActionCenterPage } from './actions.tsx';
import { api } from './api.ts';
import { DashboardPage } from './dashboard.tsx';
import { formatAgo } from './format.ts';
import { Icon } from './icons.tsx';
import { presentSignal } from './incident-presentation.ts';
import { MonitoringPage } from './monitoring.tsx';
import { ErrorBox } from './pages.tsx';
import { EmptyState } from './ui.tsx';

export const workspaceQuery = {
  queryKey: ['account-workspace'],
  queryFn: () => api<WorkspaceAccount[]>('/v1/account-workspace'),
  refetchInterval: 60_000,
};
const viewNames: Record<AccountView, string> = {
  resumen: 'Resumen',
  problemas: 'Problemas',
  campanas: 'Campañas',
  acciones: 'Acciones',
  seguimiento: 'Seguimiento',
  historial: 'Historial',
  ajustes: 'Configuración',
};

export function AccountPortfolio({ role }: { role: Role }) {
  const q = useQuery(workspaceQuery);
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all');
  const accounts = q.data ?? [];
  if (q.error && !q.data)
    return (
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">No pudimos cargar tus cuentas</h1>
        <ErrorBox error={q.error} />
        <button type="button" className="button-secondary" onClick={() => void q.refetch()}>
          Reintentar carga
        </button>
      </section>
    );
  const rows = accounts
    .filter((a) => {
      const matches = `${a.name} ${a.clientName ?? ''} ${a.metaAccountId}`
        .toLocaleLowerCase('es')
        .includes(search.toLocaleLowerCase('es'));
      return (
        matches &&
        (filter === 'all' ||
          (filter === 'attention' && attention(a).rank >= 2) ||
          (filter === 'data' && dataState(a).kind !== 'ready') ||
          (filter === 'actions' && (a.pendingActions > 0 || a.failedActions > 0)))
      );
    })
    .sort(
      (a, b) =>
        attention(b).rank - attention(a).rank ||
        b.criticalIncidents - a.criticalIncidents ||
        a.name.localeCompare(b.name),
    );
  return (
    <div className="account-portfolio space-y-5">
      <header className="analytics-header">
        <div>
          <p className="page-eyebrow">TU CARTERA, CUENTA POR CUENTA</p>
          <h1>Qué necesita atención</h1>
          <p className="page-description">
            Empieza por lo prioritario. Abre una cuenta para entender qué pasa y darle seguimiento.
          </p>
        </div>
        <Link to="/analitica" className="button-secondary">
          <Icon name="trend" size={16} />
          Analítica de cartera
        </Link>
      </header>
      {['owner', 'admin'].includes(role) && (
        <div className="flex flex-wrap gap-3">
          <Link to="/cuentas/gestion" className="account-back">
            Gestionar sincronización
          </Link>
          <Link to="/conexiones" className="account-back">
            Conectar Meta
          </Link>
        </div>
      )}
      {q.error && <ErrorBox error={q.error} />}
      {q.isPending ? (
        <div className="dashboard-skeleton" role="status" aria-label="Cargando cuentas">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : (
        <>
          <section className="attention-counters" aria-label="Estado de la cartera">
            {[
              ['Cuentas visibles', accounts.length],
              ['Necesitan atención', accounts.filter((a) => attention(a).rank >= 2).length],
              ['Datos por revisar', accounts.filter((a) => dataState(a).kind !== 'ready').length],
              ['Acciones en curso', accounts.reduce((n, a) => n + a.pendingActions, 0)],
            ].map(([label, value]) => (
              <div key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </section>
          <div className="account-filters">
            <label>
              <span>Buscar cuenta o cliente</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nombre, cliente o ID de Meta"
              />
            </label>
            <label>
              <span>Mostrar</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">Todas las cuentas</option>
                <option value="attention">Necesitan atención</option>
                <option value="data">Datos por revisar</option>
                <option value="actions">Con acciones pendientes</option>
              </select>
            </label>
            <span className="text-sm text-gray-500" role="status">
              {rows.length} de {accounts.length} cuentas · por prioridad
            </span>
          </div>
          {!accounts.length ? (
            <EmptyState
              icon="accounts"
              title="Aquí empieza el seguimiento de tus cuentas"
              description="Conecta Meta y asigna las cuentas a tus clientes para empezar."
            />
          ) : !rows.length ? (
            <EmptyState
              icon="search"
              title="No hay cuentas con estos filtros"
              description="Prueba otro nombre o muestra todas las cuentas."
            />
          ) : (
            <div className="account-list">
              {rows.map((a) => {
                const priority = attention(a),
                  state = dataState(a);
                return (
                  <article key={a.id} className={`account-row priority-${priority.rank}`}>
                    <div className="account-row-title">
                      <span className="account-initial" aria-hidden="true">
                        {a.name.slice(0, 1)}
                      </span>
                      <div>
                        <p>{a.clientName ?? 'Sin cliente asignado'}</p>
                        <h2>
                          <Link to={accountPath(a.id)}>{a.name}</Link>
                        </h2>
                        <span className="text-xs text-gray-500">
                          {a.currency} · {a.timezoneName}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className={`attention-badge priority-${priority.rank}`}>
                        {priority.label}
                      </span>
                      <p className="account-row-reason">{priority.reason}</p>
                    </div>
                    <div className="account-row-data">
                      <span className={`data-dot ${state.kind}`} />
                      {state.label}
                      <small>
                        {a.lastInsightsSyncAt
                          ? formatAgo(a.lastInsightsSyncAt)
                          : 'Sin sincronizaciones'}
                      </small>
                    </div>
                    <Link
                      to={accountPath(a.id, priority.rank >= 2 ? 'problemas' : 'resumen')}
                      className="account-open"
                      aria-label={`Revisar ${a.name}`}
                    >
                      Revisar cuenta <Icon name="arrow" size={16} />
                    </Link>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AccountWorkspace({ role, userId }: { role: Role; userId: string }) {
  const { accountId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const q = useQuery(workspaceQuery);
  const view: AccountView = ACCOUNT_VIEWS.includes(sp.get('vista') as AccountView)
    ? (sp.get('vista') as AccountView)
    : 'resumen';
  const a = q.data?.find((x) => x.id === accountId);
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isPending) return <p role="status">Cargando la cuenta…</p>;
  if (!a)
    return (
      <section>
        <h1>Cuenta no disponible</h1>
        <p>La cuenta no existe o no tienes acceso.</p>
        <Link className="button-secondary" to="/cuentas">
          Volver a cuentas
        </Link>
      </section>
    );
  const state = dataState(a);
  const entity = sp.get('entidad'),
    level = sp.get('nivel');
  const detailLevel =
    level === 'campaign' || level === 'adset' || level === 'ad' ? level : 'campaign';
  return (
    <div className="account-space space-y-5" key={accountId}>
      <header className="account-header">
        <Link to="/cuentas" className="account-back">
          ← Todas las cuentas
        </Link>
        <div className="account-heading">
          <div>
            <p className="page-eyebrow">{a.clientName ?? 'Sin cliente asignado'}</p>
            <h1>{a.name}</h1>
            <p className="text-sm text-gray-500">
              {a.currency} · {a.timezoneName} · Meta {a.metaAccountId}
            </p>
          </div>
          <label className="account-switch">
            <span>Cambiar cuenta</span>
            <select
              value={accountId}
              onChange={(e) => navigate(accountPath(e.target.value, view, sp))}
            >
              {q.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="account-context-bar">
          <span>
            <span className={`data-dot ${state.kind}`} />
            {state.label}
          </span>
          <span>
            Última sincronización:{' '}
            {a.lastInsightsSyncAt ? formatAgo(a.lastInsightsSyncAt) : 'pendiente'}
          </span>
          <span>Monitoreo automático: {a.monitoringEnabled ? 'activo' : 'desactivado'}</span>
          <label className="account-period">
            Período de analítica{' '}
            <select
              aria-label="Período de analítica de la cuenta"
              value={sp.get('desde') ? 'custom' : (sp.get('periodo') ?? 'last_7d')}
              onChange={(e) =>
                setSp((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('periodo', e.target.value);
                  next.delete('desde');
                  next.delete('hasta');
                  return next;
                })
              }
            >
              {sp.get('desde') && (
                <option value="custom">
                  {sp.get('desde')} — {sp.get('hasta')}
                </option>
              )}
              {Object.entries(PRESETS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <nav className="account-tabs" aria-label="Secciones de la cuenta">
        {ACCOUNT_VIEWS.map((tab) => (
          <Link
            key={tab}
            aria-current={view === tab ? 'page' : undefined}
            to={accountPath(a.id, tab, sp)}
          >
            {viewNames[tab]}
            {tab === 'problemas' && a.incidents > 0 && <span>{a.incidents}</span>}
            {tab === 'acciones' && a.pendingActions > 0 && <span>{a.pendingActions}</span>}
          </Link>
        ))}
      </nav>
      {state.kind !== 'ready' && (
        <aside className="account-data-warning" aria-label="Estado de los datos">
          <Icon name="connect" size={20} />
          <div>
            <strong>No podemos confirmar el rendimiento con datos actuales</strong>
            <p>{state.detail}</p>
          </div>
          <Link className="button-secondary" to={accountPath(a.id, 'ajustes', sp)}>
            Revisar datos y conexión
          </Link>
        </aside>
      )}
      {view === 'resumen' && (
        <>
          <AccountNextStep account={a} />
          <DashboardPage
            role={role}
            context={{ level: 'account', id: a.id }}
            embedded
            mode="summary"
            expectedAccountId={a.id}
          />
        </>
      )}
      {view === 'campanas' && (
        <>
          {entity && (
            <Link className="account-back" to={accountPath(a.id, 'campanas', sp)}>
              ← Volver a las campañas de la cuenta
            </Link>
          )}
          <DashboardPage
            key={entity ?? a.id}
            role={role}
            context={{ level: entity ? detailLevel : 'account', id: entity ?? a.id }}
            embedded
            mode={entity ? undefined : 'campaigns'}
            expectedAccountId={a.id}
          />
        </>
      )}
      {view === 'problemas' && (
        <MonitoringPage role={role} selectedAccountId={a.id} embedded section="incidents" />
      )}
      {view === 'acciones' && (
        <ActionCenterPage role={role} userId={userId} selectedAccountId={a.id} embedded />
      )}
      {view === 'seguimiento' && (
        <MonitoringPage role={role} selectedAccountId={a.id} embedded section="followups" />
      )}
      {view === 'historial' && (
        <MonitoringPage role={role} selectedAccountId={a.id} embedded section="history" />
      )}
      {view === 'ajustes' && (
        <>
          <AccountDataDetails account={a} role={role} />
          <MonitoringPage role={role} selectedAccountId={a.id} embedded />
          <AccountActionPolicy accountId={a.id} role={role} currency={a.currency} />
        </>
      )}
    </div>
  );
}

function AccountNextStep({ account: a }: { account: WorkspaceAccount }) {
  const [sp] = useSearchParams();
  const monitor = useQuery({
    queryKey: ['monitoring', a.id],
    queryFn: () => api<MonitoringOverview>(`/v1/monitoring/${a.id}`),
    refetchInterval: 60_000,
  });
  const top = monitor.data?.incidents
    .filter((i) => ['open', 'acknowledged'].includes(i.status))
    .sort(
      (x, y) =>
        ({ critical: 4, high: 3, medium: 2, low: 1, info: 0 })[y.severity] -
        { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[x.severity],
    )[0];
  const signal =
    top && Array.isArray(top.evidence)
      ? (top.evidence as Signal[]).find((s) => s.hit === true)
      : undefined;
  const copy =
    signal && dataState(a).kind === 'ready' ? presentSignal(signal, a.currency) : undefined;
  const p = attention(a);
  const view =
    dataState(a).kind !== 'ready'
      ? 'ajustes'
      : a.failedActions
        ? 'acciones'
        : a.incidents || a.findings
          ? 'problemas'
          : a.pendingActions
            ? 'acciones'
            : !a.monitoringEnabled
              ? 'ajustes'
              : 'campanas';
  return (
    <section className="account-next-step">
      <div>
        <p className="page-eyebrow">SIGUIENTE PASO</p>
        <h2>{copy?.title ?? p.label}</h2>
        <p>{copy?.description ?? p.reason}</p>
      </div>
      <Link to={accountPath(a.id, view, sp)} className="button-primary">
        {view === 'ajustes'
          ? 'Revisar configuración'
          : view === 'problemas'
            ? 'Entender los problemas'
            : view === 'acciones'
              ? 'Revisar acciones'
              : 'Explorar campañas'}
        <Icon name="arrow" size={16} />
      </Link>
      {monitor.error && (
        <p role="alert" className="text-sm">
          No se pudo actualizar el resumen de incidentes. Abre Problemas para reintentar.
        </p>
      )}
    </section>
  );
}

function AccountDataDetails({ account: a, role }: { account: WorkspaceAccount; role: Role }) {
  const q = useQuery({
    queryKey: ['sync-runs', a.id],
    queryFn: () =>
      api<{ id: number; status: string; startedAt: string; errorMessage: string | null }[]>(
        `/v1/ad-accounts/${a.id}/sync-runs`,
      ),
  });
  return (
    <section className="data-panel space-y-3">
      <h2 className="font-semibold">Datos y conexión</h2>
      <p>{dataState(a).detail}</p>
      {['owner', 'admin'].includes(role) && (
        <AccountDataControls key={`${a.id}:${a.clientId}`} account={a} />
      )}
      <div className="flex flex-wrap gap-3">
        {['owner', 'admin'].includes(role) ? (
          <>
            <Link to="/conexiones" className="button-secondary">
              Revisar conexión con Meta
            </Link>
            <Link to="/cuentas/gestion" className="button-secondary">
              Gestionar sincronización
            </Link>
          </>
        ) : (
          <p className="text-sm text-gray-500">
            Un administrador puede revisar los permisos y la sincronización de esta cuenta.
          </p>
        )}
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.isPending && <p role="status">Cargando sincronizaciones…</p>}
      <details>
        <summary>Últimas sincronizaciones</summary>
        <ul className="mt-3 space-y-2 text-sm">
          {q.data?.map((r) => (
            <li key={r.id}>
              {new Date(r.startedAt).toLocaleString('es')} ·{' '}
              {(
                {
                  succeeded: 'Completada',
                  partial: 'Parcial',
                  running: 'En curso',
                  failed: 'Fallida',
                  throttled: 'Límite temporal de Meta',
                } as Record<string, string>
              )[r.status] ?? r.status}
              {r.errorMessage && <p className="text-red-700">{r.errorMessage}</p>}
            </li>
          ))}
        </ul>
        {q.data?.length === 0 && (
          <p className="mt-2 text-sm">Todavía no se ha ejecutado una sincronización.</p>
        )}
      </details>
    </section>
  );
}

function AccountDataControls({ account: a }: { account: WorkspaceAccount }) {
  const cache = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api<Client[]>('/v1/clients') });
  const [clientId, setClientId] = useState(a.clientId ?? '');
  const [grant, setGrant] = useState({ name: '', email: '', at: '', evidence: '' });
  const refresh = () => {
    for (const key of ['account-workspace', 'ad-accounts', 'accounts', 'monitoring', 'clients'])
      void cache.invalidateQueries({ queryKey: [key] });
  };
  const assign = useMutation({
    mutationFn: () =>
      api(`/v1/ad-accounts/${a.id}`, {
        method: 'PATCH',
        body: { clientId: clientId || null, syncEnabled: false },
      }),
    onSuccess: refresh,
  });
  const sync = useMutation({
    mutationFn: () =>
      api(`/v1/ad-accounts/${a.id}`, { method: 'PATCH', body: { syncEnabled: !a.syncEnabled } }),
    onSuccess: refresh,
  });
  const consent = useMutation({
    mutationFn: () =>
      api(`/v1/clients/${a.clientId}/consents`, {
        method: 'POST',
        body: {
          scope: ['read_insights'],
          grantedByName: grant.name,
          grantedByEmail: grant.email,
          grantedAt: new Date(grant.at).toISOString(),
          ...(grant.evidence && { evidenceRef: grant.evidence }),
        },
      }),
    onSuccess: () => {
      setGrant({ name: '', email: '', at: '', evidence: '' });
      refresh();
    },
  });
  const reactivate = useMutation({
    mutationFn: () =>
      api(`/v1/clients/${a.clientId}`, { method: 'PATCH', body: { status: 'active' } }),
    onSuccess: refresh,
  });
  const client = clients.data?.find((c) => c.id === a.clientId);
  const busy = assign.isPending || sync.isPending || consent.isPending || reactivate.isPending;
  return (
    <fieldset disabled={busy} className="account-data-controls space-y-4">
      <legend className="sr-only">Cliente, sincronización y autorización de lectura</legend>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          assign.mutate();
        }}
      >
        <label className="grid flex-1 gap-1 text-sm">
          Cliente de la cuenta
          <select
            className="rounded border p-2"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Sin cliente asignado</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status !== 'active' ? ' · inactivo' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button-secondary"
          type="submit"
          disabled={assign.isPending || clientId === (a.clientId ?? '')}
        >
          Guardar cliente
        </button>
      </form>
      <p className="text-xs text-gray-500">
        Cambiar de cliente desactiva la sincronización. Podrás activarla con la autorización del
        cliente correcto.
      </p>
      {client && client.status !== 'active' && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            El cliente está inactivo; sus evaluaciones automáticas están suspendidas.
          </p>
          <button
            type="button"
            className="button-secondary"
            disabled={reactivate.isPending}
            onClick={() => reactivate.mutate()}
          >
            Reactivar cliente
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="button-secondary"
          disabled={sync.isPending || (!a.syncEnabled && !a.readConsentActive)}
          onClick={() => sync.mutate()}
        >
          {sync.isPending
            ? 'Guardando…'
            : a.syncEnabled
              ? 'Desactivar sincronización'
              : 'Activar sincronización'}
        </button>
        <p className="text-xs text-gray-500">
          {a.readConsentActive
            ? 'Activar encola la actualización y la recuperación del histórico.'
            : 'Para activar se necesita un cliente activo con autorización de lectura.'}
        </p>
      </div>
      {a.clientId && !a.readConsentActive && (
        <details>
          <summary className="text-sm">Registrar autorización de lectura ya recibida</summary>
          <form
            className="mt-3 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              consent.mutate();
            }}
          >
            <label className="grid gap-1 text-sm">
              Nombre de quien autorizó
              <input
                className="rounded border p-2"
                required
                maxLength={120}
                value={grant.name}
                onChange={(e) => setGrant({ ...grant, name: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Correo de quien autorizó
              <input
                className="rounded border p-2"
                type="email"
                required
                value={grant.email}
                onChange={(e) => setGrant({ ...grant, email: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Fecha y hora de autorización
              <input
                className="rounded border p-2"
                type="datetime-local"
                required
                value={grant.at}
                onChange={(e) => setGrant({ ...grant, at: e.target.value })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Referencia de la autorización
              <input
                className="rounded border p-2"
                maxLength={500}
                value={grant.evidence}
                onChange={(e) => setGrant({ ...grant, evidence: e.target.value })}
                placeholder="Documento, contrato o registro"
              />
            </label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" required className="mt-1" />
              Confirmo que el cliente ya concedió permiso para leer sus datos publicitarios. Este
              registro no autoriza cambios en Meta.
            </label>
            <button
              className="button-secondary justify-self-start"
              type="submit"
              disabled={consent.isPending}
            >
              Registrar autorización de lectura
            </button>
          </form>
        </details>
      )}
      {clients.error && <ErrorBox error={clients.error} />}
      {assign.error && <ErrorBox error={assign.error} />}
      {sync.error && <ErrorBox error={sync.error} />}
      {consent.error && <ErrorBox error={consent.error} />}
      {reactivate.error && <ErrorBox error={reactivate.error} />}
      {(assign.isSuccess || sync.isSuccess || consent.isSuccess || reactivate.isSuccess) && (
        <p role="status" className="text-sm">
          Configuración guardada. El estado de la cuenta se está actualizando.
        </p>
      )}
    </fieldset>
  );
}
