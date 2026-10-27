# Seguridad — Ad Astra

> Versión 0.1 · 2026-10-23. Referencia de controles: OWASP ASVS nivel 2 y OWASP Top 10 para aplicaciones LLM (2025). Este documento es vinculante: un control marcado como obligatorio no se simplifica sin un ADR aprobado.

## 1. Objetivos y alcance

1. Ningún tenant puede ver ni modificar datos de otro (aislamiento verificable).
2. Los tokens de Meta, el app secret y las claves de los proveedores **nunca** salen del backend: ni al frontend, ni a los logs, ni a los prompts, ni al repositorio.
3. Ninguna escritura en Meta sin aprobación humana registrada; la IA no puede escribir.
4. Toda acción relevante queda en un registro de auditoría de solo inserción.
5. Cumplimiento de las Condiciones de la Plataforma de Meta y de la normativa de protección de datos aplicable (PQ-04).

## 2. Activos y clasificación

| Activo | Clasificación | Dónde vive |
|---|---|---|
| Tokens de Meta | **Secreto** | `meta_connections`, cifrados con AES-256-GCM |
| App secret de Meta, claves de LLM y email, clave maestra (KEK) | **Secreto** | Gestor de secretos o variables de entorno del runtime; nunca en la BD ni en el repositorio |
| Rendimiento y configuración de las campañas de los clientes | Confidencial (datos de la plataforma de Meta) | Postgres, con RLS |
| Textos de creatividades y nombres de entidades | Confidencial y **no confiable** (posible inyección) | Postgres |
| Nombres de actores del registro de actividad, emails del personal | Dato personal | Postgres, con retención acotada |
| Hallazgos, decisiones y registro de auditoría | Confidencial e íntegro | Postgres (solo inserción) |
| Conversaciones con la IA (F4) | Confidencial | Postgres, 90 días |

## 3. Modelo de amenazas (STRIDE)

| Amenaza | Ejemplo | Controles |
|---|---|---|
| **S**uplantación | Robo de la sesión de un administrador | Cookies httpOnly, Secure y SameSite=Lax; rotación de la sesión al iniciar sesión; acceso solo con Google Workspace y verificación en dos pasos obligatoria en su política; reautenticación para acciones sensibles |
| **S**uplantación | Uso de un token de Meta robado desde otra máquina | Require App Secret + `appsecret_proof`; lista de IPs del servidor (opcional); cifrado en reposo |
| **T**ampering | Alterar el registro de auditoría o las decisiones | `audit_log` solo inserción (sin `UPDATE` ni `DELETE`); RLS con `WITH CHECK`; hashes encadenados en F7 |
| **T**ampering | Webhooks falsificados (F5) | Validación de `X-Hub-Signature-256`; idempotencia |
| **R**epudio | "Yo no aprobé ese cambio de presupuesto" | Aprobación con actor, IP, user agent, estado antes y después y reautenticación |
| **I**nformation disclosure | Fuga entre tenants | RLS forzado + tests en la CI que recorren todas las tablas |
| **I**nformation disclosure | Token en logs o mensajes de error | Redacción en pino y en las URLs; test con token canario |
| **I**nformation disclosure | Exfiltración mediante la IA | Herramientas acotadas por tenant y RBAC; sin herramientas de red; minimización; salida sin HTML activo |
| **D**enegación de servicio | Abuso de endpoints o desgloses en vivo | Límite de peticiones por IP y usuario; cuotas de desgloses; colas con concurrencia acotada |
| **D**enegación de servicio | Costo desbocado de LLM o de la API de Meta | Presupuestos por tenant y usuario; gobernador de cuotas |
| **E**levación de privilegios | Un analyst aprueba acciones; IDOR entre clientes | Autorización centralizada (denegar por defecto); comprobación de alcance por cliente en cada servicio; tests de autorización por endpoint |
| **E**levación de privilegios | "Agencia excesiva" de la IA | La IA no tiene herramientas de escritura; las propuestas pasan por el flujo de aprobación |

## 4. Controles

### 4.1 Identidad y sesiones del personal

