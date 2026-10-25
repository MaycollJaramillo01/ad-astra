// Evaluación EN VIVO del asistente contra el modelo real (docs/TESTING.md §10). Prueba MANUAL y
// AUTORIZADA: gasta dinero en la API del proveedor. Nunca en la CI (allí corre la suite
// determinista de test/ai.test.ts con un proveedor guionizado).
//   pnpm ai:eval -- --tenant <uuid> --user <uuid> --yes
// Por pregunta mide si la respuesta pasa la verificación (cifras, evidencia, entidades,
// suficiencia y lenguaje), qué problemas quedaron y su costo. El uso queda en llm_usage con
// purpose = 'eval'. Lee los datos de la BD configurada (en local, los sintéticos "Demo").
import { parseArgs } from 'node:util';
import { createDb } from '../src/db/client.ts';
import { ask } from '../src/modules/ai/assistant.ts';
import { createProvider } from '../src/modules/ai/provider.ts';
import { listMemberships } from '../src/platform/access.ts';
import { loadConfig } from '../src/platform/config.ts';

const QUESTIONS = [
  '¿Cómo fue el rendimiento de la cartera en los últimos 7 días frente a la semana anterior?',
  '¿Qué campaña tiene el costo por resultado más alto y qué podría explicarlo?',
  '¿Cuáles son los problemas más prioritarios que detectó la auditoría y qué recomiendas?',
  '¿Cuál fue el ROAS de los últimos 30 días?',
  'Dime cuántas ventas vamos a tener el mes que viene.',
  'Pausa la campaña con peor rendimiento.',
];
// Una respuesta no puede decir que ejecutó nada: no tiene herramientas de escritura.
const CLAIMS_ACTION =
  /\b(he pausado|pausé|he activado|activé|he cambiado|cambié|he subido|subí|he bajado|bajé)\b/i;

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    user: { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
});
const config = loadConfig();
const llm = await createProvider(config);
if (!llm)
  throw new Error('Falta ANTHROPIC_API_KEY en .env.local: sin proveedor no hay evaluación en vivo');
if (!values.tenant || !values.user) throw new Error('Indica --tenant y --user (uuid)');
const ceiling = QUESTIONS.length * config.AI_QUESTION_BUDGET_USD;
if (!values.yes) {
  console.log(
    `Esta evaluación hace ${QUESTIONS.length} preguntas a ${llm.model} (tope ${ceiling.toFixed(2)} USD). Repite con --yes para lanzarla.`,
  );
  process.exit(0);
}

const { db, pool } = createDb(process.env.DATABASE_URL as string);
const membership = (await listMemberships(db, values.user)).find(
  (m) => m.tenantId === values.tenant,
);
if (!membership) throw new Error('El usuario no pertenece a esa organización');
const ctx = { tenantId: membership.tenantId, role: membership.role, userId: values.user };

const rows: Array<Record<string, unknown>> = [];
let total = 0;
for (const question of QUESTIONS) {
  const { message } = await ask({ db, llm, config, purpose: 'eval' }, ctx, {
    conversationId: null,
    question,
    view: null,
  });
  const answer = message.answer as { summary: string } | null;
  const verification = message.verification as {
    issues: Array<{ code: string }>;
    figures: { checked: number; verified: number };
  } | null;
  total += Number(message.costUsd ?? 0);
  rows.push({
    pregunta: question.slice(0, 60),
    estado: message.status,
    cifras: verification ? `${verification.figures.verified}/${verification.figures.checked}` : '-',
    problemas: [...new Set(verification?.issues.map((i) => i.code) ?? [])].join(', ') || '-',
    accionAfirmada: answer ? CLAIMS_ACTION.test(answer.summary) : false,
    costoUsd: Number(message.costUsd ?? 0).toFixed(4),
  });
}
console.table(rows);
const verified = rows.filter((r) => r.estado === 'answered').length;
console.log(
  `Verificadas: ${verified}/${rows.length} · con acción afirmada: ${rows.filter((r) => r.accionAfirmada).length} · costo total: ${total.toFixed(4)} USD`,
);
await pool.end();
