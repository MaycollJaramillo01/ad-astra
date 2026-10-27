import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  AiAnswer,
  AiConversation,
  AiConversationDetail,
  AiMessage,
  AiStatus,
  AiTurn,
  Finding,
  Recommendation,
} from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import { METRICS, type NodeLevel, type Tone } from '../../src/modules/insights/catalog.ts';
import { ApiError, api } from './api.ts';
import { AssistantPriorities } from './assistant-priorities.tsx';
import { Icon } from './icons.tsx';
import './assistant.css';
import { formatDateTime } from './format.ts';
import { ErrorBox } from './pages.tsx';
import { ToneIcon } from './ui.tsx';

// Asistente de IA (F4). Todo lo que muestra sale de la respuesta estructurada y verificada del
// servidor; el texto del modelo se pinta como texto (React lo escapa), nunca como HTML ni con
// enlaces o imágenes que pudieran exfiltrar datos.

const USERS: Role[] = ['owner', 'admin', 'manager', 'analyst'];

const STATUS: Record<NonNullable<AiMessage['status']>, { label: string; tone: Tone }> = {
  answered: { label: 'Cifras y citas verificadas', tone: 'good' },
  unverified: { label: 'Contiene cifras o citas sin verificar', tone: 'warning' },
  refused: { label: 'El modelo rechazó la petición', tone: 'critical' },
  budget_exhausted: { label: 'Presupuesto de IA agotado', tone: 'warning' },
  incomplete: { label: 'Sin respuesta final: se alcanzó un límite', tone: 'warning' },
  failed: { label: 'El proveedor de IA no respondió', tone: 'critical' },
};
const SUFFICIENCY = {
  sufficient: { label: 'Datos suficientes', tone: 'good' },
  limited: { label: 'Datos limitados', tone: 'warning' },
  insufficient: { label: 'Datos insuficientes', tone: 'critical' },
} as const;
const LEVEL3 = { low: 'baja', medium: 'media', high: 'alta' } as const;
const RISK = { low: 'bajo', medium: 'medio', high: 'alto' } as const;
const ACTION: Record<Recommendation['actionType'], string> = {
  pause: 'Pausar',
  activate: 'Activar',
  set_daily_budget: 'Cambiar el presupuesto diario',
  set_lifetime_budget: 'Cambiar el presupuesto total',
  review: 'Revisar',
};
const DIRECTION = { increase: 'subir', decrease: 'bajar', stabilize: 'estabilizarse' } as const;
const TOOL: Record<string, string> = {
  get_scope: 'Alcance',
  get_metrics: 'Métricas',
  decompose_change: 'Descomposición del cambio',
  get_findings: 'Hallazgos',
  get_health: 'Salud',
};
const ENTITY = {
  account: 'cuenta',
  campaign: 'campaña',
  adset: 'conjunto',
  ad: 'anuncio',
} as const;

const usd = (v: number) =>
  `${v.toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })} USD`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const metricLabel = (id: string) =>
  id in METRICS ? METRICS[id as keyof typeof METRICS].label : id;

