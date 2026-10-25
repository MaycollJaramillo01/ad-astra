import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  AiAnswer,
  AiConversation,
  AiConversationDetail,
  AiMessage,
  AiStatus,
  AiTurn,
  Recommendation,
} from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import { METRICS, type NodeLevel, type Tone } from '../../src/modules/insights/catalog.ts';
import { ApiError, api } from './api.ts';
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
  const viewLevel = sp.get('nivel') as NodeLevel | null;
  const view = viewLevel ? { level: viewLevel, id: sp.get('id') } : null;
  const [question, setQuestion] = useState('');
  const inputId = useId();

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

  const send = () => {
    const q = question.trim();
    if (q.length >= 3 && !ask.isPending) ask.mutate(q);
  };
  const budgets = status.data?.budgets;

  return (
    <div className="grid gap-5 md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside aria-labelledby="conversaciones" className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 id="conversaciones" className="text-sm font-semibold">
            Conversaciones
          </h2>
          <Link
            className="text-sm underline"
            to={
              view
                ? `/asistente?nivel=${view.level}${view.id ? `&id=${view.id}` : ''}`
                : '/asistente'
            }
          >
            Nueva
          </Link>
        </div>
        <ul className="space-y-1 text-sm">
          {list.data?.map((c) => (
            <li key={c.id}>
              <Link
                to={`/asistente?c=${c.id}`}
                aria-current={c.id === conversationId ? 'page' : undefined}
                className={`block truncate rounded px-2 py-1 ${c.id === conversationId ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-900'}`}
              >
                {c.title}
              </Link>
            </li>
          ))}
          {list.data?.length === 0 && <li className="text-gray-500">Aún no hay conversaciones.</li>}
        </ul>
      </aside>

      <section aria-labelledby="asistente" className="min-w-0 space-y-4">
        <header className="space-y-1">
          <h1 id="asistente" className="text-xl font-semibold">
            Asistente de IA
          </h1>
          <p className="text-sm text-gray-500">
            Responde con los datos sincronizados y los hallazgos de la auditoría. Solo consulta: no
            modifica campañas; sus recomendaciones pasan por aprobación.
            {view &&
              ` Contexto: ${ENTITY[view.level as keyof typeof ENTITY] ?? view.level}${view.id ? ` ${view.id}` : ''}.`}
          </p>
          {budgets && (
            <p className="text-xs text-gray-500">
              Gasto de IA este mes: {usd(budgets.spentMonthUsd)} de {usd(budgets.monthlyUsd)} · tuyo
              hoy: {usd(budgets.spentTodayUsd)} de {usd(budgets.userDailyUsd)} · modelo{' '}
              {status.data?.model}
            </p>
          )}
        </header>

        {status.data && !status.data.enabled && (
          <p
            role="status"
            className="rounded border border-gray-300 p-3 text-sm dark:border-gray-700"
          >
            El asistente no está configurado en este entorno (falta la clave del proveedor de IA).
          </p>
        )}
        {detail.error && <ErrorBox error={detail.error} />}

        <ol className="space-y-4">
          {detail.data?.messages.map((m) =>
            m.role === 'user' ? (
              <li
                key={m.id}
                className="ml-auto max-w-prose rounded-lg bg-gray-100 px-3 py-2 text-sm dark:bg-gray-800"
              >
                <span className="sr-only">Tu pregunta: </span>
                {m.content}
              </li>
            ) : (
              <li key={m.id}>
                <AnswerCard
                  message={m}
                  onFollowUp={setQuestion}
                  canPropose={USERS.includes(role)}
                />
              </li>
            ),
          )}
          {ask.isPending && (
            <li className="ml-auto max-w-prose rounded-lg bg-gray-100 px-3 py-2 text-sm dark:bg-gray-800">
              {ask.variables}
            </li>
          )}
        </ol>
        <p aria-live="polite" className="text-sm text-gray-500">
          {ask.isPending
            ? 'Analizando: consulta los datos y verifica cada cifra antes de responder…'
            : ''}
        </p>
        {ask.error && <ErrorBox error={ask.error} />}

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor={inputId} className="block text-sm font-medium">
            Pregunta
          </label>
          <textarea
            id={inputId}
            value={question}
            maxLength={2000}
            rows={3}
            disabled={status.data?.enabled === false}
            placeholder="P. ej.: ¿por qué subió el costo por resultado esta semana?"
            className="w-full rounded border border-gray-300 bg-transparent p-2 text-sm dark:border-gray-700"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
            }}
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={
                ask.isPending || question.trim().length < 3 || status.data?.enabled === false
              }
              className="rounded bg-gray-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              Preguntar
            </button>
            <span className="text-xs text-gray-500">Ctrl + Enter para enviar</span>
          </div>
        </form>
      </section>
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
        {message.costUsd !== null && ` · costo ${usd(message.costUsd)}`}
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
