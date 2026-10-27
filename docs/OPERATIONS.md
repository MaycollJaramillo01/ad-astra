# Operación, despliegue y recuperación

Estado al 2026-10-26: implementación y pruebas locales. El responsable confirmó que todavía no existen entornos de staging ni producción. Este documento describe su preparación y activación; los workflows de backup y monitorización permanecen desactivados. La evaluación completa está en [preparación para producción](PRODUCTION_READINESS_2026-10-26.md).

## 1. Separación y responsabilidades

| Entorno | Recursos y acceso | Efectos externos |
|---|---|---|
| development | Postgres local, `.env.local` ignorado, Google de desarrollo | Solo operaciones expresamente autorizadas; Meta y correo desactivados por defecto |
| test | `localhost:55432/ad_astra_test`; secretos aleatorios; fixtures sintéticos | Meta, LLM y correo falsos; el setup vacía esta base |
| staging | Proyecto Vercel y base Neon propios; OAuth y secretos propios; cuentas de prueba autorizadas | El arranque rechaza Meta writes y correo habilitados; LLM real solo con presupuesto y autorización |
| production | Otro proyecto Vercel y otra base Neon; secretos sensibles y roles separados | Meta/correo requieren flags, reglas y aprobaciones; Meta, correo y LLM requieren además tenant en `WRITE_TENANT_ALLOWLIST` |

No reutilizar una base entre entornos ni copiar datos productivos a previews de PR. `deployment_state.environment` vincula cada base y el backend verifica esa vinculación. El runtime se conecta como `app_rw`, sin propiedad de tablas, superusuario ni BYPASSRLS. Las migraciones usan `app_owner`; `DATABASE_URL_OWNER` está prohibida en la función Vercel. El rol operativo de backup, con BYPASSRLS para exportar todas las organizaciones bajo FORCE RLS, se custodia fuera del runtime. Necesita lectura de datos y metadatos; las atestaciones necesitan además actualizar el estado operativo. La restauración usa un rol diferente con capacidad de crear objetos/asumir `app_owner`.

El responsable técnico administra despliegues y recuperación; el responsable de seguridad revisa accesos, secretos y evidencias; un owner de negocio autoriza políticas y presupuestos. Estos cargos requieren personas y suplentes nominados antes del piloto. Las aprobaciones registradas no sustituyen los permisos de los proveedores.

## 2. Preparación cloud pendiente

1. Crear dos proyectos Vercel y dos bases/proyectos Neon separados. Elegir región conjunta tras comprobar latencia y requisitos de residencia. No hay región productiva configurada.
2. Configurar Google Workspace OAuth Internal, redirect URI exacta, dominio permitido y 2FA obligatorio desde Workspace. Verificar invitaciones, email verificado y revocación de sesiones con usuarios reales.
3. Crear roles, aplicar las migraciones y cargar las claves de tokens y de sesiones desde un gestor de secretos. Separar app/token Meta por entorno cuando sea posible. Nunca incluir tokens en URLs, artefactos, variables `VITE_*` ni consola de build.
4. Configurar PITR en Neon y confirmar ventana, permisos, capacidad y precio del plan contratado. El objetivo propuesto sigue siendo RPO ≤15 min y RTO ≤4 h; requiere medición real y aceptación del responsable. La copia lógica nocturna ofrece un respaldo con RPO cercano a 24 h si PITR no está disponible.
5. Crear almacenamiento externo con versionado, bloqueo de objetos y retención; `ops/backup-bucket.yml` es una plantilla sin aplicar. IAM/OIDC: restringir a repositorio, rama y environment; permitir Put/Get/Head y lectura de retención solo en el prefijo; excluir Delete y BypassGovernanceRetention del escritor. Validar explícitamente restauración, retención, facturación y alertas del proveedor.
6. Configurar GitHub environments separados `staging`, `production`, `production-backup`, `production-monitor`; restringir a main y revisores independientes. El repositorio privado actual devuelve 403 al consultar protección de main por limitación del plan: CODEOWNERS por sí solo no impone revisiones. Resolver el plan o un control equivalente antes de activar producción.
7. Configurar logs externos con retención, acceso mínimo y alertas a la guardia autorizada. Sin un destino y responsables reales no existe un servicio de guardia operativo.

