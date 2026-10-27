import { useQuery } from '@tanstack/react-query';
import type { technicalSnapshot } from '../../src/platform/operations.ts';
import { api } from './api.ts';
import { ErrorBox } from './pages.tsx';

const labels: Record<string, string> = {
  meta_connection_invalid: 'Conexión Meta inválida',
  worker_stale: 'Worker sin latido reciente',
  queue_delayed: 'Cola con retraso',
  dead_jobs: 'Trabajos fallidos en 24 horas',
  expired_leases: 'Trabajos con lease vencido',
  unknown_writes: 'Escrituras Meta por conciliar',
  unknown_notifications: 'Avisos con entrega desconocida',
  llm_holds: 'Reservas de inferencia pendientes',
  backup_stale: 'Backup sin evidencia reciente',
  restore_drill_stale: 'Simulacro sin evidencia vigente',
  recovery_mode: 'Modo de recuperación activo',
};
export function OperationsPage() {
  const q = useQuery({
      queryKey: ['operations'],
      queryFn: () => api<Awaited<ReturnType<typeof technicalSnapshot>>>('/v1/operations'),
      refetchInterval: 30000,
    }),
    d = q.data;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Estado técnico</h1>
        <p className="mt-1 text-sm text-gray-500">
          Métricas de tu organización y evidencia operativa del entorno. Un panel sin incidentes no
          sustituye al monitor externo.
        </p>
      </header>
      {q.error && <ErrorBox error={q.error} />}{' '}
      {!d && q.isPending && <p role="status">Consultando estado…</p>}
      {d && (
        <>
          <p className="text-sm">
            Entorno <strong>{d.environment}</strong> · esquema {d.schemaVersion} ·{' '}
            {d.recoveryMode ? 'efectos externos bloqueados' : 'operación habilitada'} · actualizado{' '}
            {new Date(d.at).toLocaleString('es')}
          </p>
          <section className="grid gap-3 md:grid-cols-3">
            {[
              ['Cola pendiente', d.queue?.queued ?? 0],
              ['Llamadas Meta en 24 h', d.meta24h?.calls ?? 0],
              [
                'Fallos / throttling Meta',
                `${d.meta24h?.failures ?? 0} / ${d.meta24h?.throttled ?? 0}`,
              ],
              ['Inferencia del mes (USD)', d.llmMonth.usd.toFixed(4)],
              ['Reservas pendientes (USD)', d.llmMonth.reservedUsd.toFixed(4)],
              ['Tokens entrada / salida', `${d.llmMonth.inputTokens} / ${d.llmMonth.outputTokens}`],
            ].map(([name, value]) => (
              <article
                key={name}
                className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
              >
                <h2 className="text-sm text-gray-500">{name}</h2>
                <p className="mt-2 text-xl font-semibold">{value}</p>
              </article>
            ))}
          </section>
          <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <h2 className="font-semibold">Alertas técnicas</h2>
            <p className="mt-1 text-sm text-gray-500">
              El tick conserva las transiciones en auditoría. Las reservas recientes del LLM pueden
              ser llamadas en curso; las desconocidas necesitan conciliación.
            </p>
            <ul className="mt-3 space-y-3">
              {d.observations
                .filter((o) => o.hit)
                .map((o) => (
                  <li key={o.code} className="border-l-2 border-amber-500 pl-3">
                    <strong className="text-sm">{labels[o.code] ?? o.code}</strong>
                    <p className="text-xs text-gray-500">Severidad: {o.severity}</p>
                    <pre className="mt-1 overflow-auto text-xs">
                      {JSON.stringify(o.evidence, null, 2)}
                    </pre>
                  </li>
                ))}
            </ul>
            {d.observations.every((o) => !o.hit) && (
              <p className="mt-3 text-sm">Sin condiciones activas en esta evaluación.</p>
            )}
          </section>
          <p className="text-sm text-gray-500">
            El RPO y RTO de producción requieren pruebas en la infraestructura real. Un backup local
            no acredita PITR, almacenamiento externo ni disponibilidad del proveedor.
          </p>
        </>
      )}
    </div>
  );
}
