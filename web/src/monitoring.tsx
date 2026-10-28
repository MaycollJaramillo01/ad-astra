import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { AdAccount } from '../../src/contracts.ts';
import { type Role, SEVERITIES } from '../../src/domain.ts';
import type {
  Day,
  evaluatePlan,
  FollowupPlan,
  Signal,
} from '../../src/modules/monitoring/model.ts';
import type { MonitoringOverview, MonitorReport } from '../../src/modules/monitoring/service.ts';
import type { MonitoringPolicy } from '../../src/monitoring-contracts.ts';
import { accountPath } from './account-context.ts';
import { api } from './api.ts';
import { AuditSection } from './audit.tsx';
import { presentSignal } from './incident-presentation.ts';
import { ErrorBox } from './pages.tsx';
import { EmptyState } from './ui.tsx';

const box = 'min-w-0 rounded-lg border border-gray-200 p-4 dark:border-gray-800',
  button =
    'rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900',
  input = 'rounded border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-700';
const names: Record<string, string> = {
  pending: 'Pendiente de persistencia',
  open: 'Abierto',
  acknowledged: 'En revisión',
  snoozed: 'Silenciado',
  resolved: 'Resuelto',
  dismissed: 'Descartado',
  performance: 'Rendimiento',
  audit: 'Auditoría',
  connection: 'Conexión',
  sync_stale: 'Sincronización',
  recommendation_stale: 'Recomendaciones pendientes',
  action_failed: 'Acciones fallidas',
  cpr_increase: 'Aumento de CPR (%)',
  results_drop: 'Caída de resultados diarios (%)',
  spend_without_results: 'Gasto sin resultados (moneda de cuenta)',
  info: 'Informativa',
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
  queued: 'En cola',
  sending: 'Envío reservado',
  sent: 'Aceptado / disponible',
  cancelled: 'Cancelado',
  unknown: 'Sin confirmación',
  failed: 'Fallo',
  waiting: 'Esperando ventana madura',
  observed: 'Comparación descriptiva disponible',
  insufficient: 'Datos insuficientes',
};
const label = (s: string) => names[s] ?? s;
const fmt = (v: number | null | undefined) =>
  v === null || v === undefined
    ? 'Sin datos'
    : v.toLocaleString('es', { maximumFractionDigits: 2 });
