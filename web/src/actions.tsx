import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { BudgetAction, Policy } from '../../src/action-contracts.ts';
import type { AdAccount, Recommendation } from '../../src/contracts.ts';
import { ACTION_STATES, ACTION_TYPES, type Role } from '../../src/domain.ts';
import { api } from './api.ts';
import { ErrorBox } from './pages.tsx';

const names: Record<string, string> = {
  proposed: 'Propuesta',
  review: 'Revisión',
  approved: 'Aprobación',
  executing: 'Ejecución',
  verifying: 'Verificación',
  failed: 'Fallo',
  closed: 'Cierre',
  pause: 'Pausar',
  activate: 'Activar',
  set_daily_budget: 'Presupuesto diario',
  set_lifetime_budget: 'Presupuesto total',
};
const input =
  'rounded border border-gray-300 bg-transparent px-2 py-1.5 text-sm dark:border-gray-700';
const button =
  'rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';
const box = 'min-w-0 rounded-lg border border-gray-200 p-4 dark:border-gray-800';
const admin = (role: Role) => role === 'owner' || role === 'admin';
const minors = (n: string, currency: string) =>
  `${Number(n).toLocaleString('es')} unid. menores ${currency}`;
const refreshKeys = ['actions', 'recommendations', 'action-policy'];
function useRefresh() {
  const cache = useQueryClient();
  return () => {
    for (const key of refreshKeys) void cache.invalidateQueries({ queryKey: [key] });
  };
}