- **Google Workspace como único método de acceso** (PQ-05, ADR-019): Better Auth con sesiones en Postgres y sin contraseñas locales. Cliente OAuth de tipo "Internal" (solo cuentas del Workspace) y comprobación en el servidor de `hd` = dominio de la agencia y `email_verified`.
- La verificación en dos pasos la impone la política del Workspace; debe estar **obligatoria** al menos para los usuarios con rol owner o admin (comprobación en el checklist de F1).
- Tener cuenta del Workspace no da acceso: el alta es por invitación en Ad Astra, con su rol. Al dar de baja a alguien en el Workspace se le cierra el acceso; además, Ad Astra revoca sus sesiones al quitarle la membresía.
- SAML/OIDC empresarial y usuarios externos (portal de clientes) en F7.
- Sesión: expiración por inactividad (8 h) y absoluta (7 días); cierre de todas las sesiones al cambiar la contraseña o el rol.
- Protección contra fuerza bruta: límite por cuenta e IP con retardo progresivo.

### 4.2 Autorización: RBAC y alcance por cliente

| Permiso | owner | admin | manager | analyst | viewer |
|---|---|---|---|---|---|
| Configuración del tenant, presupuestos de IA y API | ✓ | ✓ | – | – | – |
| Gestionar usuarios y roles | ✓ | ✓ | – | – | – |
| Gestionar conexiones de Meta (alta y baja de tokens) | ✓ | ✓ | – | – | – |
| Gestionar clientes, asignaciones y consentimientos | ✓ | ✓ | – | – | – |
| Ver datos | Todos | Todos | Clientes asignados | Clientes asignados | Clientes asignados |
| Configurar reglas, objetivos KPI y umbrales | ✓ | ✓ | Sus clientes | – | – |
| Reconocer, posponer y descartar hallazgos y alertas | ✓ | ✓ | ✓ | ✓ | – |
| Usar el copiloto IA (F4) y proponer sus recomendaciones a la cola | ✓ | ✓ | ✓ | ✓ | – |
| Subir documentos (F4) | ✓ | ✓ | ✓ | ✓ | – |
| Aprobar documentos para la IA (F4) | ✓ | ✓ | ✓ | – | – |
| Proponer acciones (F5) | ✓ | ✓ | ✓ | ✓ | – |
| Aprobar acciones (F5) | ✓ | ✓ | Solo estados de sus clientes; no presupuestos | – | – |
| Kill switch de acciones (F5) | ✓ | ✓ | – | – | – |
| Ver el registro de auditoría | ✓ | ✓ | – | – | – |

- Un único servicio `authorize(user, permission, resource)` decide. Denegar por defecto. Cada endpoint declara su permiso y un test verifica que ninguno queda sin declarar.
- Separación de funciones en F5: nadie aprueba su propia propuesta. Activaciones y presupuestos desde el umbral requieren dos aprobadores distintos del proponente. Reglas, idempotencia, límites de reversión y protección de envíos ambiguos en [ACTION_CENTER.md](ACTION_CENTER.md).

### 4.3 Multi-tenancy verificable

