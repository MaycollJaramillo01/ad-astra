import { and, eq, sql } from 'drizzle-orm';
import type { Preview, Snapshot } from '../../action-contracts.ts';
import { first, withContext } from '../../db/client.ts';
import { actions, adAccounts, memberships, recommendations } from '../../db/schema.ts';
import { conflict, forbidden } from '../../platform/errors.ts';
import { recordEvent } from '../../platform/events.ts';
import type { JobHandler, JobOutcome } from '../../platform/jobs.ts';
import { can } from '../../platform/rbac.ts';
import { findAccount } from '../catalog/accounts.ts';
import { MetaApiError } from '../meta/client.ts';
import { ThrottledError } from '../meta/governor.ts';
import { captureBeforeAction } from '../monitoring/service.ts';
import type { ActionRow } from './meta.ts';
import { checkPolicy, configuration, hash, matches, previewOf, scheduledStatus } from './model.ts';
import {
  type ActionDeps,
  authorization,
  checkFrequency,
  ensurePreview,
  policyFor,
  previewOfRow,
  record,
  safeError,
  updateAction,
  validApprovalCount,
} from './service.ts';

/** No se promete exactly-once entre Postgres y Graph. El marcador COMMIT anterior al POST
 * impide repetir envíos ambiguos. Un reinicio solo puede leer y reconciliar ese marcador. */