export function AssistantPage({ role }: { role: Role }) {
  const queryClient = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const conversationId = sp.get('c');
  const rawLevel = sp.get('nivel');
  const viewLevel = ['org', 'client', 'account', 'campaign', 'adset', 'ad'].includes(rawLevel ?? '')
    ? (rawLevel as NodeLevel)
    : null;
  const view = viewLevel ? { level: viewLevel, id: sp.get('id') } : null;
  const [question, setQuestion] = useState('');
  const inputId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api<AiStatus>('/v1/ai/status'),
    enabled: USERS.includes(role),
  });
  const list = useQuery({
    queryKey: ['ai-conversations'],
    queryFn: () => api<AiConversation[]>('/v1/ai/conversations'),
    enabled: USERS.includes(role),
  });
  const detail = useQuery({
    queryKey: ['ai-conversation', conversationId],
    queryFn: () => api<AiConversationDetail>(`/v1/ai/conversations/${conversationId}`),
    enabled: conversationId !== null && USERS.includes(role),
  });
  const ask = useMutation({
    mutationFn: (q: string) =>
      api<AiTurn>('/v1/ai/ask', { method: 'POST', body: { conversationId, question: q, view } }),
    onSuccess: (turn) => {
      setQuestion('');
      setSp((prev) => {
        const next = new URLSearchParams(prev);
        next.set('c', turn.conversationId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['ai-conversation', turn.conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-status'] });
    },
  });
  if (!USERS.includes(role))
    return <p className="text-sm">Tu rol no permite usar el asistente de IA.</p>;
  const canSend = status.data?.enabled === true && !ask.isPending;
  const admin = role === 'owner' || role === 'admin';
  const send = () => {
    const q = question.trim();
    if (q.length >= 3 && canSend) ask.mutate(q);
  };
  const prepare = (text: string, finding?: Finding) => {
    if (ask.isPending) return;
    setQuestion(text);
    ask.reset();
    if (finding)
      setSp((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('c');
        next.set('nivel', finding.entityLevel);
        next.set(
          'id',
          finding.entityLevel === 'account' ? finding.adAccountId : finding.entityMetaId,
        );
        return next;
      });
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({
      block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  };
  const budgets = status.data?.budgets;
  const newUrl = view
    ? `/asistente?nivel=${view.level}${view.id ? `&id=${encodeURIComponent(view.id)}` : ''}`
    : '/asistente';

  return (
    <div className="assistant-workspace">
      <header className="assistant-page-header">
        <div>
          <h1>Asistente de IA</h1>
          <p>Encuentra qué revisar primero. Entiende la evidencia antes de decidir.</p>
        </div>
        <span
          className={`assistant-availability ${status.data?.enabled ? 'is-ready' : ''}`}
          role="status"
        >
          <Icon name={status.data?.enabled ? 'assistant' : 'lock'} size={15} />
          {status.isPending
            ? 'Comprobando disponibilidad'
            : status.error
              ? 'Estado no disponible'
              : status.data?.enabled
                ? 'Listo para consultar'
                : status.data?.configured
                  ? 'Consultas en pausa'
                  : 'IA pendiente de configurar'}
        </span>
      </header>
      {status.data && !status.data.enabled && (
        <div className="assistant-availability-note">
          <Icon name="lock" size={19} />
          <div>
            <strong>
              {status.data.configured
                ? 'Puedes seguir revisando tus campañas.'
                : 'Empieza por los hallazgos de tu cartera.'}
            </strong>
            <p>
              {status.data.configured
                ? 'La IA está en pausa. Puedes abrir las prioridades y revisar sus evidencias.'
                : 'La IA todavía no está configurada. La guía y los hallazgos disponibles te ayudan a preparar la siguiente revisión.'}
            </p>
          </div>
          {admin && (
            <Link to="/operaciones" className="assistant-text-link">
              Revisar estado <Icon name="arrow" size={15} />
            </Link>
          )}
        </div>
      )}
      {status.error && (
        <div className="assistant-status-error">
          <ErrorBox error={status.error} />
          <button type="button" onClick={() => void status.refetch()}>
            Comprobar de nuevo
          </button>
        </div>
      )}
      <div className="assistant-layout">
        <div className="assistant-main">
          {detail.error && <ErrorBox error={detail.error} />}
          {conversationId && detail.isPending && (
            <p className="assistant-loading" role="status">
              Cargando conversación…
            </p>
          )}
          {!!detail.data?.messages.length && (
            <ol className="assistant-transcript" aria-label="Mensajes de la conversación">
              {detail.data.messages.map((m) =>
                m.role === 'user' ? (
                  <li key={m.id} className="assistant-user-message">
                    <span className="assistant-message-label">Tu pregunta</span>
                    <p>{m.content}</p>
                  </li>
                ) : (
                  <li key={m.id}>
                    <AnswerCard
                      message={m}
                      onFollowUp={prepare}
                      canPropose={USERS.includes(role)}
                    />
                  </li>
                ),
              )}
            </ol>
          )}
          {ask.isPending && (
            <div className="assistant-pending" role="status">
              <Icon name="assistant" size={19} />
              <div>
                <strong>Consultando datos y verificando la respuesta</strong>
                <p>El análisis citará su evidencia y señalará las limitaciones.</p>
              </div>
            </div>
          )}
          {ask.error && <ErrorBox error={ask.error} />}
          {!conversationId && (
            <AssistantPriorities
              busy={ask.isPending}
              onPrepare={prepare}
              accountId={viewLevel === 'account' ? (view?.id ?? null) : null}
            />
          )}
          <section className="assistant-composer" aria-labelledby="composer-heading">
            <div className="assistant-composer-heading">
              <span className="assistant-symbol">
                <Icon name="assistant" size={23} />
              </span>
              <div>
                <h2 id="composer-heading">
                  {conversationId
                    ? 'Continúa el análisis'
                    : '¿Qué quieres entender de tus campañas?'}
                </h2>
                <p>
                  Pregunta por un cambio, contrasta una hipótesis o prepara tu próxima revisión.
                </p>
              </div>
            </div>
            {view && (
              <p className="assistant-context">
                Contexto de revisión:{' '}
                {ENTITY[view.level as keyof typeof ENTITY] ??
                  (view.level === 'client' ? 'cliente' : 'cartera')}{' '}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <label htmlFor={inputId} className="sr-only">
                Pregunta para el asistente
              </label>
              <textarea
                ref={input}
                id={inputId}
                value={question}
                maxLength={2000}
                disabled={ask.isPending}
                rows={3}
                placeholder="Por ejemplo: ¿qué cambió en el costo por lead y qué debería revisar?"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
                aria-describedby={`${inputId}-help`}
              />
              <div className="assistant-composer-footer">
                <span id={`${inputId}-help`}>
                  {status.data?.enabled
                    ? 'Ctrl + Enter para enviar'
                    : 'Puedes preparar tu pregunta mientras se habilitan las consultas.'}
                </span>
                <button
                  className="assistant-send"
                  type="submit"
                  disabled={!canSend || question.trim().length < 3}
                >
                  Consultar <Icon name="arrow" size={16} />
                </button>
              </div>
            </form>
            {!conversationId && (
              <fieldset className="assistant-prompts" aria-label="Preguntas sugeridas">
                <button
                  type="button"
                  disabled={ask.isPending}
                  onClick={() =>
                    prepare(
                      'Resume el rendimiento del último periodo frente al anterior. Separa monedas y objetivos y señala los límites de los datos.',
                    )
                  }
                >
                  Resumen de rendimiento
                </button>
                <button
                  type="button"
                  disabled={ask.isPending}
                  onClick={() =>
                    prepare(
                      '¿Qué componentes coinciden con el cambio del costo por resultado? Usa la descomposición disponible y plantea hipótesis, sin atribuir causalidad.',
                    )
                  }
                >
                  Cambios de costo
                </button>
                <button
                  type="button"
                  disabled={ask.isPending}
                  onClick={() =>
                    prepare(
                      '¿Qué hallazgos debería revisar primero? Explica la prioridad, la evidencia y qué debo comprobar antes de decidir.',
                    )
                  }
                >
                  Próxima revisión
                </button>
              </fieldset>
            )}
            <p className="assistant-composer-trust">
              <Icon name="lock" size={12} />
              Solo consulta datos autorizados. Las recomendaciones requieren tu revisión.
            </p>
          </section>
        </div>
        <aside className="assistant-side" aria-label="Conversaciones y detalles del asistente">
          <section className="assistant-history" aria-labelledby="conversaciones">
            <div className="assistant-side-heading">
              <h2 id="conversaciones">Conversaciones</h2>
              <Link
                to={newUrl}
                onClick={(e) => {
                  if (ask.isPending) {
                    e.preventDefault();
                    return;
                  }
                  setQuestion('');
                  ask.reset();
                }}
                aria-label="Nueva conversación"
              >
                Nueva <span aria-hidden="true">+</span>
              </Link>
            </div>
            {list.isPending && <p className="assistant-side-copy">Cargando conversaciones…</p>}
            {list.error && (
              <p className="assistant-side-copy" role="alert">
                No pudimos cargar el historial.{' '}
                <button type="button" onClick={() => void list.refetch()}>
                  Reintentar
                </button>
              </p>
            )}
            {list.data?.length === 0 && (
              <div className="assistant-history-empty">
                <Icon name="assistant" size={24} />
                <strong>Tu análisis, en un solo lugar</strong>
                <p>Las consultas que envíes aparecerán aquí para que puedas retomarlas.</p>
              </div>
            )}
            {!!list.data?.length && (
              <ul>
                {list.data.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/asistente?c=${c.id}`}
                      aria-current={c.id === conversationId ? 'page' : undefined}
                    >
                      <span>{c.title}</span>
                      <time dateTime={c.updatedAt}>{formatDateTime(c.updatedAt)}</time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="assistant-review-help">
            <Icon name="action" size={22} />
            <h2>De la señal a la decisión</h2>
            <p>
              Revisa la evidencia, confirma su vigencia y registra tu decisión. Una recomendación no
              ejecuta cambios en Meta.
            </p>
            <Link to="/acciones" className="assistant-text-link">
              Abrir Action Center <Icon name="arrow" size={15} />
            </Link>
          </section>
          {status.data && (
            <details className="assistant-service">
              <summary>
                Modelo y presupuesto <Icon name="down" size={14} />
              </summary>
              <div>
                <p>
                  {status.data.provider === 'nvidia' ? 'NVIDIA NIM' : 'Anthropic'} ·{' '}
                  {status.data.configured ? 'Configurado' : 'Sin clave'}
                </p>
                <p className="assistant-model">{status.data.model}</p>
                {budgets && (
                  <dl>
                    <div>
                      <dt>Organización, este mes</dt>
                      <dd>
                        {usd(budgets.spentMonthUsd)} / {usd(budgets.monthlyUsd)}
                      </dd>
                    </div>
                    <div>
                      <dt>Tu uso hoy</dt>
                      <dd>
                        {usd(budgets.spentTodayUsd)} / {usd(budgets.userDailyUsd)}
                      </dd>
                    </div>
                    <div>
                      <dt>Límite por pregunta</dt>
                      <dd>{usd(budgets.perQuestionUsd)}</dd>
                    </div>
                  </dl>
                )}
                {status.data.costBasis === 'budget_estimate' && (
                  <p>
                    Valoración interna para controlar el presupuesto. No representa cargos ni una
                    tarifa de NVIDIA.
                  </p>
                )}
                {status.data.unavailableReason && (
                  <p>Estado técnico: {status.data.unavailableReason}</p>
                )}
              </div>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <ToneIcon tone={tone} />
      {children}
    </span>
  );
}

function Evidence({ ids, message }: { ids: string[]; message: AiMessage }) {
  if (!ids.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const e = message.evidence.find((x) => x.evidenceId === id);
        return (
          <span
            key={id}
            title={
              e
                ? `${TOOL[e.tool] ?? e.tool} · ${SUFFICIENCY[e.sufficiency ?? 'insufficient'].label}`
                : 'Evidencia no encontrada'
            }
            className="rounded border border-gray-300 px-1 font-mono text-xs dark:border-gray-700"
          >
            {id}
          </span>
        );
      })}
    </span>
  );
}

function AnswerCard({
  message,
  onFollowUp,
  canPropose,
}: {
  message: AiMessage;
  onFollowUp: (q: string) => void;
  canPropose: boolean;
}) {
  const s = message.status ? STATUS[message.status] : null;
  const a = message.answer;
  const issues = message.verification?.issues ?? [];
  const flagged = (prefix: string) =>
    issues.some((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));

  return (
    <article className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {s && <Badge tone={s.tone}>{s.label}</Badge>}
        {a && (
          <Badge tone={SUFFICIENCY[a.dataSufficiency.status].tone}>
            {SUFFICIENCY[a.dataSufficiency.status].label}
          </Badge>
        )}
      </div>
      {!a && (
        <p className="text-sm">
          {message.status === 'budget_exhausted'
            ? 'No quedaba presupuesto para completar la respuesta.'
            : 'No hay respuesta para esta pregunta. Puedes reformularla o acotarla.'}
        </p>
      )}
      {a && (
        <>
          {a.dataSufficiency.reasons.length > 0 && (
            <ul className="list-inside list-disc text-sm text-gray-600 dark:text-gray-400">
              {a.dataSufficiency.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className={flagged('summary') ? 'underline decoration-dotted' : ''}>{a.summary}</p>

          {a.claims.length > 0 && (
            <section aria-label="Lo que muestran los datos" className="space-y-1">
              <h3 className="text-sm font-semibold">Lo que muestran los datos</h3>
              <ul className="space-y-1 text-sm">
                {a.claims.map((c, i) => (
                  <li key={c.text}>
                    {c.text}
                    <Evidence ids={c.evidenceIds} message={message} />
                    {flagged(`claims.${i}`) && <Unverified />}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {a.hypotheses.length > 0 && (
            <section aria-label="Hipótesis" className="space-y-1">
              <h3 className="text-sm font-semibold">Hipótesis</h3>
              <ul className="space-y-1 text-sm">
                {a.hypotheses.map((h, i) => (
                  <li key={h.text}>
                    {h.text}{' '}
                    <span className="text-gray-500">(confianza {LEVEL3[h.confidence]})</span>
                    <Evidence ids={h.evidenceIds} message={message} />
                    {flagged(`hypotheses.${i}`) && <Unverified />}
                    <div className="text-gray-500">Cómo comprobarlo: {h.howToVerify}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {a.recommendations.length > 0 && (
            <section aria-label="Recomendaciones" className="space-y-2">
              <h3 className="text-sm font-semibold">Recomendaciones, por prioridad</h3>
              {a.recommendations.map((r, i) => (
                <RecommendationCard
                  key={r.title}
                  rec={r}
                  index={i}
                  message={message}
                  verified={!flagged(`recommendations.${i}`)}
                  canPropose={canPropose}
                />
              ))}
            </section>
          )}

          {a.followUpQuestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {a.followUpQuestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="rounded-full border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
                  onClick={() => onFollowUp(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer text-gray-500">
          Evidencia y verificación (
          {plural(message.evidence.filter((e) => e.evidenceId).length, 'consulta', 'consultas')}
          {message.verification
            ? `, ${message.verification.figures.verified}/${message.verification.figures.checked} cifras verificadas`
            : ''}
          )
        </summary>
        <ul className="mt-2 space-y-1">
          {message.evidence.map((e) => (
            <li key={e.toolUseId} className="font-mono text-xs">
              {e.evidenceId ?? '—'} · {TOOL[e.tool] ?? e.tool} ·{' '}
              {e.status === 'ok'
                ? SUFFICIENCY[e.sufficiency ?? 'insufficient'].label
                : `error: ${e.error?.message}`}{' '}
              · {e.ms} ms
            </li>
          ))}
        </ul>
        {issues.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-xs text-gray-600 dark:text-gray-400">
            {issues.map((i) => (
              <li key={`${i.path}-${i.message}`}>
                {i.path}: {i.message}
              </li>
            ))}
          </ul>
        )}
      </details>
      <p className="text-xs text-gray-500">
        {formatDateTime(message.createdAt)} · {message.model} · {message.promptVersion}
        {message.costUsd !== null && ` · presupuesto estimado ${usd(message.costUsd)}`}
        {message.injectionFlags > 0 &&
          ` · se retiraron ${message.injectionFlags} textos de terceros que parecían instrucciones`}
      </p>
    </article>
  );
}

function Unverified() {
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
      <ToneIcon tone="warning" />
      sin verificar
    </span>
  );
}

function RecommendationCard({
  rec,
  index,
  message,
  verified,
  canPropose,
}: {
  rec: AiAnswer['recommendations'][number];
  index: number;
  message: AiMessage;
  verified: boolean;
  canPropose: boolean;
}) {
  const propose = useMutation({
    mutationFn: () =>
      api<Recommendation>(`/v1/ai/messages/${message.id}/recommendations/${index}/propose`, {
        method: 'POST',
      }),
  });
  const already = propose.error instanceof ApiError && propose.error.status === 409;
  return (
    <div className="space-y-1 rounded border border-gray-200 p-3 text-sm dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <strong>{rec.title}</strong>
        <span className="text-gray-500">prioridad {Math.round(rec.priority * 100)} %</span>
        {!verified && <Unverified />}
      </div>
      <p>
        <span className="font-medium">Acción sugerida:</span> {ACTION[rec.action.type]} ·{' '}
        {ENTITY[rec.action.entityLevel]}{' '}
        <span className="font-mono text-xs">{rec.action.entityId}</span>
        {rec.action.amount !== null && ` (${rec.action.amount})`}. {rec.action.description}
      </p>
      <p>
        {rec.rationale}
        <Evidence ids={rec.evidenceIds} message={message} />
      </p>
      <p>
        <span className="font-medium">Impacto esperado (hipótesis):</span>{' '}
        {rec.expectedImpact.hypothesis} · {metricLabel(rec.expectedImpact.metric)} podría{' '}
        {DIRECTION[rec.expectedImpact.direction]}, magnitud {LEVEL3[rec.expectedImpact.magnitude]}.
      </p>
      <p>
        <span className="font-medium">Confianza {LEVEL3[rec.confidence.level]}:</span>{' '}
        {rec.confidence.rationale}
      </p>
      <p>
        <span className="font-medium">Riesgo {RISK[rec.risk.level]}:</span> {rec.risk.description}
      </p>
      {rec.dependencies.length > 0 && (
        <div>
          <span className="font-medium">Depende de:</span>
          <ul className="list-inside list-disc">
            {rec.dependencies.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {canPropose && (
        <div className="pt-1">
          {propose.isSuccess || already ? (
            <p role="status" className="text-gray-600 dark:text-gray-400">
              En la cola de recomendaciones, pendiente de aprobación.
            </p>
          ) : (
            <button
              type="button"
              disabled={!verified || propose.isPending}
              title={
                verified ? undefined : 'Solo se proponen recomendaciones con evidencia verificada'
              }
              className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50 dark:border-gray-700"
              onClick={() => propose.mutate()}
            >
              Proponer para aprobación
            </button>
          )}
          {propose.error && !already && <ErrorBox error={propose.error} />}
        </div>
      )}
    </div>
  );
}