- `tenant_id` en todas las tablas de datos y RLS forzado ([DATABASE_SCHEMA.md §4](DATABASE_SCHEMA.md#4-aislamiento-multi-tenant-rls)).
- El contexto de tenant lo fija el servidor por transacción (`set_config(..., true)`, local a la transacción) tras verificar la membresía del usuario; la cabecera `x-tenant-id` solo **elige** entre sus organizaciones y nunca se usa sin esa verificación.
- **Claves foráneas compuestas** `(tenant_id, id)` en todas las referencias entre tablas de un tenant: Postgres comprueba las FK sin aplicar RLS, así que una FK simple permitiría enlazar una fila propia con el id de otro tenant.
- Un recurso de otro tenant responde **404**, igual que uno inexistente: no se confirma su existencia.
- Pruebas obligatorias en la CI (implementadas: `test/rls.test.ts`, `test/api-security.test.ts`): cobertura de RLS en el catálogo de tablas, lectura, actualización, borrado e inserción cruzadas con `app_rw`, fallo cerrado sin contexto, FK compuestas, peticiones de la API con ids de otro tenant (404, con control positivo en el tenant propio), cabecera de tenant ajena (403) y alcance por cliente. Se verificó con **pruebas de mutación** que fallan si se quita el alcance por cliente o se confía en la cabecera sin verificar la membresía.

### 4.4 Secretos y credenciales

- **Cifrado de tokens de Meta:** AES-256-GCM (`node:crypto`), nonce aleatorio de 12 bytes por cifrado, AAD = `tenant_id || connection_id` y versión de clave. La clave maestra (32 bytes) vive como variable de entorno *Sensitive* de Vercel (ADR-022), distinta por entorno, y solo la leen las funciones `api` y `tick`.
- **Rotación de la clave maestra:** nueva versión → job que recifra las filas → retirada de la versión anterior. En SaaS (F7), la clave maestra pasa a un KMS con claves de datos por tenant (cifrado de sobre).
- El token se descifra justo antes de la llamada a Meta, solo en memoria, y no se pasa a funciones de logging ni de error. Los mensajes de error que se guardan (`sync_runs.error_message`, `jobs.last_error`) pasan por la redacción; un test canario con errores de red y de Meta que contienen el token lo comprueba.
- **App secret:** solo en el gestor de secretos. Se rota si hay sospecha de exposición (y se revalidan todas las conexiones).
- **Repositorio:** `.env` en `.gitignore`, `.env.example` sin valores y escaneo de secretos (gitleaks o equivalente) en pre-commit y en la CI.
- **Respuestas de la API:** las conexiones devuelven solo `id`, `label`, `kind`, `scopes`, `status`, `expires_at` y la huella. Un test de contrato verifica que ningún esquema de respuesta contiene campos `token`.

### 4.5 Protección de endpoints

- Validación con zod de todo el input (cuerpo, query, parámetros y cabeceras relevantes); rechazo de campos desconocidos en las escrituras.
- Validación de salida: las respuestas se serializan con el esquema declarado (no se filtran campos internos).
- CSRF: toda petición que modifica exige `Origin` = `APP_ORIGIN` (`src/platform/http.ts`), además de la cookie SameSite=Lax y las comprobaciones de origen propias de Better Auth; CORS cerrado (mismo origen). Sustituye al token de doble envío previsto: con mismo origen y SameSite, la verificación de origen basta y no añade estado. Los webhooks de Meta (F5) tendrán una excepción explícita, protegida por firma.
- Cabeceras: CSP estricta (sin `unsafe-inline` en scripts), HSTS, `X-Content-Type-Options`, `Referrer-Policy` y `frame-ancestors 'none'` (helmet).
- Límite de peticiones (`@fastify/rate-limit`) por IP y usuario, más estricto en login y en los desgloses en vivo.
- Errores en formato `problem+json` sin trazas; el detalle va al log con el `request_id`.
- **Exportación CSV** (`GET /v1/analytics/export.csv`): mismo alcance por cliente que la vista, evento `analytics.exported` en el registro de auditoría y celdas de texto que empiezan por `=`, `+`, `-`, `@` neutralizadas con un apóstrofo (los nombres vienen de Meta y los escribe cualquiera); los números negativos se dejan como números.
- **Motor de auditoría:** ejecutarlo a mano exige `audit:run` (owner, admin, manager, analyst) y el alcance por cliente; su configuración, `audit:configure` (owner y admin en la organización; manager solo en sus clientes), validada por esquema y registrada como `audit_config.updated`.
- **Tick** (`GET /v1/internal/tick`): sin sesión de usuario, protegido por `Authorization: Bearer $CRON_SECRET` con comparación en tiempo constante; sin `CRON_SECRET` configurado responde 404 y sin app de Meta, 503 (nunca simula una sincronización).
- Subidas (F4, documentos): tipos permitidos, tamaño máximo, sin ejecución y extracción de texto en el worker.

### 4.6 Registro de auditoría

Eventos mínimos: inicio y cierre de sesión, fallos de login, cambios de rol, alta, baja, rotación o invalidación de conexiones, asignación de cuentas, consentimientos, cambios de reglas y objetivos, decisiones sobre hallazgos, uso de la IA (metadatos), propuestas, aprobaciones, ejecuciones y reversiones, kill switch, purgas y exportaciones. Nunca se guardan secretos en `before` y `after`.

### 4.7 Consentimientos y permisos de los clientes

- Cada cliente tiene un consentimiento con alcance explícito (`read_insights`, `ai_processing`, `write_status`, `write_budget`) y una referencia al documento firmado.
- Sin `read_insights` activo, sus cuentas no se sincronizan; sin `ai_processing`, la IA no accede a sus datos; sin el alcance de escritura correspondiente, no se pueden crear propuestas para ellas.
- La revocación detiene la sincronización de inmediato y programa la purga (§5).
- Implementado (F1): activar la sincronización de una cuenta exige un cliente con `read_insights` activo, y cada trabajo de la cuenta lo vuelve a comprobar antes de llamar a Meta; revocado, lo pendiente termina sin llamadas. La purga llega con la retención (§5).
- Implementado (F4): cada consulta de la IA comprueba `ai_processing` del cliente en su propia transacción; las cuentas sin cliente o sin ese alcance no llegan al modelo (la cartera las excluye y lo dice) y proponer una recomendación lo vuelve a comprobar.
- El permiso técnico (scopes del token y `user_tasks`) y el consentimiento contractual se comprueban **ambos** antes de actuar.

### 4.8 Seguridad de la IA (OWASP Top 10 para LLM, 2025)

| Riesgo | Control en Ad Astra |
|---|---|
| LLM01 Inyección de prompts | Nombres de entidades, creatividades y documentos devueltos como datos etiquetados y delimitados; instrucciones del operador solo en el prompt de sistema o en mensajes de sistema intermedios; sin capacidades que una inyección pueda aprovechar (ni escritura, ni red, ni otros tenants); suite de inyección en la CI |
| LLM02 Divulgación de información sensible | Minimización (sin PII ni secretos en el contexto); herramientas acotadas por tenant y RBAC; test que busca patrones de token en los prompts registrados |
| LLM03 Cadena de suministro | Proveedor y SDK oficiales con versión fijada; sin plugins de terceros |
| LLM04 Envenenamiento de datos | Solo documentos `approved` son recuperables; la aprobación queda auditada |
| LLM05 Manejo inseguro de la salida | Markdown saneado, sin HTML ni scripts; enlaces solo a la propia plataforma; las propuestas generadas se validan con esquema y pasan por aprobación |
| LLM06 Agencia excesiva | Inventario de herramientas de solo lectura comprobado por un test; ninguna dependencia de `ai` hacia `meta` u `optimization` |
| LLM07 Fuga del prompt de sistema | El prompt de sistema no contiene secretos; si se filtrara, no habilita nada |
| LLM08 Debilidades de vectores y embeddings | Si se usa pgvector: RLS en `document_chunks` y filtrado por tenant antes de la búsqueda |
| LLM09 Desinformación | Verificador de cifras; lenguaje probabilístico; citas de evidencia; evals |
| LLM10 Consumo sin límites | Presupuestos por tenant y usuario, `max_tokens`, máximo de llamadas a herramientas por turno, timeouts |

### 4.9 Seguridad de las integraciones

- Solo el módulo `meta` habla con Meta, con la URL base fija; nunca se piden URLs construidas a partir de datos de usuario.
- **SSRF:** el servidor no descarga miniaturas ni URLs de creatividades; el navegador las carga directamente desde la CDN de Meta, con la CSP limitada a esos dominios.
- Webhooks (F5): firma, verificación de suscripción, deduplicación y procesamiento asíncrono.
- Proveedores (LLM, email): claves con el mínimo alcance, una por entorno, rotación documentada.

### 4.10 Cadena de suministro de software

- Lockfile obligatorio e instalación con `--frozen-lockfile` en la CI.
- Auditoría de dependencias (`pnpm audit` u OSV-Scanner) en cada PR; las vulnerabilidades altas bloquean la integración.
- Actualizaciones automáticas (Renovate o Dependabot) agrupadas semanalmente.
- Imagen de contenedor mínima, usuario sin privilegios y escaneo de la imagen.
- Política de dependencias: cada dependencia nueva se justifica en el PR (ADR-001).

### 4.11 Logs y privacidad

- pino con `redact` en `*.access_token`, `*.token`, `*.appsecret_proof`, `*.client_secret`, `*.fb_exchange_token`, `req.headers.authorization` y `req.headers.cookie`.
- `redactUrl()` obligatorio para cualquier URL registrada. Los errores de las librerías HTTP se registran solo por código y mensaje redactado.
- **Test canario:** la suite inyecta un token ficticio con un patrón reconocible, ejecuta flujos de error y verifica que el patrón no aparece en logs, respuestas, `sync_runs`, `meta_api_calls` ni `llm_usage`.
- Sin datos personales en los logs más allá de los IDs internos.

## 5. Cumplimiento

- **Condiciones de la Plataforma de Meta** ([API_INTEGRATIONS.md §1.19](API_INTEGRATIONS.md#119-condiciones-de-la-plataforma-de-meta-aplicables-v)): uso limitado a la gestión de las cuentas del cliente; borrado cuando lo pidan Meta o el cliente o cuando dejen de ser necesarios; acuerdos escritos con los proveedores de servicios; seguridad acorde a los estándares del sector; notificación de incidentes; cooperación en auditorías.
- **Registro de subencargados** (se mantiene en este documento a partir de F1):

| Subencargado | Propósito | Datos | Acuerdo | Desde |
|---|---|---|---|---|
| Vercel (PQ-04) | Alojamiento de la SPA, la API y el `tick` | Todos en tránsito; logs | DPA | F1 |
| Neon (PQ-04) | Base de datos | Todos | DPA | F1 |
| Google (Workspace) | Identidad del personal | Emails y nombres del personal | Condiciones del Workspace | F1 |
| Resend (integración opcional, apagada por defecto) | Alertas autorizadas | Email verificado del personal, conteo y enlace autenticado; sin métricas ni nombres de clientes | DPA y verificación del remitente pendientes antes de habilitar producción | F3 |
| Proveedor LLM (Anthropic, propuesto) | Copiloto y reportes | Métricas agregadas, sin PII | DPA y retención acordada | F4 |

- **Protección de datos:** la ley aplicable depende de la jurisdicción de la agencia y de sus clientes (RGPD/LOPDGDD en España, LFPDPPP en México, LGPD en Brasil…), por confirmar en PQ-04. Los datos de rendimiento son mayoritariamente agregados, pero hay datos personales del personal y de los actores del registro de actividad. La agencia suele actuar como encargada del tratamiento de sus clientes: los contratos con los clientes deben cubrirlo.
- **Fuera del alcance a propósito:** datos personales de leads (formularios instantáneos), audiencias personalizadas con listas de clientes y cualquier dato a nivel de usuario.

## 6. Backups y recuperación

| Objetivo | MVP |
|---|---|
| RPO | Objetivo propuesto ≤15 min mediante PITR; plan/ventana y medición pendientes, no garantizados por el nombre del plan |
| RTO | Objetivo propuesto ≤4 h incluyendo restauración, revisión de accesos y conciliación; sin medición cloud |
| Backups lógicos | Workflow nocturno preparado pero desactivado; pg_dump cifrado AES-256-GCM antes de salir a S3, recibo/versionado/Object Lock y plantilla de retención 30 días. Fallback cercano a 24 h de RPO |
| Clave maestra | Respaldada aparte de la BD (copia fuera de Vercel, con su versión). Sin ella, los tokens son irrecuperables por diseño: se reconectan las cuentas |
| Simulacro | Restauración completa en un entorno aislado al cierre de cada fase, con el tiempo medido y registrado en [TESTING.md](TESTING.md) |

Auditoría 2026-10-26: simulacro sintético local aprobado, restauración cloud pendiente; no existen aún proyectos de staging/producción. Procedimiento, roles y cuarentena en [OPERATIONS.md](OPERATIONS.md). La marca de simulacro exige atestación posterior a las verificaciones; empezar una restauración no acredita recuperación exitosa. El runtime no puede desactivar la cuarentena.

Meta es una fuente secundaria para los hechos de los últimos 37 meses (se pueden volver a descargar), pero **no** para los hallazgos, decisiones, consentimientos ni el registro de auditoría: esos datos dependen solo de los backups.

## 7. Respuesta a incidentes

1. **Detección:** alertas de errores, accesos anómalos, fallos del test canario y avisos de proveedores.
2. **Contención:** kill switch de acciones, revocación de sesiones, invalidación de conexiones (borrar el cifrado y revocar los tokens en el portafolio de Meta) y rotación del app secret si procede.
3. **Erradicación y recuperación:** corrección, restauración si es necesario y revalidación de las conexiones.
4. **Notificación:** a Meta "lo antes posible y nunca más tarde de lo que exija la ley" (Condiciones §6.b), a los clientes afectados y a la autoridad de protección de datos si aplica, dentro de los plazos legales.
5. **Postmortem** sin culpables en 5 días hábiles, con acciones en el registro de deuda.

## 8. Checklist de seguridad por fase

| Fase | Controles que deben quedar verificados |
|---|---|
| F0 | Repositorio con escaneo de secretos; `.env.example` sin valores; redacción de logs y `redactUrl()` con tests; `appsecret_proof` en el cliente; Require App Secret activado en la app de Meta; token del spike fuera del repositorio |
| F1 | RLS forzado en todas las tablas + tests de aislamiento; cifrado de tokens con AAD + test de manipulación; respuestas sin tokens (test de contrato); test canario; RBAC centralizado y tests por endpoint; acceso solo con Google Workspace (app OAuth "Internal" + `hd`) y verificación en dos pasos obligatoria en el Workspace para owner y admin; registro de auditoría de solo inserción; límites de peticiones; CSP y cabeceras; auditoría de dependencias en la CI; backups y PITR configurados; consentimientos por cliente |
| F1 · estado 2026-10-23 | ✅ RLS forzado + tests · ✅ FK compuestas · ✅ cifrado AES-256-GCM con AAD + tests de manipulación y rotación · ✅ token nunca en respuestas, logs, eventos ni OpenAPI (test canario por la API) · ✅ RBAC centralizado + invariante de arranque (ninguna ruta sin acceso declarado) · ✅ Google Workspace con `hd` + alta solo por invitación · ⏳ verificación en dos pasos obligatoria en el Workspace (configuración del responsable) · ✅ `audit_log` de solo inserción · ✅ límite de peticiones (en memoria por instancia, TD-08) · ✅ cabeceras (helmet) · ✅ CSRF por `Origin` · ✅ auditoría de dependencias y gitleaks en la CI · ⏳ PITR y backups (al desplegar en Neon) · ✅ consentimientos por cliente (modelo y API; `read_insights` exigido por la sincronización) · ✅ tick protegido por `CRON_SECRET` · ✅ errores de sincronización redactados (test canario) |
| F2 | Autorización por cliente en todas las consultas; cuotas de desgloses en vivo; exportaciones CSV auditadas |
| F2 · estado 2026-10-24 | ✅ alcance por cliente en la analítica (tests por nivel, 404 para lo ajeno) · ✅ exportación CSV auditada y sin fórmulas ejecutables · ⏳ cuotas de desgloses en vivo (aún no hay desgloses en vivo) |
| F3 | Notificaciones sin datos sensibles; DPA del proveedor de email; simulacro de restauración |
| F3 · estado 2026-10-26 | ✅ RLS en salud, auditoría y monitoreo; historiales e informes inmutables para el runtime · ✅ permisos con alcance por cliente · ✅ outbox, destinatarios autorizados, revalidación y bloqueo global del email · ✅ simulacro local con manipulación, RLS y cuarentena · ⏳ DPA, entregabilidad/SLA, recuperación cloud y calibración en piloto |
| F4 | DPA del proveedor LLM; minimización verificada; inventario de herramientas de solo lectura (test); suite de inyección; verificador de cifras; presupuestos y límites; documentos solo `approved` |
| F4 · estado 2026-10-24 | ✅ inventario de solo lectura y cierre de importaciones sin `meta` ni `optimization` (tests) · ✅ herramientas con RBAC, RLS, alcance por cliente y `ai_processing` · ✅ textos de terceros limpiados y retirados si parecen instrucciones; operador en mensajes de sistema intermedios (tests) · ✅ verificador de cifras y lenguaje (evals deterministas) · ✅ presupuestos por organización, usuario y pregunta con `llm_usage` de solo inserción y bloqueo registrado; límite de preguntas por minuto · ✅ conversaciones privadas por RLS · ✅ salida pintada como texto, sin HTML ni enlaces · ✅ canario: ninguna credencial de Meta en lo enviado al modelo · ⏳ DPA y retención con el proveedor · ⏳ evaluación en vivo de inyección (TD-29) · ⏳ documentos `approved` (TD-24) |
| F5 | Doble verificación de permisos (token + `user_tasks` + consentimiento); separación de funciones; reautenticación al aprobar; kill switch probado; idempotencia; webhooks firmados; pruebas de escritura solo en sandbox |
| F6 | Los modelos no exponen datos de otros tenants (entrenamiento y ajuste por tenant) |
| F7 | KMS con claves por tenant; SSO; prueba de penetración externa; reparto de cuotas; hashes encadenados en el registro de auditoría |

## 9. Prohibiciones explícitas

- Tokens, secretos o claves en el frontend, los logs, los prompts, los fixtures o el repositorio.
- Credenciales reales en pruebas automatizadas o en la CI.
- Escrituras en Meta fuera del flujo de aprobación, incluidas las de scripts manuales en producción.
- Herramientas de la IA con capacidad de escritura o de red.
- Fijar el contexto de tenant desde parámetros del cliente.
- Descargar URLs proporcionadas por terceros desde el servidor.
- Desactivar RLS o usar `app_maint` en el código de la aplicación.