export function createActionHandler(deps: ActionDeps): JobHandler {
  const { db, config, gateway } = deps;
  const inTenant = <T>(tenantId: string, fn: Parameters<typeof withContext<T>>[2]) =>
    withContext(db, { tenantId }, fn);
  const reschedule = (seconds: number, reason: string): JobOutcome => ({
    type: 'reschedule',
    runAfter: new Date(Date.now() + seconds * 1000),
    reason,
  });

  async function reconcile(a: ActionRow): Promise<JobOutcome> {
    const p = previewOfRow(a);
    if (!p) throw new Error('Acción enviada sin snapshot');
    let live: Snapshot | null = null,
      error: string | null = null;
    try {
      const auth = await inTenant(a.tenantId, (tx) => authorization(tx, a, config, true));
      live = await gateway.inspect(auth, a, true);
      if (!matches(live, p)) error = 'La relectura aún no coincide con el valor aprobado.';
    } catch (err) {
      error = safeError(err);
    }
    return inTenant(a.tenantId, async (tx) => {
      const current = first(
        await tx.select().from(actions).where(eq(actions.id, a.id)).for('update'),
      );
      if (current.state === 'closed') return { type: 'done' };
      const attempts = current.verificationAttempts + 1;
      if (live && !error) {
        const closed = await updateAction(tx, current, {
          state: 'closed',
          result: 'verified',
          after: live,
          error: null,
          verificationAttempts: attempts,
        });
        await record(tx, closed, 'verified', {
          before: p.snapshot,
          after: live,
          confirmedWrite: current.confirmedWrite,
          deliveryGuaranteed: false,
        });
        await record(tx, closed, 'closed', { result: 'verified' });
        if (closed.recommendationId)
          await tx
            .update(recommendations)
            .set({ status: 'applied' })
            .where(eq(recommendations.id, closed.recommendationId));
        return { type: 'done' };
      }
      const after = await updateAction(tx, current, {
        state: attempts >= 6 ? 'failed' : 'verifying',
        verificationAttempts: attempts,
        after: live ?? current.after,
        error: error ?? 'Resultado desconocido',
        result: attempts >= 6 ? 'unknown' : null,
      });
      await record(tx, after, attempts >= 6 ? 'verification_failed' : 'verification_pending', {
        attempts,
        error: after.error,
        after: live,
      });
      return attempts >= 6
        ? { type: 'end', reason: 'requiere reconciliación humana' }
        : reschedule(30, 'Esperar relectura de Meta; no reenviar.');
    });
  }

  return async (job) => {
    const id = (job.payload as { actionId?: string }).actionId;
    if (!id) return { type: 'stop', error: 'Falta actionId' };
    // Una conexión retiene el advisory lock durante todo el I/O; las otras transacciones
    // confirman los checkpoints antes de escribir. El lock usa la cuenta Meta, también si
    // dos tenants tienen autorizaciones para ella. Las llamadas tienen timeout de 30 s.
    return inTenant(job.tenantId, async (lockTx) => {
      const [initial] = await lockTx.select().from(actions).where(eq(actions.id, id));
      if (!initial) return { type: 'end', reason: 'acción inexistente' };
      const [account] = await lockTx
        .select()
        .from(adAccounts)
        .where(eq(adAccounts.id, initial.adAccountId));
      if (!account) return { type: 'end', reason: 'cuenta inexistente' };
      const { rows } = await lockTx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`action:${account.metaAccountId}`}, 0)) as locked`,
      );
      if (!rows[0]?.locked) return reschedule(30, 'Otra ejecución está usando esta cuenta.');
      const a = first(await lockTx.select().from(actions).where(eq(actions.id, id)));
      if (a.state === 'closed' || a.state === 'failed')
        return { type: 'end', reason: 'acción terminal' };
      if (a.dispatchAt) return reconcile(a);
      if (a.state !== 'approved') return { type: 'end', reason: 'acción no aprobada' };
      try {
        const prepare = async () =>
          inTenant(a.tenantId, async (tx) => {
            const current = first(
              await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
            );
            if (current.state !== 'approved' || current.dispatchAt)
              throw conflict('La acción ya no está aprobada para envío.');
            if (!config.META_WRITES_ENABLED)
              throw conflict('Interruptor global de escrituras desactivado.');
            const policy = await policyFor(tx, current.adAccountId),
              p = previewOfRow(current);
            ensurePreview(current, p, policy);
            const preview = p as Preview;
            const auth = await authorization(tx, current, config);
            checkPolicy(policy, current.operation, auth.account.timezoneName);
            const [proposer] = await tx
              .select()
              .from(memberships)
              .where(
                and(
                  eq(memberships.userId, current.proposedBy),
                  eq(memberships.tenantId, a.tenantId),
                ),
              );
            if (!proposer || !can(proposer.role, 'actions:propose'))
              throw forbidden('El proponente ya no tiene acceso.');
            await findAccount(
              tx,
              { tenantId: a.tenantId, userId: current.proposedBy, role: proposer.role },
              current.adAccountId,
            );
            if ((await validApprovalCount(tx, current, preview)) < preview.requiredApprovals)
              throw forbidden('El quorum de aprobaciones ya no es válido.');
            await checkFrequency(tx, current, preview, policy);
            return { current, preview, auth, policy };
          });
        const prepared = await prepare();
        const live = await gateway.inspect(prepared.auth, a);
        if (hash(configuration(live)) !== hash(configuration(prepared.preview.snapshot))) {
          // Un cambio externo que coincide con la intención no se atribuye a nuestro POST.
          const expected = {
            ...prepared.preview.snapshot,
            [prepared.preview.field === 'status'
              ? 'status'
              : prepared.preview.field === 'daily_budget'
                ? 'dailyBudget'
                : prepared.preview.field === 'lifetime_budget'
                  ? 'lifetimeBudget'
                  : 'weeklySchedule']: prepared.preview.after,
            ...(prepared.preview.field === 'adset_schedule'
              ? { pacing: [prepared.preview.after === '[]' ? 'standard' : 'day_parting'] }
              : {}),
          };
          if (hash(configuration(live)) === hash(configuration(expected))) {
            await inTenant(a.tenantId, async (tx) => {
              const current = first(
                await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
              );
              if (current.state !== 'approved')
                throw conflict('La acción se cerró durante la inspección.');
              const closed = await updateAction(tx, current, {
                state: 'closed',
                result: 'already_current',
                after: live,
              });
              await record(tx, closed, 'closed', {
                result: 'already_current',
                after: live,
                wrote: false,
              });
            });
            return { type: 'done' };
          }
          throw conflict(
            'La configuración actual cambió: nueva revisión y aprobación obligatorias.',
          );
        }
        // Revalidar la forma y los límites contra el estado vivo antes de reservar el envío.
        previewOf(live, a.operation, a.desired, a.entityLevel, prepared.policy);
        await gateway.beforeWrite(prepared.auth);
        const final = await prepare();
        if (
          final.auth.connection.id !== prepared.auth.connection.id ||
          final.auth.connection.tokenFingerprint !== prepared.auth.connection.tokenFingerprint
        )
          throw conflict('La conexión cambió durante la revisión.');
        const dispatched = await inTenant(a.tenantId, async (tx) => {
          const current = first(
            await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
          );
          if (current.state !== 'approved' || current.revision !== final.current.revision)
            throw conflict('La acción cambió antes de enviar.');
          const policy = await policyFor(tx, a.adAccountId);
          if (hash(policy) !== final.preview.policyHash || !policy.enabled)
            throw conflict('La política cambió antes de enviar.');
          await authorization(tx, current, config);
          checkPolicy(policy, current.operation, final.auth.account.timezoneName);
          if (
            (await validApprovalCount(tx, current, final.preview)) < final.preview.requiredApprovals
          )
            throw forbidden('Se retiró una aprobación antes del envío.');
          const next = await updateAction(tx, current, {
            state: 'executing',
            dispatchAt: new Date(),
            reservedAt: new Date(),
            error: null,
          });
          await captureBeforeAction(tx, current, final.auth.account);
          await record(tx, next, 'dispatch', {
            previewHash: final.preview.hash,
            before: live,
            field: final.preview.field,
            value: final.preview.after,
          });
          return next;
        });
        try {
          await gateway.write(final.auth, dispatched, final.preview);
          await inTenant(a.tenantId, async (tx) => {
            const current = first(
              await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
            );
            const next = await updateAction(tx, current, {
              state: 'verifying',
              confirmedWrite: true,
            });
            await record(tx, next, 'write_acknowledged', { success: true });
          });
        } catch (err) {
          if (err instanceof MetaApiError && ['reschedule', 'throttle'].includes(err.action.kind)) {
            await inTenant(a.tenantId, async (tx) => {
              const current = first(
                await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
              );
              const next = await updateAction(tx, current, {
                state: 'approved',
                dispatchAt: null,
                error: `Meta rechazó el envío por cuota (${err.code}/${err.subcode}); se reprograma.`,
              });
              await record(tx, next, 'write_rejected_retryable', {
                code: err.code,
                subcode: err.subcode,
              });
            });
            return reschedule(
              err.action.kind === 'reschedule'
                ? err.action.minSeconds
                : (err.usage.regainSeconds ?? 300),
              'Rechazo explícito por cuota de Meta.',
            );
          }
          const definite =
            (err instanceof MetaApiError &&
              ['auth', 'permission', 'split'].includes(err.action.kind)) ||
            (err instanceof MetaApiError &&
              err.action.kind === 'stop' &&
              err.action.reason !== 'unknown');
          await inTenant(a.tenantId, async (tx) => {
            const current = first(
              await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
            );
            const next = await updateAction(tx, current, {
              state: definite ? 'failed' : 'verifying',
              dispatchAt: definite ? null : current.dispatchAt,
              result: definite ? 'rejected' : null,
              error: safeError(err),
            });
            await record(tx, next, definite ? 'write_rejected' : 'write_ambiguous', {
              code: err instanceof MetaApiError ? err.code : null,
              subcode: err instanceof MetaApiError ? err.subcode : null,
            });
          });
          if (definite) return { type: 'end', reason: 'Meta rechazó la operación' };
        }
        const current = await inTenant(a.tenantId, async (tx) =>
          first(await tx.select().from(actions).where(eq(actions.id, id))),
        );
        return reconcile(current);
      } catch (err) {
        if (err instanceof ThrottledError)
          return { type: 'reschedule', runAfter: err.until, reason: 'Cuota de lectura de Meta' };
        // Si hay un marcador, incluso un fallo de persistencia tras la respuesta solo permite GET.
        return inTenant(a.tenantId, async (tx) => {
          const current = first(
            await tx.select().from(actions).where(eq(actions.id, id)).for('update'),
          );
          if (current.dispatchAt)
            return reschedule(30, 'Envío registrado: reconciliar sin repetir.');
          if (current.state !== 'approved') return { type: 'end', reason: 'acción cambió' };
          const next = await updateAction(tx, current, {
            state: 'failed',
            error: safeError(err),
            result: 'blocked',
          });
          await record(tx, next, 'failed', { error: next.error });
          return { type: 'end', reason: 'Guardrail o preflight fallido' };
        });
      }
    });
  };
}

/** Encendido por días: el owner/admin lo autoriza una vez en las reglas de la cuenta y cada tick
 * deja cada campaña ACTIVE o PAUSED según el día en la zona de la cuenta. Pasa por los mismos
 * interruptores, consentimiento write_status, operaciones permitidas y máximo presupuestario que
 * una acción manual; solo escribe si Meta difiere y vuelve a leer para comprobarlo.
 * ponytail: deja huella en audit_log, no en `actions`; si hace falta verlo en el Action Center,
 * crear filas de acción cerradas por cada cambio. */
export function createDeliveryScheduleHandler(deps: ActionDeps): JobHandler {
  const { db, config, gateway } = deps;
  return async (job) => {
    const id = (job.payload as { adAccountId?: string }).adAccountId;
    if (!id) return { type: 'stop', error: 'Falta adAccountId' };
    return withContext(db, { tenantId: job.tenantId }, async (lockTx) => {
      const policy = await policyFor(lockTx, id);
      const [account] = await lockTx.select().from(adAccounts).where(eq(adAccounts.id, id));
      if (!account || !policy.deliverySchedules.length)
        return { type: 'end', reason: 'sin horarios de encendido' };
      const { rows } = await lockTx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`action:${account.metaAccountId}`}, 0)) as locked`,
      );
      if (!rows[0]?.locked)
        return {
          type: 'reschedule',
          runAfter: new Date(Date.now() + 30_000),
          reason: 'Otra ejecución está usando esta cuenta.',
        };
      const errors: string[] = [];
      for (const schedule of policy.deliverySchedules) {
        const desired = scheduledStatus(schedule.days, account.timezoneName);
        const operation = desired === 'ACTIVE' ? 'activate' : 'pause';
        // Solo los campos que leen authorization/inspect/write.
        const row = {
          tenantId: job.tenantId,
          adAccountId: id,
          entityLevel: 'campaign',
          entityMetaId: schedule.campaignId,
          operation,
          desired,
          recommendationId: null,
          rollbackOf: null,
          state: 'approved',
        } as unknown as ActionRow;
        try {
          const auth = await withContext(db, { tenantId: job.tenantId }, async (tx) => {
            if (!config.META_WRITES_ENABLED)
              throw conflict('Interruptor global de escrituras desactivado.');
            checkPolicy(policy, operation, account.timezoneName);
            return authorization(tx, row, config);
          });
          const live = await gateway.inspect(auth, row);
          if (live.status === desired) continue;
          const preview = previewOf(live, operation, desired, 'campaign', policy);
          await gateway.beforeWrite(auth);
          await gateway.write(auth, row, preview as Preview);
          const after = await gateway.inspect(auth, row);
          await withContext(db, { tenantId: job.tenantId }, (tx) =>
            recordEvent(
              tx,
              { tenantId: job.tenantId, actorType: 'system' },
              {
                action: 'delivery_schedule.applied',
                targetType: 'campaign',
                targetId: schedule.campaignId,
                before: { status: live.status },
                after: { status: after.status, desired, days: schedule.days },
              },
            ),
          );
          if (after.status !== desired)
            errors.push(`${schedule.campaignId}: Meta aún no muestra ${desired}.`);
        } catch (err) {
          if (err instanceof ThrottledError)
            return { type: 'reschedule', runAfter: err.until, reason: 'Cuota de Meta' };
          errors.push(`${schedule.campaignId}: ${safeError(err)}`);
        }
      }
      // El error queda en jobs.last_error (visible en las reglas de la cuenta) y se reintenta.
      return errors.length ? { type: 'retry', error: errors.join(' | ') } : { type: 'done' };
    });
  };
}