export function ActionCenterPage({ role, userId }: { role: Role; userId: string }) {
  const { accountId } = useParams(),
    navigate = useNavigate();
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<AdAccount[]>('/v1/ad-accounts'),
  });
  const q = useQuery({
    queryKey: ['actions', accountId],
    queryFn: () =>
      api<BudgetAction[]>(`/v1/actions${accountId ? `?adAccountId=${accountId}` : ''}`),
    refetchInterval: (query) =>
      query.state.data?.some((a) => ['approved', 'executing', 'verifying'].includes(a.state))
        ? 3000
        : false,
  });
  const recs = useQuery({
    queryKey: ['recommendations', 'action-center', accountId],
    queryFn: () =>
      api<Recommendation[]>(`/v1/recommendations${accountId ? `?adAccountId=${accountId}` : ''}`),
  });
  const [filter, setFilter] = useState('all');
  const queryError = q.error ?? accounts.error ?? recs.error;
  const account = accounts.data?.find((a) => a.id === accountId);
  const actionable =
    recs.data?.filter(
      (r) =>
        ['open', 'accepted'].includes(r.status) &&
        r.actionType !== 'review' &&
        r.entityLevel !== 'account' &&
        !q.data?.some((a) => a.recommendationId === r.id),
    ) ?? [];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Action Center</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Revisa el cambio, autoriza su ejecución y comprueba lo que Meta aplicó.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Cuenta
          <select
            className={input}
            value={accountId ?? ''}
            onChange={(e) => navigate(e.target.value ? `/acciones/${e.target.value}` : '/acciones')}
          >
            <option value="">Todas las cuentas</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p
        role="note"
        className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950/30"
      >
        Aceptar una recomendación crea una intención. Solo un diff revisado y aprobado por otra
        persona autoriza el envío. Activar una entidad puede generar gasto. Las escrituras necesitan
        habilitación global, reglas por cuenta y consentimiento vigente.
      </p>
      <ol
        className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-300"
        aria-label="Etapas de una acción"
      >
        {ACTION_STATES.map((s, i) => (
          <li key={s}>
            {i + 1}. {names[s]}
          </li>
        ))}
      </ol>
      {queryError && <ErrorBox error={queryError} />}
      {accountId && (
        <PolicyEditor
          key={accountId}
          accountId={accountId}
          role={role}
          currency={account?.currency ?? ''}
        />
      )}
      {role !== 'viewer' && (
        <section className={`${box} space-y-3`}>
          <h2 className="font-semibold">Recomendaciones</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Proponer no ejecuta. Las recomendaciones de revisión y los cambios a nivel de cuenta no
            son operaciones ejecutables.
          </p>
          {actionable.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay recomendaciones aceptadas pendientes de convertir en acciones.
            </p>
          ) : (
            actionable.map((r) => (
              <RecommendationAction
                key={r.id}
                recommendation={r}
                role={role}
                currency={accounts.data?.find((a) => a.id === r.adAccountId)?.currency ?? ''}
              />
            ))
          )}
        </section>
      )}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Operaciones y resultados</h2>
          <label className="text-sm">
            Estado{' '}
            <select className={input} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">Todos</option>
              {ACTION_STATES.map((s) => (
                <option key={s} value={s}>
                  {names[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {q.isPending ? (
          <p role="status">Cargando acciones…</p>
        ) : q.data?.length === 0 ? (
          <p className={box}>
            Aún no hay acciones. Acepta una recomendación y crea su propuesta para comenzar.
          </p>
        ) : (
          q.data
            ?.filter((a) => filter === 'all' || a.state === filter)
            .map((a) => (
              <ActionCard key={`${a.id}:${a.revision}`} action={a} role={role} userId={userId} />
            ))
        )}
        <p className="text-xs text-gray-500">
          Se muestran las 100 acciones más recientes del alcance seleccionado. El estado se
          actualiza mientras hay trabajo pendiente.
        </p>
      </section>
    </div>
  );
}

function RecommendationAction({
  recommendation: r,
  currency,
  role,
}: {
  recommendation: Recommendation;
  currency: string;
  role: Role;
}) {
  const refresh = useRefresh(),
    id = useId();
  const [reason, setReason] = useState(''),
    [amount, setAmount] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const budget = r.actionType.startsWith('set_');
  const m = useMutation({
    mutationFn: () =>
      r.status === 'open'
        ? api(`/v1/recommendations/${r.id}/decision`, {
            method: 'POST',
            body: { status: 'accepted', reason },
          })
        : api('/v1/actions', {
            method: 'POST',
            body: {
              recommendationId: r.id,
              idempotencyKey: key,
              reason,
              ...(budget ? { budgetMinor: amount } : {}),
            },
          }),
    onSuccess: refresh,
  });
  return (
    <form
      className="space-y-2 border-t border-gray-100 pt-3 dark:border-gray-900"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <p className="text-sm">
        <strong>{names[r.actionType]}</strong> · {r.entityLevel} {r.entityMetaId}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-300">{r.rationale}</p>
      <div className="flex flex-wrap items-end gap-2">
        {budget && r.status === 'accepted' && (
          <label htmlFor={`${id}-amount`} className="flex flex-col text-sm">
            Presupuesto absoluto en unidades menores ({currency})
            <input
              id={`${id}-amount`}
              className={input}
              inputMode="numeric"
              pattern="[1-9][0-9]{0,14}"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
        )}
        <label htmlFor={`${id}-reason`} className="flex min-w-48 flex-1 flex-col text-sm">
          Motivo de la propuesta
          <input
            id={`${id}-reason`}
            className={input}
            required
            minLength={8}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className={button}
          disabled={
            m.isPending ||
            reason.trim().length < 8 ||
            (r.status === 'open' && !['owner', 'admin', 'manager'].includes(role)) ||
            (budget && r.status === 'accepted' && !/^[1-9]\d{0,14}$/.test(amount))
          }
        >
          {r.status === 'open' ? 'Aceptar recomendación' : 'Crear propuesta'}
        </button>
      </div>
      {m.error && <ErrorBox error={m.error} />}
    </form>
  );
}

function ActionCard({
  action: a,
  role,
  userId,
}: {
  action: BudgetAction;
  role: Role;
  userId: string;
}) {
  const refresh = useRefresh(),
    id = useId();
  const [reason, setReason] = useState(''),
    [authorized, setAuthorized] = useState(false),
    [ack, setAck] = useState(false),
    [showEvents, setShowEvents] = useState(false);
  const p = a.preview,
    canPropose = role !== 'viewer',
    canApprove = ['owner', 'admin', 'manager'].includes(role);
  const eligible =
    canApprove &&
    a.proposedBy !== userId &&
    (a.operation === 'pause' || a.operation === 'activate' || admin(role));
  const events = useQuery({
    queryKey: ['action-events', a.id, a.revision],
    queryFn: () =>
      api<Array<{ id: number; event: string; at: string; actorId: string | null; data: unknown }>>(
        `/v1/actions/${a.id}/events`,
      ),
    enabled: showEvents,
  });
  const command = useMutation({
    mutationFn: ({ op, body }: { op: string; body: unknown }) =>
      api(`/v1/actions/${a.id}/${op}`, { method: 'POST', body }),
    onSuccess: refresh,
  });
  const run = (op: string, body: unknown) => command.mutate({ op, body });
  const actionable = ['proposed', 'review', 'failed'].includes(a.state) && !a.dispatchAt;
  // ponytail: heurística de UI (lease de la cola); el servidor exige que no haya trabajo activo.
  const stalled =
    ['executing', 'verifying'].includes(a.state) &&
    Date.now() - Date.parse(a.updatedAt) > 15 * 60_000;
  return (
    <article className={`${box} space-y-3`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">
          {names[a.operation]} · {a.entityLevel} {a.entityMetaId}
        </h3>
        <span
          className={`ml-auto rounded px-2 py-1 text-xs ${a.state === 'failed' ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' : 'bg-gray-100 dark:bg-gray-900'}`}
        >
          {names[a.state]}
        </span>
      </header>
      <p className="text-sm">{a.reason}</p>
      <p className="text-xs text-gray-500">
        Acción {a.id.slice(0, 8)} · revisión {a.revision} · propuesta por{' '}
        {a.proposedBy === userId ? 'ti' : a.proposedBy.slice(0, 8)}
        {a.rollbackOf && ` · inversa de ${a.rollbackOf.slice(0, 8)}`}
      </p>
      {p && (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <caption className="sr-only">Diferencias leídas en vivo antes de aprobar</caption>
              <thead className="text-xs text-gray-500">
                <tr>
                  <th scope="col">Campo</th>
                  <th scope="col">Antes</th>
                  <th scope="col">Después</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="py-2 font-normal">
                    {p.field}
                  </th>
                  <td>{p.field === 'status' ? p.before : minors(p.before, p.snapshot.currency)}</td>
                  <td className="font-semibold">
                    {p.field === 'status' ? p.after : minors(p.after, p.snapshot.currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            Aprobaciones:{' '}
            <strong>
              {a.approvals.length}/{p.requiredApprovals}
            </strong>
            . Diff válido hasta {new Date(p.expiresAt).toLocaleString('es')}.
            {p.field !== 'status' && ` Cambio: ${p.changePct.toFixed(1)} %.`}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {a.error && (
        <p
          role="alert"
          className="rounded border border-amber-300 p-2 text-sm dark:border-amber-800"
        >
          {a.error}
        </p>
      )}
      {a.after && (
        <p className="text-sm">
          Relectura: estado configurado <strong>{a.after.status}</strong>, efectivo{' '}
          <strong>{a.after.effectiveStatus}</strong>.
          {p?.field !== 'status' &&
            p &&
            ` Presupuesto: ${minors(p.field === 'daily_budget' ? a.after.dailyBudget : a.after.lifetimeBudget, a.after.currency)}.`}{' '}
          Verificar configuración no garantiza entrega ni resultados.
        </p>
      )}
      {a.result && (
        <p className="text-sm">
          Resultado:{' '}
          {(
            {
              verified: 'configuración verificada',
              already_current: 'el valor ya coincidía; no se envió una escritura',
              cancelled: 'cancelada antes de enviar',
              abandoned_unknown: 'cerrada reconociendo un resultado desconocido',
              unknown: 'resultado desconocido',
              rejected: 'rechazada por Meta',
              blocked: 'bloqueada por una comprobación',
            } as Record<string, string>
          )[a.result] ?? a.result}
          .
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {actionable && canPropose && (
          <button
            type="button"
            className={button}
            disabled={command.isPending}
            onClick={() => run('preview', { revision: a.revision })}
          >
            Previsualizar en vivo
          </button>
        )}
        <button type="button" className={button} onClick={() => setShowEvents(!showEvents)}>
          {showEvents ? 'Ocultar bitácora' : 'Ver bitácora'}
        </button>
        <Link
          className={`${button} inline-block`}
          to={`/analitica/${a.entityLevel === 'campaign' ? 'campana' : a.entityLevel === 'adset' ? 'conjunto' : 'anuncio'}/${a.entityMetaId}`}
        >
          Ver entidad
        </Link>
      </div>
      {a.state === 'review' && a.proposedBy === userId && (
        <p className="text-sm text-gray-500">Otra persona autorizada debe aprobar tu propuesta.</p>
      )}
      {((a.state === 'review' && eligible) ||
        (canApprove &&
          (stalled || ['proposed', 'review', 'approved', 'failed'].includes(a.state))) ||
        (canPropose && a.state === 'closed' && a.result === 'verified' && a.confirmedWrite)) && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (p && authorized)
              run('approve', {
                revision: a.revision,
                previewHash: p.hash,
                authorize: true,
                reason,
              });
          }}
        >
          <label htmlFor={`${id}-decision`} className="flex flex-col gap-1 text-sm">
            Motivo de la decisión
            <input
              id={`${id}-decision`}
              className={`${input} w-full`}
              minLength={8}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {a.state === 'review' && eligible && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={authorized}
                onChange={(e) => setAuthorized(e.target.checked)}
              />
              Autorizo exactamente este diff y su ejecución en Meta cuando se complete el quorum.
            </label>
          )}
          {a.state === 'failed' && a.dispatchAt && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              Reconozco que el resultado es desconocido; cerrar no revierte ni reenvía.
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {a.state === 'review' && eligible && (
              <button
                type="submit"
                className={button}
                disabled={
                  command.isPending ||
                  !authorized ||
                  reason.trim().length < 8 ||
                  a.approvals.some((x) => x.userId === userId)
                }
              >
                Aprobar y autorizar
              </button>
            )}
            {canApprove && ['proposed', 'review', 'approved', 'failed'].includes(a.state) && (
              <button
                type="button"
                className={button}
                disabled={
                  command.isPending || reason.trim().length < 8 || Boolean(a.dispatchAt && !ack)
                }
                onClick={() =>
                  run('close', { revision: a.revision, reason, acknowledgeUnknown: ack })
                }
              >
                Cerrar con motivo
              </button>
            )}
            {canApprove && (a.state === 'failed' || stalled) && a.dispatchAt && (
              <button
                type="button"
                className={button}
                disabled={command.isPending}
                onClick={() => run('reconcile', {})}
              >
                Reconciliar por lectura
              </button>
            )}
            {canPropose && a.state === 'closed' && a.result === 'verified' && a.confirmedWrite && (
              <button
                type="button"
                className={button}
                disabled={command.isPending || reason.trim().length < 8}
                onClick={() => run('rollback', { idempotencyKey: crypto.randomUUID(), reason })}
              >
                Proponer reversión
              </button>
            )}
          </div>
        </form>
      )}
      {command.error && <ErrorBox error={command.error} />}
      {showEvents && (
        <div className="space-y-2 border-t border-gray-100 pt-3 dark:border-gray-900">
          <h4 className="text-sm font-semibold">Bitácora inmutable</h4>
          {events.error && <ErrorBox error={events.error} />}
          <ol className="space-y-2 text-xs">
            {events.data?.map((e) => (
              <li key={e.id}>
                <strong>{e.event}</strong> · {new Date(e.at).toLocaleString('es')} ·{' '}
                {e.actorId?.slice(0, 8) ?? 'worker'}
                <details>
                  <summary className="cursor-pointer">Evidencia</summary>
                  <pre className="overflow-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

function PolicyEditor({
  accountId,
  role,
  currency,
}: {
  accountId: string;
  role: Role;
  currency: string;
}) {
  const q = useQuery({
    queryKey: ['action-policy', accountId],
    queryFn: () =>
      api<{ globalEnabled: boolean; policy: Policy }>(`/v1/action-policies/${accountId}`),
  });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <p className="text-sm">Cargando reglas de escritura…</p>;
  return (
    <section className={box}>
      <h2 className="font-semibold">Reglas y autorización de la cuenta</h2>
      <p className="mt-1 text-sm">
        Interruptor global:{' '}
        <strong>{q.data.globalEnabled ? 'habilitado' : 'desactivado en el servidor'}</strong>.{' '}
        Cuenta: <strong>{q.data.policy.enabled ? 'habilitada' : 'kill switch activo'}</strong>.
      </p>
      {admin(role) ? (
        <PolicyForm
          key={JSON.stringify(q.data.policy)}
          accountId={accountId}
          initial={q.data.policy}
          currency={currency}
        />
      ) : (
        <p className="mt-2 text-sm text-gray-500">Owner o admin configuran estas reglas.</p>
      )}
    </section>
  );
}

function PolicyForm({
  accountId,
  initial,
  currency,
}: {
  accountId: string;
  initial: Policy;
  currency: string;
}) {
  const [p, setP] = useState(initial),
    [reason, setReason] = useState(''),
    id = useId(),
    refresh = useRefresh();
  const m = useMutation({
    mutationFn: ({ policy, reason }: { policy: Policy; reason: string }) =>
      api(`/v1/action-policies/${accountId}`, { method: 'PUT', body: { policy, reason } }),
    onSuccess: refresh,
  });
  const amountFields = [
    ['maxBudgetMinor', 'Máximo por presupuesto'],
    ['maxDailyIncreaseMinor', 'Aumentos acumulados por cuenta / 24 h'],
  ] as const;
  const numericFields = [
    ['maxChangePct', 'Cambio máximo por acción (%)'],
    ['maxCumulativeChangePct', 'Cambio acumulado por objeto / 24 h (%)'],
    ['doubleApprovalPct', 'Dos aprobadores desde (%)'],
    ['startHour', 'Hora inicial local (0–23)'],
    ['endHour', 'Hora final local (1–24)'],
  ] as const;
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">Configurar reglas y kill switch</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate({ policy: p, reason });
        }}
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => setP({ ...p, enabled: e.target.checked })}
          />
          Autorizar escrituras en esta cuenta bajo estas reglas
        </label>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1">Operaciones permitidas</legend>
          {ACTION_TYPES.map((op) => (
            <label className="flex items-center gap-1" key={op}>
              <input
                type="checkbox"
                checked={p.allowedOperations.includes(op)}
                onChange={(e) =>
                  setP({
                    ...p,
                    allowedOperations: e.target.checked
                      ? [...p.allowedOperations, op]
                      : p.allowedOperations.filter((x) => x !== op),
                  })
                }
              />
              {names[op]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-gray-500">
          Importes enteros en unidades menores {currency}: 10000 equivale a 100,00 si la moneda usa
          dos decimales. Los presupuestos y activaciones requieren un máximo mayor que cero. La
          política no autoriza cambios automáticos.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {amountFields.map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1" htmlFor={`${id}-${key}`}>
              {label}
              <input
                id={`${id}-${key}`}
                className={input}
                inputMode="numeric"
                pattern="(0|[1-9][0-9]{0,14})"
                value={p[key]}
                onChange={(e) => setP({ ...p, [key]: e.target.value })}
              />
            </label>
          ))}
          {numericFields.map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1" htmlFor={`${id}-${key}`}>
              {label}
              <input
                id={`${id}-${key}`}
                className={input}
                type="number"
                step="any"
                value={p[key]}
                onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1" htmlFor={`${id}-reason`}>
          Motivo del cambio de reglas
          <input
            id={`${id}-reason`}
            className={input}
            required
            minLength={8}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={button}
            disabled={m.isPending || reason.trim().length < 8}
          >
            Guardar reglas y autorización
          </button>
          <button
            type="button"
            className={button}
            disabled={m.isPending || !initial.enabled}
            onClick={() =>
              m.mutate({
                policy: { ...initial, enabled: false },
                reason: 'Kill switch activado manualmente por administrador',
              })
            }
          >
            Bloquear nuevas escrituras
          </button>
        </div>
        {m.error && <ErrorBox error={m.error} />}
        <p className="text-xs text-gray-500">
          Cambiar reglas invalida revisiones pendientes. Un envío que ya salió puede haber sido
          aplicado: el worker seguirá comprobándolo por lectura.
        </p>
      </form>
    </details>
  );
}
