import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Db, first, withContext } from '../../db/client.ts';
import {
  actionFollowups,
  adAccounts,
  monitoringDeliveries,
  monitoringIncidents,
} from '../../db/schema.ts';
import type { Config } from '../../platform/config.ts';
import type { JobHandler, JobOutcome } from '../../platform/jobs.ts';
import { assertSideEffects } from '../../platform/operations.ts';
import { localDate } from '../insights/catalog.ts';
import type { FollowupPlan } from './model.ts';
import { inQuietHours } from './model.ts';
import {
  authorizedMember,
  evaluateAccount,
  hasReadConsent,
  monitorEvent,
  policyFor,
} from './service.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}
export type EmailTransport = (message: EmailMessage, key: string) => Promise<string>;
export function createEmailTransport(
  config: Config,
  fetcher: typeof fetch = fetch,
): EmailTransport {
  return async (message, key) => {
    if (!config.NOTIFICATIONS_EMAIL_ENABLED || !config.RESEND_API_KEY || !config.NOTIFICATIONS_FROM)
      throw new Error('Correo deshabilitado o sin proveedor configurado.');
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ from: config.NOTIFICATIONS_FROM, ...message }),
    });
    if (!response.ok)
      throw new Error(`Proveedor de correo rechazó la solicitud (${response.status}).`);
    const data = (await response.json()) as { id?: unknown };
    if (typeof data.id !== 'string') throw new Error('Respuesta de correo sin identificador.');
    return data.id;
  };
}
export function createMonitoringHandlers(
  db: Db,
  config: Config,
  email: EmailTransport = createEmailTransport(config),
): Record<string, JobHandler> {
  return {
    monitor_followup: async (job) => {
      const payload = job.payload as { actionId?: string; adAccountId?: string };
      if (!payload.actionId || !payload.adAccountId)
        return { type: 'stop', error: 'Faltan identificadores de seguimiento' };
      await evaluateAccount(db, job.tenantId, payload.adAccountId);
      const stop = await withContext(db, { tenantId: job.tenantId }, async (tx) => {
        const [row] = await tx
          .select()
          .from(actionFollowups)
          .where(eq(actionFollowups.actionId, payload.actionId ?? ''));
        if (!row) return true;
        const plan = row.plan as FollowupPlan;
        // Revisiones posteriores durante 28 días tras maduración; luego sigue disponible manualmente.
        return Date.now() > Date.parse(plan.afterUntil) + (plan.maturityDays + 29) * 86400000;
      });
      return stop
        ? {
            type: 'end',
            reason: 'Seguimiento automático finalizado; conservar snapshot y revisión manual.',
          }
        : { type: 'done' };
    },
    monitor_evaluate: async (job) => {
      const id = (job.payload as { adAccountId?: string }).adAccountId;
      if (!id) return { type: 'stop', error: 'Falta adAccountId' };
      const result = await evaluateAccount(db, job.tenantId, id);
      const current = await withContext(db, { tenantId: job.tenantId }, (tx) => policyFor(tx, id));
      return result?.enabled &&
        job.dedupeKey === `monitor:${job.tenantId}:${id}:${current.revision}`
        ? { type: 'done' }
        : {
            type: 'end',
            reason: 'Cuenta inexistente, monitoreo deshabilitado o consentimiento no vigente.',
          };
    },
    monitor_notify: async (job) => {
      const id = (job.payload as { deliveryId?: string }).deliveryId;
      if (!id) return { type: 'stop', error: 'Falta deliveryId' };
      const ctx = { tenantId: job.tenantId },
        reschedule = (reason: string): JobOutcome => ({
          type: 'reschedule',
          runAfter: new Date(Date.now() + 900000),
          reason,
        });
      // El advisory lock cubre el I/O. La reserva y el payload se confirman antes del envío.
      return withContext(db, ctx, async (lockTx) => {
        const { rows } = await lockTx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`notification:${job.tenantId}:${id}`},0)) as locked`,
        );
        if (!rows[0]?.locked) return reschedule('Entrega en curso.');
        const prepared = await withContext(db, ctx, async (tx) => {
          const [d] = await tx
            .select()
            .from(monitoringDeliveries)
            .where(eq(monitoringDeliveries.id, id))
            .for('update');
          if (!d || !['queued', 'sending'].includes(d.status))
            return { outcome: { type: 'done' } as JobOutcome };
          const finish = async (status: 'cancelled' | 'unknown', reason: string) => {
            await tx
              .update(monitoringDeliveries)
              .set({ status, error: reason, updatedAt: new Date() })
              .where(eq(monitoringDeliveries.id, id));
            await monitorEvent(tx, job.tenantId, d.adAccountId, `notification_${status}`, {
              deliveryId: id,
              reason,
            });
            return { outcome: { type: 'end', reason } as JobOutcome };
          };
          if (d.status === 'sending')
            return finish(
              'unknown',
              'Envío reservado sin confirmación. Revisar el proveedor; no se repite automáticamente.',
            );
          const p = await policyFor(tx, d.adAccountId),
            [account] = await tx.select().from(adAccounts).where(eq(adAccounts.id, d.adAccountId));
          if (
            !account ||
            !p.config.enabled ||
            p.revision !== d.policyRevision ||
            !p.authorizedBy ||
            !p.config.notifications.recipientIds.includes(d.userId) ||
            !(d.channel === 'in_app'
              ? p.config.notifications.inApp
              : p.config.notifications.email) ||
            !(await authorizedMember(
              tx,
              job.tenantId,
              d.adAccountId,
              p.authorizedBy,
              'monitoring:configure',
            )) ||
            !(await hasReadConsent(tx, account))
          )
            return finish('cancelled', 'Autorización, política o consentimiento ya no vigentes.');
          const member = await authorizedMember(tx, job.tenantId, d.adAccountId, d.userId);
          if (!member || (d.channel === 'email' && !member.verified))
            return finish('cancelled', 'El destinatario ya no tiene acceso o correo verificado.');
          const now = new Date(),
            hour = Number(
              new Intl.DateTimeFormat('en-GB', {
                timeZone: account.timezoneName,
                hour: '2-digit',
                hourCycle: 'h23',
              }).format(now),
            ),
            n = p.config.notifications;
          if (inQuietHours(hour, n.quietStart, n.quietEnd))
            return { outcome: reschedule('Horario silencioso.') };
          if (
            d.channel === 'email' &&
            (!config.NOTIFICATIONS_EMAIL_ENABLED ||
              !config.RESEND_API_KEY ||
              !config.NOTIFICATIONS_FROM)
          )
            return finish(
              'cancelled',
              'Correo bloqueado por configuración global; el resumen sigue disponible en la aplicación.',
            );
          if (localDate(account.timezoneName, d.createdAt) !== localDate(account.timezoneName, now))
            return finish(
              'cancelled',
              'Resumen caducado; se evaluará uno nuevo con datos actuales.',
            );
          const incidents = await tx
            .select({ id: monitoringIncidents.id })
            .from(monitoringIncidents)
            .where(
              and(
                inArray(monitoringIncidents.id, d.incidentIds),
                inArray(monitoringIncidents.status, ['open', 'acknowledged']),
              ),
            );
          if (!incidents.length)
            return finish(
              'cancelled',
              'Los incidentes ya están resueltos, descartados o silenciados.',
            );
          const message: EmailMessage = {
            to: member.email,
            subject: 'Ad Astra · incidentes por revisar',
            text: `Hay ${incidents.length} incidentes por revisar en una cuenta autorizada. Abre Ad Astra con tu sesión: ${config.APP_ORIGIN}/monitoreo/${account.id}\nEste aviso no atribuye efectos causales ni autoriza cambios en Meta.`,
          };
          if (d.channel === 'email') {
            try {
              await assertSideEffects(tx, config, d.tenantId);
            } catch {
              return finish('cancelled', 'Efectos externos bloqueados por entorno o recuperación.');
            }
          }
          const saved = first(
            await tx
              .update(monitoringDeliveries)
              .set({
                status: d.channel === 'in_app' ? 'sent' : 'sending',
                payload: d.channel === 'email' ? message : { count: incidents.length },
                dispatchedAt: now,
                updatedAt: now,
              })
              .where(eq(monitoringDeliveries.id, id))
              .returning(),
          );
          await monitorEvent(
            tx,
            job.tenantId,
            d.adAccountId,
            d.channel === 'in_app' ? 'notification_sent' : 'notification_reserved',
            { deliveryId: id, channel: d.channel, count: incidents.length },
          );
          return { delivery: saved, message };
        });
        if (prepared.outcome) return prepared.outcome;
        if (prepared.delivery.channel === 'in_app') return { type: 'done' };
        try {
          const providerId = await email(prepared.message, `ad-astra/${id}`);
          await withContext(db, ctx, async (tx) => {
            await tx
              .update(monitoringDeliveries)
              .set({ status: 'sent', providerId, updatedAt: new Date() })
              .where(eq(monitoringDeliveries.id, id));
            await monitorEvent(
              tx,
              job.tenantId,
              prepared.delivery.adAccountId,
              'notification_sent',
              { deliveryId: id, providerId },
            );
          });
        } catch {
          await withContext(db, ctx, async (tx) => {
            await tx
              .update(monitoringDeliveries)
              .set({
                status: 'unknown',
                error: 'Sin confirmación del proveedor; comprobar manualmente antes de reenviar.',
                updatedAt: new Date(),
              })
              .where(eq(monitoringDeliveries.id, id));
            await monitorEvent(
              tx,
              job.tenantId,
              prepared.delivery.adAccountId,
              'notification_unknown',
              { deliveryId: id },
            );
          });
        }
        return { type: 'done' };
      });
    },
  };
}
