import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ActionCloseBody,
  ActionCreateBody,
  ActionDecisionBody,
  ActionDto,
  ActionEventDto,
  ActionPolicyBody,
  ActionPolicyDto,
  ActionQuery,
  ActionRevisionBody,
  ActionRollbackBody,
} from '../../action-contracts.ts';
import { IdParams } from '../../contracts.ts';
import { tenantOf } from '../../platform/http.ts';
import { type ActionDeps, createActionService } from './service.ts';

export async function actionRoutes(fastify: FastifyInstance, deps: ActionDeps) {
  const app = fastify.withTypeProvider<ZodTypeProvider>(),
    service = createActionService(deps);
  app.get(
    '/v1/actions',
    {
      config: { access: { permission: 'actions:read' } },
      schema: { querystring: ActionQuery, response: { 200: z.array(ActionDto) } },
    },
    (r) => service.list(tenantOf(r), r.query.adAccountId),
  );
  app.get(
    '/v1/actions/:id',
    {
      config: { access: { permission: 'actions:read' } },
      schema: { params: IdParams, response: { 200: ActionDto } },
    },
    (r) => service.get(tenantOf(r), r.params.id),
  );
  app.get(
    '/v1/actions/:id/events',
    {
      config: { access: { permission: 'actions:read' } },
      schema: { params: IdParams, response: { 200: z.array(ActionEventDto) } },
    },
    (r) => service.events(tenantOf(r), r.params.id),
  );
  app.get(
    '/v1/action-policies/:id',
    {
      config: { access: { permission: 'actions:read' } },
      schema: { params: IdParams, response: { 200: ActionPolicyDto } },
    },
    (r) => service.policy(tenantOf(r), r.params.id),
  );
  app.put(
    '/v1/action-policies/:id',
    {
      config: { access: { permission: 'actions:configure' } },
      schema: { params: IdParams, body: ActionPolicyBody, response: { 200: ActionPolicyDto } },
    },
    (r) => service.setPolicy(tenantOf(r), r.params.id, r.body.policy, r.body.reason),
  );
  app.post(
    '/v1/actions',
    {
      config: { access: { permission: 'actions:propose' } },
      schema: { body: ActionCreateBody, response: { 200: ActionDto } },
    },
    (r) => service.propose(tenantOf(r), r.body),
  );
  app.post(
    '/v1/actions/:id/preview',
    {
      config: { access: { permission: 'actions:propose' } },
      schema: { params: IdParams, body: ActionRevisionBody, response: { 200: ActionDto } },
    },
    (r) => service.preview(tenantOf(r), r.params.id, r.body.revision),
  );
  app.post(
    '/v1/actions/:id/approve',
    {
      config: { access: { permission: 'actions:approve' } },
      schema: { params: IdParams, body: ActionDecisionBody, response: { 200: ActionDto } },
    },
    (r) => service.approve(tenantOf(r), r.params.id, r.body),
  );
  app.post(
    '/v1/actions/:id/close',
    {
      config: { access: { permission: 'actions:approve' } },
      schema: { params: IdParams, body: ActionCloseBody, response: { 200: ActionDto } },
    },
    (r) => service.close(tenantOf(r), r.params.id, r.body),
  );
  app.post(
    '/v1/actions/:id/reconcile',
    {
      config: { access: { permission: 'actions:approve' } },
      schema: { params: IdParams, response: { 200: ActionDto } },
    },
    (r) => service.reconcile(tenantOf(r), r.params.id),
  );
  app.post(
    '/v1/actions/:id/rollback',
    {
      config: { access: { permission: 'actions:propose' } },
      schema: { params: IdParams, body: ActionRollbackBody, response: { 200: ActionDto } },
    },
    (r) => service.rollback(tenantOf(r), r.params.id, r.body.idempotencyKey, r.body.reason),
  );
}
