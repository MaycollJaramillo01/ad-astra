import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdParams } from '../../contracts.ts';
import type { Db } from '../../db/client.ts';
import { IncidentDecision, PolicyBody, ReportBody } from '../../monitoring-contracts.ts';
import { tenantOf } from '../../platform/http.ts';
import { createMonitoringService } from './service.ts';

export async function monitoringRoutes(fastify: FastifyInstance, { db }: { db: Db }) {
  const app = fastify.withTypeProvider<ZodTypeProvider>(),
    service = createMonitoringService(db);
  app.get(
    '/v1/monitoring/:id',
    {
      config: { access: { permission: 'monitoring:read' } },
      schema: { params: IdParams, response: { 200: z.unknown() } },
    },
    (r) => service.overview(tenantOf(r), r.params.id),
  );
  app.get(
    '/v1/monitoring/:id/events',
    {
      config: { access: { permission: 'monitoring:read' } },
      schema: { params: IdParams, response: { 200: z.unknown() } },
    },
    (r) => service.events(tenantOf(r), r.params.id),
  );
  app.get(
    '/v1/monitoring/:id/recipients',
    {
      config: { access: { permission: 'monitoring:configure' } },
      schema: { params: IdParams, response: { 200: z.unknown() } },
    },
    (r) => service.recipients(tenantOf(r), r.params.id),
  );
  app.put(
    '/v1/monitoring/:id/policy',
    {
      config: { access: { permission: 'monitoring:configure' } },
      schema: { params: IdParams, body: PolicyBody, response: { 200: z.unknown() } },
    },
    (r) => service.setPolicy(tenantOf(r), r.params.id, r.body),
  );
  app.post(
    '/v1/monitoring/:id/evaluate',
    {
      config: { access: { permission: 'monitoring:run' } },
      schema: { params: IdParams, response: { 200: z.unknown() } },
    },
    (r) => service.evaluate(tenantOf(r), r.params.id),
  );
  app.post(
    '/v1/monitoring/incidents/:id/decide',
    {
      config: { access: { permission: 'monitoring:decide' } },
      schema: { params: IdParams, body: IncidentDecision, response: { 200: z.unknown() } },
    },
    (r) => service.decide(tenantOf(r), r.params.id, r.body),
  );
  app.post(
    '/v1/monitoring/:id/reports',
    {
      config: { access: { permission: 'monitoring:run' } },
      schema: { params: IdParams, body: ReportBody, response: { 200: z.unknown() } },
    },
    (r) => service.report(tenantOf(r), r.params.id, r.body.days),
  );
  app.get(
    '/v1/monitoring/reports/:id',
    {
      config: { access: { permission: 'monitoring:read' } },
      schema: { params: IdParams, response: { 200: z.unknown() } },
    },
    (r) => service.getReport(tenantOf(r), r.params.id),
  );
}