`APPROVAL_CONFIGURED` permanece vacío/false hasta comprobar esos controles; no cambiarlo solo para saltar una puerta. Los despliegues automáticos por integración Git están deshabilitados en `vercel.json` según el [esquema oficial de Vercel](https://openapi.vercel.sh/vercel.json). Las credenciales del CLI siguen siendo privilegiadas y requieren control de acceso.

## 3. Migraciones, vinculación y cuarentena

La migración 0016 crea un estado global sin datos de clientes, inicialmente `unbound` y `recovery_mode=true`. Antes de abrir tráfico, definir `APP_ENV` explícito y ejecutar con el rol propietario:

```bash
pnpm db:migrate
pnpm ops:control bind
```

`bind` permite solo una base nueva o ya vinculada al mismo entorno y conserva la cuarentena. Crear la organización inicial con `pnpm admin:bootstrap`; guardar su UUID como `OPS_AUDIT_TENANT_ID`. Para cualquier kill/release/atestación se exige `OPS_CHANGE_REASON` con ticket y motivo de al menos 10 caracteres. Configurar esas variables en el entorno operativo o `.env.local` local, sin publicar valores.

```bash
pnpm ops:control kill
pnpm ops:control release
```

`kill` bloquea nuevas reclamaciones de trabajos y efectos externos. No cancela una petición ya enviada. El heartbeat continúa; `/v1/ready` y el monitor privado devuelven 503 mientras hay cuarentena. No es una desconexión de lectura de todas las rutas: para un incidente de exposición, suspender también tráfico y sesiones en infraestructura.

En producción, el CLI de migraciones exige `LEGACY_WORKERS_STOPPED=true`, motivo revisado y, si existe la tabla, vinculación production y cuarentena activa. **La variable es una atestación humana, no detiene procesos.** Antes de establecerla hay que deshabilitar cron y drenar/detener funciones y workers anteriores, incluido el desarrollo conectado a esa base. Una versión antigua no conoce esta cuarentena ni las nuevas reservas de costo. Para la primera actualización desde versiones sin `deployment_state`, detenerlas es indispensable. Usar ventana de mantenimiento para esta migración; no prometer disponibilidad continua.

En producción `release` exige `RELEASE_EVIDENCE_FILE` basado en `ops/release-evidence.example.json`, SHA revisado, ticket, revisión de accesos/permisos/allowlist/limitaciones estadísticas/PITR, backup atestado de menos de un día y simulacro atestado de menos de 30 días. Las plantillas contienen false y campos vacíos. Completarlas requiere evidencia, no constituye evidencia por sí mismo.

Para atestar el simulacro real en la base de origen, definir `DRILL_EVIDENCE_FILE` y usar:

```bash
pnpm ops:control attest-drill
```

El archivo sigue `ops/drill-evidence.example.json`: debe ser reciente, no sintético, referenciar hash del archivo productivo restaurado y acreditar RLS, claves, manipulación, cuarentena, fencing y RPO/RTO. El operador adjunta mediciones y ubicación de evidencia al ticket. Iniciar una restauración no acredita un simulacro exitoso; la restauración borra esa marca y el ejemplo de CI no permite liberar producción.

## 4. CI y despliegue progresivo

CI usa Postgres 17 aislado, instala con lockfile, ejecuta tipos, lint, unitarias/integración/contratos, build, enlaces, E2E, carga, recuperación, auditoría de dependencias y gitleaks. Las acciones están fijadas a commits. No recibe secretos Meta/LLM. Los artefactos públicos al repositorio se limitan a resultados JSON; cookies, volcados, claves y datos reales quedan fuera. Dependabot propone actualizaciones semanales, sin auto-merge.

El workflow manual `deploy-controlled` exige main, CI exitosa para el mismo SHA, proyectos distintos, ticket y revisión configurada. Cada proyecto usa su propio entorno Vercel `production`; staging es un proyecto separado, no el alias de preview de producción. La credencial DDL solo existe en el paso de migración. La función carga el runtime sin esa credencial.

Secuencia operativa:

1. Ejecutar `candidate` contra staging. Validar rutas SPA, estáticos, sesión Google real, cookies, CSRF, tenant y alcance, `/v1/ready`, monitor privado y cron. Validar también timeout/pool en Neon, que no se reprodujeron localmente.
2. Completar siete días de sincronización y conciliación con Ads Manager; comprobar cuota, alertas y recuperación. Resolver los bloqueos del informe antes de producción.
3. En mantenimiento de producción: congelar escrituras, correo y nuevas llamadas LLM; drenar workers; backup confirmado; aplicar `candidate` con flags operativos revisados. La migración es hacia adelante y compartida entre candidatos; comprobar compatibilidad con la versión anterior.
4. El candidato usa `--skip-domain`: no asigna el dominio automáticamente. Validar el candidato y liberar la cuarentena solo con evidencia vigente. Mantener Meta/correo desactivados y allowlist vacía durante el primer despliegue de lectura.
5. Usar `configure-rollout`, después `start-rollout` con ID `dpl_...`; avanzar manualmente 5 % → 25 % → 100 %. Comprobar errores, latencia fría/caliente, 429/190, cola, costos y duplicados en cada paso. Espera propuesta: al menos 30 min y una ventana de sincronización por paso; aún no calibrada con tráfico real.
6. Ante regresión, `abort-rollout`, congelar efectos externos y volver al deployment anterior compatible. Si el esquema ya no es compatible, mantenimiento y corrección hacia adelante. No ejecutar una migración SQL inversa improvisada ni restaurar la base para deshacer un cambio de frontend.

Los comandos del workflow siguen la [CLI oficial de rolling release](https://vercel.com/docs/cli/rolling-release). Evitar `promote` durante la progresión: puede enviar el 100 % del tráfico. La viabilidad del adaptador Fastify, rewrites, protección de deployments y canary en el plan contratado permanece pendiente de una ejecución cloud. El porcentaje de tráfico no aísla cron ni escrituras: la allowlist de tenants y las aprobaciones siguen siendo obligatorias.

## 5. Observabilidad y alertas técnicas

`/operaciones` y `GET /v1/operations` solo owner/admin: heartbeat, colas por estado/antigüedad, sincronizaciones y cuotas, fallos, conexiones inválidas, envíos ambiguos, uso LLM y reservas, antigüedad del backup/simulacro y cuarentena. Cada organización ve únicamente su evidencia. `technical_incidents` deduplica por tenant y código y registra transiciones en `audit_log`; las actualizaciones repetidas no generan eventos nuevos.

`GET /v1/internal/operations` exige `Authorization: Bearer` con `OPS_MONITOR_SECRET`, distinto de cron. No expone IDs de clientes ni organizaciones. Devuelve 503 por cuarentena, heartbeat mayor de 15 min, trabajos atrasados, backup mayor de 26 h o simulacro mayor de 30 días. El workflow `external-health` comprueba este endpoint y `/v1/ready`; habilitar con `OPS_MONITOR_ENABLED=true` solo tras configurar URL, secreto, guardia y manejo de fallos. GitHub schedule puede retrasarse y no es un monitor de SLA. Para guardia productiva contratar/configurar un monitor independiente con canal autorizado y escalar si falla el propio monitor.

Logs JSON incluyen request ID, operación, resultado y duración; el serializador elimina secretos, prompts, payloads y parámetros, incluyendo errores anidados. No registrar cuerpos HTTP ni respuestas completas de proveedores. El panel no sustituye trazas distribuidas ni métricas de infraestructura: exportación a un backend de observabilidad, retención y alertas de CPU/memoria/conexiones/facturación siguen pendientes de provisión. Los rate limits HTTP y caché son por instancia; no son límites globales distribuidos.

Umbrales iniciales propuestos para guardia: 5xx >1 %/5 min, p95 de lecturas calientes >1,5 s/15 min, cartera fría >3 s/15 min, utilización de cuota >75 %/15 min, datos >90 min sin actualizar y cualquier resultado de escritura desconocido. Medir volumen mínimo, agrupar por causa/tenant y enfriar 30 min; revisarlos durante staging. El código ya alerta estado operativo y ambigüedad; estos SLO de infraestructura requieren medición externa y no se presentan como alarmas desplegadas.

El subsistema de negocio se documenta en [MONITORING.md](MONITORING.md): reglas, ventanas, severidad, silencios y cupos, outbox sin reenvío ambiguo, seguimiento y reportes. Correo solo llega a miembros autorizados configurados, con revalidación al entregar. No se han enviado mensajes reales durante esta auditoría.

## 6. Backup y restauración

El workflow `encrypted-backup` está desactivado hasta `BACKUPS_ENABLED=true`. Corre una vez por noche, instala cliente PostgreSQL 17, usa OIDC a S3, cifra antes de subir y solo marca backup vigente después de verificar HeadObject: SHA en metadatos, longitud, versión y Object Lock con al menos siete días de retención restante. La plantilla propone 30 días. Un archivo local no actualiza `backup_at`. El recibo procede de S3 autenticado; el CLI no convierte un JSON escrito a mano en prueba independiente.

Preparación manual: `BACKUP_DATABASE_URL`, `APP_ENV`, `BACKUP_ENCRYPTION_KEY` (32 bytes base64), `BACKUP_DIRECTORY`. Usar conexión directa para herramientas PostgreSQL; nunca la URL del pool de transacciones para DDL/dumps. Guardar las claves de archivo y sus versiones en un gestor separado del bucket. Custodiar también todas las versiones activas de `TOKEN_ENCRYPTION_KEYS`: descifrar el archivo no basta para recuperar los tokens internos. La cabecera de archivo v1 no identifica una versión de clave maestra: registrar esa correspondencia fuera del archivo antes de rotar.

```bash
pnpm ops:backup
```

El formato `.aab` contiene pg_dump custom comprimido, cabecera autenticada AES-256-GCM, nonce aleatorio y etiqueta. Metadatos JSON contienen tamaño y SHA256. No publicar archivos ni claves en artefactos CI. La exportación es una instantánea consistente de PostgreSQL; cambios posteriores a la instantánea no están incluidos.

Restaurar solo en una base nueva vacía y aislada, con roles previamente creados, PostgreSQL compatible y URL operativa `RESTORE_DATABASE_URL`. Definir `BACKUP_ARCHIVE`, clave correcta y `APP_ENV` objetivo:

```bash
pnpm ops:restore
```

El comando autentica el archivo completo antes de ejecutar SQL. No sobrescribe tablas existentes. Conserva ACL, aplica objetos como `app_owner`, deja cuarentena y elimina sesiones/invitaciones pendientes. Cancela jobs, vuelve desconocidas las escrituras en vuelo y reservas LLM, cancela correo pendiente y marca desconocido el que estaba enviándose. No reenvía acciones por restaurar un backup.

Para una rama restaurada por PITR, antes de tráfico ejecutar `quarantineRestore` desde una sesión operativa auditada: restaurar un punto antiguo puede recuperar una marca de aprobación o `recovery_mode=false`. No apuntar la aplicación al resultado hasta completar esa cuarentena y verificar las migraciones.

Verificaciones obligatorias del operador: tablas y conteos; RLS entre dos tenants con `app_rw`; descifrado de un token canario; verificación de permisos reales Meta; revocaciones de miembros y consentimientos posteriores al backup; sesiones; propuestas/envíos ambiguos; reservas LLM contra facturación del proveedor; jobs recurrentes solo recreados explícitamente; observabilidad y un ciclo sin efectos externos. Conciliar Meta mediante lectura, nunca repetir POST porque su respuesta se haya perdido. Después ejecutar el simulacro completo con tiempos desde la declaración del incidente, atestar y solicitar la liberación técnica revisada.

```bash
pnpm ops:recovery-drill
```

Este último comando **solo** prueba bases sintéticas locales de nombres aleatorios `ad_astra_drill_*` y las elimina al terminar. Mide cifrado/restauración, manipulación, claves, RLS, fencing y bloqueo de cola. No acredita disponibilidad de S3, PITR ni el RTO de una base productiva.

## 7. Plan de incidentes

| Nivel | Ejemplos | Respuesta propuesta |
|---|---|---|
| SEV1 | Exposición entre tenants, token expuesto, escritura Meta no autorizada, corrupción | Responsable de incidente inmediato; guardia confirma en 15 min; congelar efectos, tráfico afectado y accesos; actualizaciones cada 30 min |
| SEV2 | Cola detenida, ingesta >90 min, cuota agotada, backup fallido/antiguo, proveedor caído | Confirmar en 30 min; diagnosticar por request/job/tenant; contener y recuperar sin reenvíos ambiguos |
| SEV3 | Regresión aislada sin pérdida ni escritura, baja utilidad de regla | Ticket priorizado; corrección y validación antes de ampliar el canary |

Los tiempos son objetivos de organización, no cobertura 24/7 actualmente contratada. Mantener contactos y canal autorizados en el gestor operativo; no en el repositorio público ni en prompts LLM.

Secuencia: declarar incidente y propietario; conservar logs redactados y evidencias inmutables; activar kill; para credenciales revocar en proveedor y rotar; detener cron/drain; revisar alcance y llamadas en vuelo; decidir corrección/abort o restauración aislada; conciliar estados externos y accesos; ejecutar pruebas de no regresión y validar evidencia de recuperación; liberar progresivamente; comunicar a afectados por responsables autorizados conforme a obligaciones aplicables; cerrar con postmortem en cinco días hábiles y tareas con propietario/fecha. El agente no envía comunicaciones externas por la existencia de este runbook.

Revertir una pausa/activación o presupuesto requiere una nueva propuesta y un diff actual. No recupera gasto, impresiones, subastas, aprendizaje, leads perdidos ni entregabilidad de correo. Eliminar una reserva de costo sin factura conciliada tampoco revierte una inferencia ya cobrada. Ante resultado desconocido, mantenerlo bloqueado y conciliar antes de decidir.
