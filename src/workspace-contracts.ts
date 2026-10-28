import { z } from 'zod';
import { AdAccountDto } from './contracts.ts';

export const WorkspaceAccountDto = AdAccountDto.extend({
  clientName: z.string().nullable(),
  connectionStatus: z.string(),
  connectionExpired: z.boolean(),
  readConsentActive: z.boolean(),
  monitoringEnabled: z.boolean(),
  staleHours: z.number(),
  lastEvaluationAt: z.iso.datetime({ offset: true }).nullable(),
  health: z
    .object({
      score: z.number().nullable(),
      grade: z.enum(['excellent', 'good', 'attention', 'critical', 'insufficient']),
      date: z.string(),
    })
    .nullable(),
  incidents: z.number().int(),
  criticalIncidents: z.number().int(),
  findings: z.number().int(),
  criticalFindings: z.number().int(),
  pendingActions: z.number().int(),
  failedActions: z.number().int(),
});
export type WorkspaceAccount = z.infer<typeof WorkspaceAccountDto>;

export const WorkspaceSearchQuery = z.object({ q: z.string().trim().min(2).max(100) });
export const WorkspaceSearchResultDto = z.object({
  kind: z.enum(['client', 'account', 'campaign']),
  id: z.string(),
  name: z.string(),
  accountId: z.uuid().nullable(),
  context: z.string(),
});
export type WorkspaceSearchResult = z.infer<typeof WorkspaceSearchResultDto>;
