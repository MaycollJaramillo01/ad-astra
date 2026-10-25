-- Aislamiento del asistente de IA (ADR-007). Como app_owner.

-- Una conversación solo la ve su usuario, dentro de su tenant.
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ai_conversations_own ON ai_conversations
  USING (tenant_id = app_tenant_id() AND user_id = app_user_id())
  WITH CHECK (tenant_id = app_tenant_id() AND user_id = app_user_id());--> statement-breakpoint

-- Los mensajes heredan la visibilidad de su conversación (la subconsulta ya aplica la RLS de arriba).
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ai_messages_own ON ai_messages
  USING (tenant_id = app_tenant_id() AND conversation_id IN (SELECT id FROM ai_conversations))
  WITH CHECK (tenant_id = app_tenant_id() AND conversation_id IN (SELECT id FROM ai_conversations));--> statement-breakpoint

-- llm_usage es contabilidad: se inserta y se lee, nunca se cambia ni se borra (como audit_log).
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE llm_usage FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY llm_usage_select ON llm_usage FOR SELECT USING (tenant_id = app_tenant_id());--> statement-breakpoint
CREATE POLICY llm_usage_insert ON llm_usage FOR INSERT WITH CHECK (tenant_id = app_tenant_id());--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON llm_usage FROM app_rw;
