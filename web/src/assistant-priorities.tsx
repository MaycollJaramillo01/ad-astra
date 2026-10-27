import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AdAccount, AuditCatalog, Finding } from '../../src/contracts.ts';
import { api } from './api.ts';
import { REVIEW_GUIDE, reviewTopics } from './assistant-review.ts';
import { formatDay } from './format.ts';
import { Icon } from './icons.tsx';

const SEVERITY = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
  info: 'Informativa',
};
const LEVEL = { account: 'Cuenta', campaign: 'Campaña', adset: 'Conjunto', ad: 'Anuncio' };
const PATH = { account: 'cuenta', campaign: 'campana', adset: 'conjunto', ad: 'anuncio' };

export function AssistantPriorities({
  onPrepare,
  accountId,
  busy = false,
}: {
  onPrepare: (question: string, finding?: Finding) => void;
  accountId: string | null;
  busy?: boolean;
}) {
  const findings = useQuery({
    queryKey: ['assistant-review', accountId],
    queryFn: () =>
      api<Finding[]>(
        `/v1/findings?status=open&groupBy=account_rule&limit=5${accountId ? `&adAccountId=${encodeURIComponent(accountId)}` : ''}`,
      ),
  });
  const catalog = useQuery({
    queryKey: ['audit-catalog'],
    queryFn: () => api<AuditCatalog>('/v1/audit/catalog'),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const accounts = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => api<AdAccount[]>('/v1/ad-accounts'),
  });
  const topics = reviewTopics(findings.data ?? []);
  const rules = new Map(catalog.data?.rules.map((r) => [r.id, r]));
  return (
    <section className="assistant-priorities" aria-labelledby="review-heading">
      <header className="assistant-section-heading">
        <div>
          <h2 id="review-heading">Qué revisar primero</h2>
          <p>
            {accountId
              ? 'Hallazgos abiertos de esta cuenta, ordenados por el motor de auditoría.'
              : 'Hallazgos abiertos de tu cartera, ordenados por el motor de auditoría.'}
          </p>
        </div>
        <Link to="/monitoreo" className="assistant-text-link">
          Ver monitoreo <Icon name="arrow" size={15} />
        </Link>
      </header>

      {findings.isPending ? (
        <div className="assistant-review-loading" role="status" aria-label="Cargando prioridades">
          {[1, 2, 3].map((n) => (
            <div key={n}>
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : findings.error ? (
        <div className="assistant-inline-error" role="alert">
          <strong>No pudimos cargar las prioridades.</strong>
          <p>
            Puedes seguir con la guía de revisión. Los hallazgos aparecerán al recuperar la
            conexión.
          </p>
          <button type="button" onClick={() => void findings.refetch()}>
            Volver a intentar
          </button>
        </div>
      ) : topics.length ? (
        <>
          <ol className="assistant-review-list" aria-label="Temas por prioridad">
            {topics.map(({ finding: f, count }, index) => {
              const rule = rules.get(f.ruleId);
              const account = accounts.data?.find((a) => a.id === f.adAccountId);
              const targetId = f.entityLevel === 'account' ? f.adAccountId : f.entityMetaId;
              const stale = Date.now() - Date.parse(f.lastSeenAt) > 7 * 86400000;
              const confidence = Number(f.confidence);
              return (
                <li
                  key={`${f.adAccountId}:${f.ruleId}`}
                  className={index === 0 ? 'assistant-review-first' : ''}
                >
                  <span className="assistant-rank">
                    <span className="sr-only">Prioridad </span>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="assistant-review-content">
                    <div className="assistant-review-title">
                      <h3>{rule?.title ?? 'Revisar hallazgo de auditoría'}</h3>
                      <span className={`assistant-severity severity-${f.severity}`}>
                        {SEVERITY[f.severity]}
                      </span>
                    </div>
                    <p className="assistant-review-context">
                      {account?.name ?? 'Cuenta autorizada'} · {LEVEL[f.entityLevel]}
                      {count > 1 && ` · ${count} señales agrupadas`}
                    </p>
                    <p className="assistant-review-next">
                      {f.recommendationText ??
                        rule?.description ??
                        'Abre la evidencia y confirma el alcance antes de decidir un cambio.'}
                    </p>
                    <details className="assistant-review-evidence">
                      <summary>Por qué revisarlo</summary>
                      <p>
                        {f.explanation ??
                          'El motor detectó una condición que necesita revisión. Contrasta su evidencia y el periodo observado.'}
                      </p>
                      <p>
                        Confianza{' '}
                        {Number.isFinite(confidence)
                          ? confidence >= 0.9
                            ? 'alta'
                            : confidence >= 0.7
                              ? 'media'
                              : 'baja'
                          : 'no disponible'}{' '}
                        ·{' '}
                        {f.windowStart && f.windowEnd
                          ? `${formatDay(f.windowStart)} a ${formatDay(f.windowEnd)}`
                          : `Última detección: ${formatDay(f.lastSeenAt.slice(0, 10))}`}
                      </p>
                    </details>
                    {stale && (
                      <p className="assistant-stale">
                        Confirma su vigencia: la última detección tiene más de una semana.
                      </p>
                    )}
                    <div className="assistant-review-actions">
                      <Link
                        to={`/analitica/${PATH[f.entityLevel]}/${encodeURIComponent(targetId)}`}
                        className="assistant-text-link"
                      >
                        Revisar evidencia <Icon name="arrow" size={14} />
                      </Link>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          onPrepare(
                            'Revisa los hallazgos abiertos de esta entidad y explica qué comprobar primero. Usa evidencia, señala las limitaciones y no ejecutes cambios.',
                            f,
                          )
                        }
                      >
                        Preparar consulta
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="assistant-selection-note">
            Mostramos hasta cinco temas con mayor prioridad, agrupados por regla y cuenta. La
            prioridad orienta la revisión; no predice una mejora.
          </p>
        </>
      ) : (
        <div className="assistant-review-empty">
          <Icon name="action" size={21} />
          <div>
            <strong>No hay hallazgos abiertos en esta selección.</strong>
            <p>
              Esto no confirma que todo esté bien. Comprueba que los datos y las auditorías estén al
              día.
            </p>
          </div>
        </div>
      )}

      {!findings.isPending && !topics.length && (
        <div className="assistant-review-guide">
          <p className="assistant-guide-label">
            Guía de revisión sugerida · no son problemas detectados
          </p>
          <ol>
            {REVIEW_GUIDE.map((item, i) => (
              <li key={item.title}>
                <span className="assistant-guide-number">{i + 1}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <div className="assistant-review-actions">
                    <Link to={item.to} className="assistant-text-link">
                      Abrir revisión <Icon name="arrow" size={14} />
                    </Link>
                    <button type="button" disabled={busy} onClick={() => onPrepare(item.prompt)}>
                      Preparar consulta
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