const at = (d: Date | string) => new Date(d).toLocaleString('es');
function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const md = (s: string) => s.replace(/[\\`*_{}[\]()<>#!|]/g, '\\$&');
function executiveMarkdown(r: MonitorReport) {
  return `# Informe ejecutivo · ${md(r.account.name)}\n\n${r.window.since} — ${r.window.until} · ${r.account.currency} · ${r.account.timezone}\n\nGenerado: ${r.generatedAt}\n\n| Métrica | Período | Anterior |\n| --- | ---: | ---: |\n${(['spend', 'results', 'leads', 'purchases', 'cpr'] as const).map((k) => `| ${k} | ${fmt(r.executive.summary[k])} | ${fmt(r.executive.previous[k])} |`).join('\n')}\n\nIncidentes abiertos: ${r.executive.openIncidents}. Acciones fallidas: ${r.executive.failedActions}.\n\n## Próximos pasos\n\n${r.executive.nextSteps.map((s) => `- ${md(s)}`).join('\n')}\n\n## Hipótesis y límites\n\n${r.limitations.map((s) => `- ${md(s)}`).join('\n')}\n\n${md(r.technical.crm.reason)}\n`;
}

export function MonitoringPage({
  role,
  selectedAccountId,
  embedded = false,
  section,
}: {
  role: Role;
  selectedAccountId?: string;
  embedded?: boolean;
  section?: string;
}) {
  const params = useParams(),
    accountId = selectedAccountId ?? params.accountId;
  const [sp, setSp] = useSearchParams();
  const tab = section ?? sp.get('seccion') ?? (embedded ? 'settings' : 'incidents');
  const setTab = (value: string) =>
    setSp((previous) => {
      const next = new URLSearchParams(previous);
      next.set('seccion', value);
      return next;
    });
  const navigate = useNavigate(),
    cache = useQueryClient();
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<AdAccount[]>('/v1/ad-accounts'),
  });
  const q = useQuery({
    queryKey: ['monitoring', accountId],
    queryFn: () => api<MonitoringOverview>(`/v1/monitoring/${accountId}`),
    enabled: !!accountId,
    refetchInterval: 60000,
  });
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ['account-workspace'] });
    return cache.invalidateQueries({ queryKey: ['monitoring', accountId] });
  };
  const evaluate = useMutation({
    mutationFn: () => api(`/v1/monitoring/${accountId}/evaluate`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const run = role !== 'viewer',
    configure = ['owner', 'admin', 'manager'].includes(role),
    account = accounts.data?.find((a) => a.id === accountId),
    data = q.data;
  return (
    <div className="space-y-5">
      {!embedded && (
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Monitoreo y seguimiento</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Incidentes, decisiones y evidencia de lo que ocurrió después.
            </p>
          </div>
          <label className="grid gap-1 text-sm">
            Cuenta
            <select
              className={input}
              value={accountId ?? ''}
              onChange={(e) =>
                navigate(e.target.value ? `/monitoreo/${e.target.value}` : '/monitoreo')
              }
            >
              <option value="">Selecciona una cuenta</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
            </select>
          </label>
        </header>
      )}
      {!embedded && accountId && (
        <Link className="button-secondary" to={accountPath(accountId, 'problemas')}>
          Abrir espacio de la cuenta
        </Link>
      )}
      {tab === 'followups' && (
        <p className="text-sm text-gray-500">
          Los cambios antes y después son observaciones. Los comparadores se fijan antes del envío,
          pero pueden existir factores de confusión. Estos informes no atribuyen causalidad ni
          autorizan operaciones en Meta.
        </p>
      )}
      {accounts.error && <ErrorBox error={accounts.error} />}
      {q.error && <ErrorBox error={q.error} />}
      {!accountId && (
        <EmptyState
          icon="monitor"
          title="Una vista clara de lo que necesita atención"
          description="Selecciona una cuenta para consultar sus reglas, incidentes e informes."
        />
      )}
      {q.isFetching && !data && accountId && <p role="status">Cargando monitoreo…</p>}
      {data && account && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              Monitoreo{' '}
              <strong>
                {data.policy.config.enabled ? 'automático activo' : 'automático desactivado'}
              </strong>{' '}
              · {account.timezoneName}
              <br />
              <span className="text-gray-500">
                Última evaluación: {data.runs[0] ? at(data.runs[0].at) : 'sin evaluaciones'} · Corte
                maduro: {data.runs[0]?.asOf ?? 'sin evaluar'}
              </span>
            </p>
            {run && (
              <button
                type="button"
                className={button}
                disabled={evaluate.isPending}
                onClick={() => evaluate.mutate()}
              >
                {evaluate.isPending ? 'Evaluando…' : 'Evaluar datos disponibles'}
              </button>
            )}
          </div>
          {!data.readConsentActive && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              La evaluación automática está suspendida: se necesita cliente activo y consentimiento
              de lectura vigente.
            </p>
          )}
          {evaluate.isSuccess && (
            <p role="status" className="text-sm">
              Evaluación completada. Las alertas ya reflejan los datos disponibles; esta operación
              no sincroniza Meta.
            </p>
          )}
          {data.runs[0] && (
            <details className="text-sm text-gray-500">
              <summary>Detalles de la última evaluación</summary>
              <p>
                Última evaluación: {Number((data.runs[0].stats as { groups?: number }).groups ?? 0)}{' '}
                grupos · {Number((data.runs[0].stats as { triggered?: number }).triggered ?? 0)} con
                condición ·{' '}
                {Number((data.runs[0].stats as { insufficient?: number }).insufficient ?? 0)} con
                datos insuficientes.
              </p>
            </details>
          )}
          {evaluate.error && <ErrorBox error={evaluate.error} />}
          {!section && (
            <nav className="monitor-tabs" aria-label="Secciones de monitoreo">
              {[
                ['incidents', 'Incidentes'],
                ['followups', 'Antes y después'],
                ['reports', 'Informes'],
                ['settings', 'Reglas y canales'],
                ['history', 'Bitácora'],
              ].map(([key, title]) => (
                <button
                  type="button"
                  key={key}
                  aria-current={tab === key ? 'page' : undefined}
                  className={tab === key ? 'is-current' : ''}
                  onClick={() => setTab(key ?? 'incidents')}
                >
                  {title}
                </button>
              ))}
            </nav>
          )}
          {tab === 'incidents' && (
            <>
              <IncidentList
                data={data}
                currency={account.currency}
                canDecide={run}
                refresh={refresh}
              />
              <AuditSection
                level="account"
                id={accountId ?? ''}
                accountId={accountId ?? ''}
                currency={account.currency}
                role={role}
              />
            </>
          )}
          {tab === 'followups' && (
            <div className="space-y-3">
              {!data.followups.length && (
                <p className={box}>
                  Todavía no hay acciones enviadas con seguimiento. Cada envío guarda los datos
                  previos y las referencias para revisar su evolución.
                </p>
              )}
              {sp.get('accion') &&
                data.followups.length > 0 &&
                !data.followups.some((f) => f.actionId === sp.get('accion')) && (
                  <p className={box}>
                    Todavía no hay un seguimiento disponible para la acción seleccionada. Se
                    registra antes del envío.
                  </p>
                )}
              {sp.get('accion') && (
                <Link
                  className="button-secondary"
                  to={accountPath(accountId ?? '', 'seguimiento', sp)}
                >
                  Mostrar todos los seguimientos
                </Link>
              )}
              {data.followups
                .filter((f) => !sp.get('accion') || f.actionId === sp.get('accion'))
                .map((f) => (
                  <Followup
                    key={f.actionId}
                    plan={f.plan as FollowupPlan}
                    result={f.result as ReturnType<typeof evaluatePlan> | null}
                    currency={account.currency}
                    accountId={accountId ?? ''}
                  />
                ))}
              <p className="text-sm text-gray-500">{data.crm.reason}</p>
            </div>
          )}
          {tab === 'settings' && (
            <PolicyEditor
              key={`${accountId}:${data.policy.revision}`}
              accountId={accountId ?? ''}
              data={data}
              configure={configure}
              refresh={refresh}
            />
          )}
          {tab === 'reports' && (
            <Reports
              key={accountId}
              accountId={accountId ?? ''}
              reports={data.reports}
              canRun={run}
              refresh={refresh}
            />
          )}
          {tab === 'history' && <History accountId={accountId ?? ''} />}
        </>
      )}
    </div>
  );
}
function IncidentList({
  data,
  currency,
  canDecide,
  refresh,
}: {
  data: MonitoringOverview;
  currency: string;
  canDecide: boolean;
  refresh: () => unknown;
}) {
  const [filter, setFilter] = useState('active');
  const items = data.incidents
    .filter(
      (i) =>
        filter === 'all' ||
        (filter === 'active' && !['resolved', 'dismissed', 'pending'].includes(i.status)) ||
        i.status === filter,
    )
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        Estado
        <select className={input} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {[
            'active',
            'all',
            'pending',
            'open',
            'acknowledged',
            'snoozed',
            'resolved',
            'dismissed',
          ].map((s) => (
            <option key={s} value={s}>
              {s === 'active' ? 'Activos' : s === 'all' ? 'Todos' : label(s)}
            </option>
          ))}
        </select>
      </label>
      {!items.length && (
        <p className={box}>
          {data.runs.length === 0
            ? 'Todavía no se ha evaluado esta cuenta. Evalúa los datos disponibles para empezar.'
            : 'No hay incidentes en este estado. Consulta también los hallazgos de auditoría y la cobertura de los datos.'}
        </p>
      )}
      {items.map((i) => (
        <Incident
          key={`${i.id}:${i.revision}`}
          incident={i}
          entityName={
            data.entities?.find((e) => e.level === i.entityLevel && e.id === i.entityMetaId)?.name
          }
          canDecide={canDecide}
          currency={currency}
          decision={data.decisions?.find((d) => d.incidentId === i.id)}
          refresh={refresh}
        />
      ))}
      <section className={box}>
        <h2 className="font-semibold">Mis notificaciones</h2>
        <p className="mt-1 text-sm text-gray-500">
          Los canales requieren destinatarios autorizados. “Aceptado” en correo confirma recepción
          del proveedor, no lectura o entrega en bandeja.
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {data.notifications.map((n) => (
            <li key={n.id}>
              {at(n.createdAt)} · {n.channel === 'email' ? 'Correo' : 'En la aplicación'} ·{' '}
              {label(n.status)} · {n.incidentIds.length} incidentes
              {n.error && <p className="text-amber-700 dark:text-amber-300">{n.error}</p>}
            </li>
          ))}
        </ul>
        {!data.notifications.length && (
          <p className="mt-3 text-sm">Sin notificaciones para tu usuario.</p>
        )}
      </section>
    </div>
  );
}
function Incident({
  incident: i,
  entityName,
  currency,
  decision,
  canDecide,
  refresh,
}: {
  incident: MonitoringOverview['incidents'][number];
  entityName?: string;
  currency: string;
  decision?: MonitoringOverview['decisions'][number];
  canDecide: boolean;
  refresh: () => unknown;
}) {
  const [status, setStatus] = useState(i.status === 'pending' ? 'dismissed' : 'acknowledged'),
    [reason, setReason] = useState(''),
    [hours, setHours] = useState(24);
  const m = useMutation({
    mutationFn: () =>
      api(`/v1/monitoring/incidents/${i.id}/decide`, {
        method: 'POST',
        body: {
          status,
          reason,
          revision: i.revision,
          ...(status === 'snoozed' && { snoozeHours: hours }),
        },
      }),
    onSuccess: () => {
      setReason('');
      void refresh();
    },
  });
  const [sp] = useSearchParams();
  const signals = Array.isArray(i.evidence) ? (i.evidence as Signal[]) : [];
  const signal = signals.find((s) => s.hit === true) ?? signals[0];
  const copy = signal
    ? presentSignal(signal, currency)
    : {
        title: label(i.category),
        description: 'Revisa la entidad afectada y su historial.',
        next: 'Revisar entidad',
      };
  const view = ['connection', 'sync_stale'].includes(i.category)
    ? 'ajustes'
    : ['recommendation_stale', 'action_failed'].includes(i.category)
      ? 'acciones'
      : 'campanas';
  const entityFilter: Record<string, string> =
    i.entityLevel === 'account' ? {} : { entidad: i.entityMetaId, nivel: i.entityLevel };
  const lastDecision = decision?.data as { reason?: string; to?: string } | undefined;
  return (
    <article className={`incident-card ${box}`} id={`incidente-${i.id}`}>
      <header className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">{copy.title}</h2>
        <p className="text-sm">
          <span className={`severity-badge severity-${i.severity}`}>{label(i.severity)}</span> ·{' '}
          {label(i.status)}
        </p>
      </header>
      <p className="mt-2 text-sm text-gray-500">
        {entityName ?? i.entityMetaId} · Detectado {at(i.openedAt)}
      </p>
      <p className="mt-2 text-sm">{copy.description}</p>
      {decision && (
        <p className="mt-2 text-sm text-gray-500">
          Última decisión por <strong>{decision.actorName ?? 'un miembro del equipo'}</strong> ·{' '}
          {at(decision.at)}
          {lastDecision?.reason && ` · ${lastDecision.reason}`}
        </p>
      )}
      <div className="incident-next-step">
        <div>
          <strong>Siguiente paso</strong>
          <p>{copy.next}</p>
        </div>
        <Link
          className="button-primary"
          to={accountPath(
            i.adAccountId,
            view,
            sp,
            view === 'campanas' || view === 'acciones' ? entityFilter : {},
          )}
        >
          {copy.next}
        </Link>
        {view === 'campanas' && canDecide && (
          <Link
            className="button-secondary"
            to={accountPath(i.adAccountId, 'acciones', sp, entityFilter)}
          >
            Revisar posibles acciones
          </Link>
        )}
      </div>
      <details className="mt-3 text-sm">
        <summary>Evidencia y comparación</summary>
        {signals.map((s) => {
          const d = s.detail as {
            recent?: {
              since: string;
              until: string;
              spend: number | null;
              results: number | null;
              cpr: number | null;
              observed: number;
              expected: number;
            };
            baseline?: {
              since: string;
              until: string;
              spend: number | null;
              results: number | null;
              cpr: number | null;
              observed: number;
              expected: number;
            };
          };
          return (
            <div key={s.ruleId} className="mt-3">
              <p className="font-medium">{presentSignal(s, currency).title}</p>
              {d?.recent && d.baseline && (
                <div className="overflow-x-auto">
                  <table className="evidence-table">
                    <caption>Ventanas en la zona horaria de la cuenta · {currency}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Dato</th>
                        <th scope="col">Reciente</th>
                        <th scope="col">Referencia</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row">Período</th>
                        <td>
                          {d.recent.since} — {d.recent.until}
                        </td>
                        <td>
                          {d.baseline.since} — {d.baseline.until}
                        </td>
                      </tr>
                      <tr>
                        <th scope="row">Gasto</th>
                        <td>{fmt(d.recent.spend)}</td>
                        <td>{fmt(d.baseline.spend)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Resultados</th>
                        <td>{fmt(d.recent.results)}</td>
                        <td>{fmt(d.baseline.results)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Costo por resultado</th>
                        <td>{fmt(d.recent.cpr)}</td>
                        <td>{fmt(d.baseline.cpr)}</td>
                      </tr>
                      <tr>
                        <th scope="row">Días disponibles</th>
                        <td>
                          {d.recent.observed}/{d.recent.expected}
                        </td>
                        <td>
                          {d.baseline.observed}/{d.baseline.expected}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
        <p className="mt-2 text-gray-500">
          La comparación describe lo observado; por sí sola no identifica la causa del cambio.
        </p>
      </details>
      <details className="mt-3 text-sm">
        <summary>Detalles técnicos</summary>
        <p className="mt-2 text-sm text-gray-500">
          {i.hitCount} ventanas con condición · {i.clearCount} limpias · última observación{' '}
          {/^\d{4}-/.test(i.lastObservation)
            ? i.lastObservation.split('|')[0]
            : at(new Date(Number(i.lastObservation.split('|')[0]) * 900000))}
          {i.snoozedUntil && ` · silencio hasta ${at(i.snoozedUntil)}`}
        </p>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(signals, null, 2)}
        </pre>
      </details>
      {canDecide && (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <label className="sr-only" htmlFor={`decision-${i.id}`}>
            Decisión
          </label>
          <select
            id={`decision-${i.id}`}
            className={input}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {(i.status === 'pending'
              ? ['dismissed']
              : ['acknowledged', 'snoozed', 'dismissed', 'open']
            ).map((s) => (
              <option key={s} value={s}>
                {s === 'acknowledged'
                  ? 'Me encargo de revisarlo'
                  : s === 'snoozed'
                    ? 'Recordar más tarde'
                    : s === 'dismissed'
                      ? 'Descartar con motivo'
                      : 'Reabrir para revisión'}
              </option>
            ))}
          </select>
          {status === 'snoozed' && (
            <label className="flex items-center gap-2 text-sm">
              Horas
              <input
                className={`${input} w-20`}
                type="number"
                min={1}
                max={168}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              />
            </label>
          )}
          <input
            className={`${input} min-w-48 flex-1`}
            required
            minLength={5}
            maxLength={1000}
            aria-label="Motivo de la decisión"
            placeholder="Qué revisaste o qué vas a hacer"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="submit"
            className={button}
            disabled={m.isPending || reason.trim().length < 5}
          >
            {m.isPending ? 'Guardando…' : 'Guardar decisión'}
          </button>
        </form>
      )}
      <p className="mt-2 text-xs text-gray-500">
        Registrar una decisión no corrige la causa. El monitoreo confirma la recuperación con nuevas
        observaciones.
      </p>
      {m.error && <ErrorBox error={m.error} />}
    </article>
  );
}
function Followup({
  plan,
  result,
  currency,
  accountId,
}: {
  plan: FollowupPlan;
  result: ReturnType<typeof evaluatePlan> | null;
  currency: string;
  accountId: string;
}) {
  const [sp] = useSearchParams();
  return (
    <article className={box}>
      <h2 className="font-semibold">
        {plan.target.name} · {result ? label(result.status) : 'Pendiente de evaluación'}
      </h2>
      <p className="mt-1 text-sm">
        <Link
          className="underline"
          to={accountPath(accountId, 'acciones', sp, { accion: plan.actionId })}
        >
          Ver acción y decisiones
        </Link>{' '}
        · {plan.retrospective ? 'Captura retrospectiva' : 'Baseline registrado antes del envío'}
      </p>
      <p className="mt-2 text-sm">
        <strong>
          {result?.status === 'observed'
            ? 'Ventana disponible para revisión:'
            : 'Próxima revisión:'}
        </strong>{' '}
        desde{' '}
        {new Date(
          Date.parse(`${plan.afterUntil}T00:00:00Z`) + (plan.maturityDays + 1) * 86400000,
        ).toLocaleDateString('es', { timeZone: 'UTC' })}
        , cuando la ventana posterior haya madurado según la configuración.
      </p>
      <p className="mt-2 text-sm text-gray-500">
        Antes: {plan.beforeSince} — {plan.beforeUntil} · Después: {plan.afterSince} —{' '}
        {plan.afterUntil} · {currency}
      </p>
      <p className="mt-1 text-sm">
        Comparadores fijados:{' '}
        {plan.comparators.map((e) => e.name).join(', ') || 'ninguno admisible'}
      </p>
      {result && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {[
                    'Grupo',
                    'Gasto antes',
                    'Gasto después',
                    'Resultados antes',
                    'Resultados después',
                    'Δ resultados',
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b p-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[result.target, ...result.comparators].map((e) => (
                  <tr key={e.id}>
                    <th className="p-2 font-medium">
                      {e.name}
                      {!e.comparable && ' · insuficiente'}
                    </th>
                    <td className="p-2">{fmt(e.before.spend)}</td>
                    <td className="p-2">{fmt(e.after.spend)}</td>
                    <td className="p-2">{fmt(e.before.results)}</td>
                    <td className="p-2">{fmt(e.after.results)}</td>
                    <td className="p-2">{fmt(e.delta?.results)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm">{result.interpretation}</p>
        </>
      )}
      <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
        {(result?.flags ?? plan.flags).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer">Series del objetivo antes y después</summary>
        <Series
          days={[...plan.target.days, ...(result?.target.series ?? [])]}
          currency={currency}
        />
      </details>
    </article>
  );
}

function PolicyEditor({
  accountId,
  data,
  configure,
  refresh,
}: {
  accountId: string;
  data: MonitoringOverview;
  configure: boolean;
  refresh: () => unknown;
}) {
  const [p, setP] = useState<MonitoringPolicy>(structuredClone(data.policy.config)),
    [reason, setReason] = useState('');
  const recipients = useQuery({
    queryKey: ['monitor-recipients', accountId],
    queryFn: () => api<{ id: string; name: string }[]>(`/v1/monitoring/${accountId}/recipients`),
    enabled: configure,
  });
  const m = useMutation({
    mutationFn: () =>
      api(`/v1/monitoring/${accountId}/policy`, {
        method: 'PUT',
        body: { policy: p, revision: data.policy.revision, reason },
      }),
    onSuccess: () => void refresh(),
  });
  const number = (
    key:
      | 'windowDays'
      | 'baselineDays'
      | 'maturityDays'
      | 'openAfter'
      | 'resolveAfter'
      | 'cooldownHours',
    title: string,
    min: number,
    max: number,
  ) => (
    <label className="grid gap-1 text-sm" key={key}>
      {title}
      <input
        className={input}
        type="number"
        min={min}
        max={max}
        required
        value={p[key]}
        onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset disabled={!configure || m.isPending} className="space-y-4 disabled:opacity-75">
        <section className={box}>
          <h2 className="font-semibold">Ventanas y persistencia</h2>
          <label className="my-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={(e) => setP({ ...p, enabled: e.target.checked })}
            />
            Habilitar evaluación automática cada 15 minutos
          </label>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {number('windowDays', 'Ventana reciente (días)', 1, 28)}
            {number('baselineDays', 'Baseline (días)', 7, 84)}
            {number('maturityDays', 'Maduración excluida (días)', 1, 28)}
            {number('openAfter', 'Observaciones para abrir', 1, 7)}
            {number('resolveAfter', 'Observaciones limpias para resolver', 1, 7)}
            {number('cooldownHours', 'Recordatorio mínimo (horas)', 1, 168)}
          </div>
          <p className="mt-3 text-sm text-gray-500">
            Rendimiento y auditoría cuentan como máximo una observación por día local; las reglas
            operativas, una por franja de 15 minutos. Los reintentos no suman persistencia.
          </p>
        </section>
        <section className={box}>
          <h2 className="font-semibold">Reglas configurables</h2>
          <p className="mt-1 text-sm text-gray-500">
            Las métricas evalúan campañas completas. CPR y caída comparan tasas diarias de ventanas
            con cobertura completa y el mismo KPI y atribución.
          </p>
          <div className="mt-4 space-y-4">
            {p.rules.map((r, i) => (
              <div
                key={r.id}
                className="grid gap-2 border-b border-gray-200 pb-4 sm:grid-cols-6 dark:border-gray-800"
              >
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) =>
                      setP({
                        ...p,
                        rules: p.rules.map((x, j) =>
                          j === i ? { ...x, enabled: e.target.checked } : x,
                        ),
                      })
                    }
                  />
                  {label(r.kind)}
                </label>
                {(['severity', 'threshold', 'minSpend', 'minResults'] as const)
                  .filter(
                    (k) =>
                      (k !== 'threshold' || r.kind !== 'connection') &&
                      (k !== 'minSpend' ||
                        ['cpr_increase', 'results_drop', 'spend_without_results'].includes(
                          r.kind,
                        )) &&
                      (k !== 'minResults' || ['cpr_increase', 'results_drop'].includes(r.kind)),
                  )
                  .map((k) => (
                    <label className="grid gap-1 text-xs" key={k} htmlFor={`rule-${r.id}-${k}`}>
                      {k === 'severity'
                        ? 'Severidad'
                        : k === 'minSpend'
                          ? 'Gasto mínimo'
                          : k === 'minResults'
                            ? 'Resultados mínimos baseline / CPR'
                            : r.kind === 'connection'
                              ? 'Umbral (no aplica)'
                              : r.kind === 'sync_stale'
                                ? 'Antigüedad (horas)'
                                : r.kind === 'recommendation_stale' || r.kind === 'action_failed'
                                  ? 'Antigüedad / ventana (días)'
                                  : r.kind === 'audit'
                                    ? 'Hallazgos mínimos'
                                    : 'Umbral'}
                      {k === 'severity' ? (
                        <select
                          id={`rule-${r.id}-${k}`}
                          className={input}
                          value={r.severity}
                          onChange={(e) =>
                            setP({
                              ...p,
                              rules: p.rules.map((x, j) =>
                                j === i
                                  ? { ...x, severity: e.target.value as typeof r.severity }
                                  : x,
                              ),
                            })
                          }
                        >
                          {SEVERITIES.map((s) => (
                            <option key={s} value={s}>
                              {label(s)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`rule-${r.id}-${k}`}
                          className={`${input} w-full`}
                          type="number"
                          min={k === 'minResults' ? 1 : 0}
                          max={
                            k === 'minResults'
                              ? 1000000
                              : r.kind === 'results_drop' && k === 'threshold'
                                ? 100
                                : 100000000
                          }
                          step={
                            k === 'minResults' || (k === 'threshold' && r.kind === 'audit')
                              ? 1
                              : 'any'
                          }
                          required
                          value={r[k]}
                          onChange={(e) =>
                            setP({
                              ...p,
                              rules: p.rules.map((x, j) =>
                                j === i ? { ...x, [k]: Number(e.target.value) } : x,
                              ),
                            })
                          }
                        />
                      )}
                    </label>
                  ))}
              </div>
            ))}
          </div>
        </section>
        <section className={box}>
          <h2 className="font-semibold">Canales y control de ruido</h2>
          <p className="mt-1 text-sm text-gray-500">
            El correo necesita habilitación global, proveedor y remitente verificado. La
            autorización se revalida al entregar; el estado de entrega queda en la bitácora.
          </p>
          <div className="my-3 flex flex-wrap gap-4">
            {(['inApp', 'email'] as const).map((k) => (
              <label className="flex gap-2 text-sm" key={k}>
                <input
                  type="checkbox"
                  checked={p.notifications[k]}
                  onChange={(e) =>
                    setP({ ...p, notifications: { ...p.notifications, [k]: e.target.checked } })
                  }
                />
                {k === 'inApp' ? 'En la aplicación' : 'Correo (Resend)'}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="grid gap-1 text-sm">
              Severidad mínima
              <select
                className={input}
                value={p.notifications.minSeverity}
                onChange={(e) =>
                  setP({
                    ...p,
                    notifications: {
                      ...p.notifications,
                      minSeverity: e.target.value as typeof p.notifications.minSeverity,
                    },
                  })
                }
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </label>
            {(['quietStart', 'quietEnd', 'maxPerDay'] as const).map((k) => (
              <label className="grid gap-1 text-sm" key={k}>
                {k === 'quietStart'
                  ? 'Silencio desde (hora local)'
                  : k === 'quietEnd'
                    ? 'Silencio hasta (hora local)'
                    : 'Máximo por persona/canal/día'}
                <input
                  className={input}
                  required
                  type="number"
                  min={k === 'maxPerDay' ? 1 : 0}
                  max={k === 'maxPerDay' ? 24 : 23}
                  value={p.notifications[k]}
                  onChange={(e) =>
                    setP({
                      ...p,
                      notifications: { ...p.notifications, [k]: Number(e.target.value) },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Horas iguales desactivan el silencio. Los incidentes se agrupan en un resumen por
            cuenta, canal y destinatario.
          </p>
          <p className="mt-3 text-sm font-medium">Destinatarios con acceso a la cuenta</p>
          <div className="mt-2 flex flex-wrap gap-4">
            {recipients.data?.map((u) => (
              <label className="flex items-center gap-2 text-sm" key={u.id}>
                <input
                  type="checkbox"
                  checked={p.notifications.recipientIds.includes(u.id)}
                  onChange={(e) =>
                    setP({
                      ...p,
                      notifications: {
                        ...p.notifications,
                        recipientIds: e.target.checked
                          ? [...p.notifications.recipientIds, u.id]
                          : p.notifications.recipientIds.filter((id) => id !== u.id),
                      },
                    })
                  }
                />
                {u.name}
              </label>
            ))}
          </div>
          {recipients.error && <ErrorBox error={recipients.error} />}
        </section>
        <section className={box}>
          <h2 className="font-semibold">Seguimiento, informes y eventos externos</h2>
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="grid gap-1 text-sm">
              Ventanas antes / después
              <select
                className={input}
                value={p.followupDays}
                onChange={(e) =>
                  setP({ ...p, followupDays: Number(e.target.value) as 7 | 14 | 28 })
                }
              >
                {[7, 14, 28].map((n) => (
                  <option key={n} value={n}>
                    {n} días
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Informe automático
              <select
                className={input}
                value={p.reportEveryDays}
                onChange={(e) =>
                  setP({ ...p, reportEveryDays: Number(e.target.value) as 0 | 1 | 7 | 28 })
                }
              >
                {[0, 1, 7, 28].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'Desactivado' : `Cada ${n} días (últimos 28 días maduros)`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mt-3 text-sm text-gray-500">
            Anota promociones, feriados, cambios de CRM o mercado. Se señalan como posibles factores
            de confusión.
          </p>
          {p.externalEvents.map((event, i) => (
            // Los eventos no tienen identidad remota; se conservan en orden de edición.
            // biome-ignore lint/suspicious/noArrayIndexKey: lista local de edición sin estado en sus filas.
            <div className="mt-2 flex flex-wrap gap-2" key={i}>
              <input
                className={input}
                type="date"
                required
                aria-label="Inicio del evento"
                value={event.since}
                onChange={(e) =>
                  setP({
                    ...p,
                    externalEvents: p.externalEvents.map((x, j) =>
                      j === i ? { ...x, since: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                className={input}
                type="date"
                required
                aria-label="Fin del evento"
                value={event.until}
                onChange={(e) =>
                  setP({
                    ...p,
                    externalEvents: p.externalEvents.map((x, j) =>
                      j === i ? { ...x, until: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                className={`${input} flex-1`}
                required
                minLength={3}
                maxLength={200}
                aria-label="Descripción del evento"
                value={event.label}
                onChange={(e) =>
                  setP({
                    ...p,
                    externalEvents: p.externalEvents.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  })
                }
              />
              <button
                type="button"
                className={button}
                onClick={() =>
                  setP({ ...p, externalEvents: p.externalEvents.filter((_, j) => j !== i) })
                }
              >
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className={`${button} mt-3`}
            disabled={p.externalEvents.length >= 50}
            onClick={() =>
              setP({
                ...p,
                externalEvents: [
                  ...p.externalEvents,
                  {
                    since: new Date().toISOString().slice(0, 10),
                    until: new Date().toISOString().slice(0, 10),
                    label: '',
                  },
                ],
              })
            }
          >
            Añadir evento
          </button>
        </section>
        {configure && (
          <div className="flex flex-wrap gap-2">
            <input
              className={`${input} min-w-64 flex-1`}
              required
              minLength={5}
              maxLength={1000}
              aria-label="Motivo de autorización"
              placeholder="Motivo: autorizo estas reglas, canales y destinatarios"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="submit"
              className={button}
              disabled={m.isPending || reason.trim().length < 5}
            >
              Guardar y autorizar configuración
            </button>
          </div>
        )}
      </fieldset>
      {!configure && (
        <p className="text-sm">
          Solo responsables, administradores y managers con acceso pueden configurar.
        </p>
      )}
      {m.error && <ErrorBox error={m.error} />}
    </form>
  );
}
function Series({ days, currency }: { days: Day[]; currency: string }) {
  const [metric, setMetric] = useState<'spend' | 'results' | 'leads' | 'purchases'>('spend'),
    values = days.map((d) => d[metric]),
    max = Math.max(1, ...values.filter((v): v is number => v !== null)),
    n = days.length;
  const path = days
    .map((d, i) =>
      d[metric] === null
        ? ''
        : `${i === 0 || values[i - 1] === null || Date.parse(d.date) - Date.parse(days[i - 1]?.date ?? d.date) !== 86400000 ? 'M' : 'L'}${30 + (i * 640) / Math.max(1, n - 1)},${160 - (140 * (d[metric] ?? 0)) / max}`,
    )
    .join(' ');
  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 text-sm">
        Serie
        <select
          className={input}
          value={metric}
          onChange={(e) => setMetric(e.target.value as typeof metric)}
        >
          {[
            ['spend', `Gasto (${currency})`],
            ['results', 'Resultados Meta'],
            ['leads', 'Leads Meta'],
            ['purchases', 'Compras Meta'],
          ].map(([k, t]) => (
            <option key={k} value={k}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {n > 0 && (
        <svg
          viewBox="0 0 700 190"
          role="img"
          aria-label={`Serie histórica de ${metric}. Valores disponibles en la tabla.`}
          className="mt-3 w-full"
        >
          <text x="0" y="14" fontSize="11" fill="currentColor">
            {fmt(max)}
          </text>
          <path d="M30 160 H670" stroke="currentColor" opacity="0.2" />
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
          {days.map((d, i) =>
            d[metric] !== null ? (
              <circle
                key={d.date}
                cx={30 + (i * 640) / Math.max(1, n - 1)}
                cy={160 - (140 * (d[metric] ?? 0)) / max}
                r="2"
                fill="currentColor"
              >
                <title>
                  {d.date}: {fmt(d[metric])}
                </title>
              </circle>
            ) : null,
          )}
          <text x="30" y="185" fontSize="11" fill="currentColor">
            {days[0]?.date}
          </text>
          <text x="670" y="185" textAnchor="end" fontSize="11" fill="currentColor">
            {days[n - 1]?.date}
          </text>
        </svg>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">Tabla de datos ({n} días observados)</summary>
        <div className="max-h-80 overflow-auto">
          <table className="mt-2 w-full text-left text-xs">
            <thead>
              <tr>
                {['Fecha', 'Gasto', 'Resultados', 'Leads', 'Compras', 'Atribución / KPI'].map(
                  (s) => (
                    <th key={s} className="border-b p-2">
                      {s}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td className="p-2">{d.date}</td>
                  {(['spend', 'results', 'leads', 'purchases'] as const).map((k) => (
                    <td key={k} className="p-2">
                      {fmt(d[k])}
                    </td>
                  ))}
                  <td className="p-2">
                    {d.attribution ?? 'Desconocida'} / {d.indicator ?? 'Desconocido'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {!n && <p className="mt-3 text-sm">Sin series disponibles.</p>}
    </div>
  );
}
function Reports({
  accountId,
  reports,
  canRun,
  refresh,
}: {
  accountId: string;
  reports: MonitoringOverview['reports'];
  canRun: boolean;
  refresh: () => unknown;
}) {
  const [days, setDays] = useState(28),
    [selected, setSelected] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/v1/monitoring/${accountId}/reports`, {
        method: 'POST',
        body: { days },
      }),
    onSuccess: (r) => {
      setSelected(r.id);
      void refresh();
    },
  });
  const report = useQuery({
    queryKey: ['monitor-report', selected],
    queryFn: () =>
      api<{ id: string; snapshot: MonitorReport }>(`/v1/monitoring/reports/${selected}`),
    enabled: !!selected,
  });
  const r = report.data?.snapshot;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        {canRun && (
          <>
            <label className="grid gap-1 text-sm">
              Ventana del informe
              <select
                className={input}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[7, 28, 84].map((n) => (
                  <option key={n} value={n}>
                    {n} días maduros
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={button}
              disabled={m.isPending}
              onClick={() => m.mutate()}
            >
              Generar informe
            </button>
          </>
        )}
        <label className="grid gap-1 text-sm">
          Informes guardados
          <select className={input} value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Selecciona un informe</option>
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {at(r.at)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {m.error && <ErrorBox error={m.error} />}
      {report.error && <ErrorBox error={report.error} />}
      <p className="text-sm text-gray-500">
        Cada informe es un snapshot inmutable. Las revisiones futuras de Meta aparecen en informes
        nuevos. No se envían informes por correo automáticamente.
      </p>
      {r && (
        <>
          <article className={box}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Informe ejecutivo · {r.account.name}</h2>
                <p className="mt-1 text-sm text-gray-500">
                  {r.window.since} — {r.window.until} · {r.account.currency} · {r.account.timezone}
                </p>
              </div>
              <button
                type="button"
                className={button}
                onClick={() =>
                  saveFile(
                    `informe-ejecutivo-${selected}.md`,
                    executiveMarkdown(r),
                    'text/markdown',
                  )
                }
              >
                Descargar ejecutivo
              </button>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Métrica</th>
                    <th className="p-2">Período</th>
                    <th className="p-2">Anterior</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['spend', 'Gasto'],
                      ['results', 'Resultados Meta'],
                      ['leads', 'Leads Meta'],
                      ['purchases', 'Compras Meta'],
                      ['cpr', 'Costo por resultado'],
                    ] as const
                  ).map(([k, t]) => (
                    <tr key={k}>
                      <th className="border-t p-2 font-medium">{t}</th>
                      <td className="border-t p-2">{fmt(r.executive.summary[k])}</td>
                      <td className="border-t p-2">{fmt(r.executive.previous[k])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-sm">
              {r.executive.openIncidents} incidentes abiertos · {r.executive.failedActions} acciones
              fallidas
            </p>
            <h3 className="mt-4 font-medium">Próximos pasos</h3>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
              {r.executive.nextSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <h3 className="mt-4 font-medium">Hipótesis y límites</h3>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-gray-600 dark:text-gray-300">
              {r.limitations.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </article>
          <article className={box}>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="font-semibold">Informe técnico</h2>
              <button
                type="button"
                className={button}
                onClick={() =>
                  saveFile(
                    `informe-tecnico-${selected}.json`,
                    JSON.stringify(r, null, 2),
                    'application/json',
                  )
                }
              >
                Descargar técnico JSON
              </button>
            </div>
            <p className="mt-2 text-sm">
              Motor {r.version} · {r.technical.findings.length} hallazgos ·{' '}
              {r.technical.recommendations.length} recomendaciones · {r.technical.actions.length}{' '}
              acciones · {r.technical.events.length} eventos
              {r.technical.eventHistoryTruncated && ' (límite de eventos alcanzado)'}
            </p>
            <Series days={r.technical.series} currency={r.account.currency} />
            <p className="mt-3 text-sm text-gray-500">{r.technical.crm.reason}</p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer">
                Cambios, incidencias y configuración registrados
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify({ ...r.technical, series: undefined }, null, 2)}
              </pre>
            </details>
          </article>
        </>
      )}
    </div>
  );
}
function History({ accountId }: { accountId: string }) {
  const q = useQuery({
    queryKey: ['monitor-history', accountId],
    queryFn: () =>
      api<
        {
          id: number;
          at: string;
          event: string;
          actorId: string | null;
          actorName: string | null;
          data: unknown;
        }[]
      >(`/v1/monitoring/${accountId}/events`),
  });
  return (
    <section className={box}>
      <h2 className="font-semibold">Historial de la cuenta</h2>
      <p className="mt-1 text-sm text-gray-500">
        Últimos 300 eventos de la cuenta; también se registran en la auditoría general.
      </p>
      {q.error && <ErrorBox error={q.error} />}
      {q.isPending && (
        <p role="status" className="mt-3 text-sm">
          Cargando historial…
        </p>
      )}
      {q.data?.length === 0 && (
        <p className="mt-3 text-sm">Todavía no hay eventos registrados para esta cuenta.</p>
      )}
      <ol className="account-history mt-3 space-y-3 text-sm">
        {q.data?.map((e) => {
          const d = e.data as { reason?: string; from?: string; to?: string };
          return (
            <li key={e.id} className="border-b border-gray-200 pb-3 dark:border-gray-800">
              <strong>
                {(
                  {
                    incident_decided: 'Decisión sobre un incidente',
                    incident_opened: 'Se abrió un incidente',
                    incident_resolved: 'Se confirmó la recuperación',
                    incident_reopened: 'Se reabrió un incidente',
                    policy_authorized: 'Se actualizaron las reglas de monitoreo',
                    report_generated: 'Se generó un informe',
                    evaluated: 'Evaluación de la cuenta',
                    incident_updated: 'Se actualizó la evidencia',
                    followup_evaluated: 'Se revisó el seguimiento',
                  } as Record<string, string>
                )[e.event] ?? e.event.replaceAll('_', ' ')}
              </strong>
              <p className="mt-1 text-xs text-gray-500">
                {at(e.at)} · {e.actorName ?? (e.actorId ? 'Miembro del equipo' : 'Sistema')}
              </p>
              {d?.from && d.to && (
                <p className="mt-1">
                  {label(d.from)} → {label(d.to)}
                </p>
              )}
              {d?.reason && <p className="mt-1">{d.reason}</p>}
              <details>
                <summary className="cursor-pointer text-xs">Detalles técnicos</summary>
                <pre className="mt-1 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
