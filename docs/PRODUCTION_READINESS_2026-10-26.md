# Preparación para producción — auditoría 2026-10-26

**Dictamen: NO listo para producción.** La base funcional puede continuar a staging cuando se provisionen recursos y controles de acceso. Las correcciones y pruebas descritas se implementaron localmente; no se desplegó en Vercel/Neon ni se ejecutaron escrituras Meta, inferencias pagadas o notificaciones reales durante esta auditoría. El responsable confirmó que aún no existen staging ni producción. RPO ≤15 min y RTO ≤4 h son objetivos propuestos, pendientes de aceptación y medición real.

Alcance: árbol de trabajo sobre `c40add913c30ef29ba73367b71a2b27bb7d772d7`, incluyendo el monitoreo previo aún sin commit, backend, SPA, esquema/migraciones 0000–0016, pruebas, workflows y documentación. Los resultados terminaron el 27 de octubre UTC, todavía 26 de octubre en Managua. El informe no certifica la configuración de una cuenta cloud, la seguridad de proveedores ni ausencia de vulnerabilidades desconocidas.

## 1. Hallazgos y correcciones

| Área | Resultado de la revisión | Corrección y evidencia local | Límite residual |
|---|---|---|---|
| Arquitectura | Monolito modular Fastify/React/Drizzle; cola durable en Postgres; motores estadísticos puros | Se conserva una sola cola y se agrega estado operativo, fencing, reservas y panel. Adaptador Node/Fastify probado por HTTP | Vercel/Neon, límite de función, rewrites, cron, pool agregado y región sin validar en cloud |
| Dependencias | `esbuild` 0.18 transitivo por core-utils, incluso vía Better Auth, con aviso GHSA-67mh-4wv8-2f99 | Override a 0.25.12; lock actualizado; auditoría actual con cero avisos conocidos | Advisory DB no prueba ausencia de fallos; revisar overrides con cada actualización |
| Autenticación | Google Workspace, invitación, cookies, sesiones y comprobación de dominio; el proveedor instalado sí verifica `hd` | Se exige email verificado en alta/sesión. Tests con Better Auth real y sesiones firmadas, sin callback Google externo | OAuth Internal, Workspace 2FA, revocación y proxy/cookies reales necesitan staging; step-up para acciones sensibles pendiente |
| Multi-tenancy | FORCE RLS y FK compuestas; el contexto se establece por transacción | Nuevas tablas tenant con RLS; test enumera catálogo completo; rechazo de runtime owner/super/BYPASSRLS; caché vuelve a resolver asignaciones | Roles DDL, superusuario y backup son privilegiados. La auditoría append-only no es inmutable frente al administrador de BD |
| Alcance de IA | Una conversación podía conservar datos de clientes cuyo acceso/consentimiento cambió | Huella de permisos, clientes activos, cuentas y consentimientos; comprobar lectura, traza, reanudación y antes de llamadas/final. Historial legado sin huella deja de ser accesible | Revocar no retira una petición ya transmitida ni el contenido retenido por proveedor; DPA/retención pendientes |
| Presupuesto LLM | Validación por lectura susceptible a concurrencia y reintentos ocultos | Reserva durable por llamada bajo lock tenant; consumo más reservas pendientes/ambiguas cuentan contra topes. SDK sin retry/fallback; modelo desconocido o distinto falla cerrado | La estimación conservadora debe cotejarse con facturas; costo de llamada fallida puede quedar retenido hasta conciliación manual |
| Secretos y logs | Redacción previa no cubría toda anidación/errores | Serialización recursiva, ciclos/profundidad, credenciales PostgreSQL, Bearer, claves API, SQL params, prompts/payloads; canarios y escaneo de fuentes | No se han inspeccionado logs cloud inexistentes ni gestor de claves; superusuarios pueden leer tokens cifrados y claves si se les conceden |
| Permisos Meta | Cliente usa Bearer y appsecret_proof; control de scopes y tareas en Action Center | Revalidación de cuenta/app/task/consentimiento antes de escribir; token 190 detiene trabajos; alerta técnica crítica deduplicada | App Review/Full access/ads_management y cuentas reales no acreditados en producción; acceso anterior no es permiso actual |
| Escrituras | Aprobación y envío remoto no comparten transacción distribuida | Diff vivo, TTL, políticas/versiones, aprobación independiente, importes absolutos, lock de cuenta, marcador durable antes de POST y conciliación por lectura | No se promete exactly-once de Meta. Una llamada en vuelo puede completarse tras kill; no hay rollback de gasto/aprendizaje |
| Resiliencia | Un worker cuyo lease expiró podía confirmar una reclamación posterior | UUID por lease, confirmación condicionada y trigger que impide a workers antiguos cerrar un lease vigente sin liberarlo; cuarentena bloquea claim | La primera actualización exige detener versiones antiguas; fencing no cancela una llamada externa ya iniciada |
| Entornos | No había vinculación verificable base-entorno | `deployment_state`: unbound/recovery inicial; APP_ENV y rol verificados en auth/rutas/tick; runtime no puede quitar cuarentena | La separación física depende de provisión correcta y secrets de cada entorno |
| Rendimiento | Cartera sin caché observada a p95 1.801 ms | Caché acotada 32 entradas/15 s en producción, coalescing, clonación, clave con tenant/usuario/rol/alcance/metadatos/sync; revocación probada | Consulta fría de cartera 2.209 ms; escala de catálogo/tenants y red cloud pendientes |
| Observabilidad | No había una vista técnica y comprobación externa independiente del módulo Meta | `/operaciones`, incidentes técnicos, heartbeat incluso sin Meta, endpoint privado sin IDs; workflows de monitor/backup y runbook | Exportación externa, guardia, notificación técnica, retención y alarmas de infraestructura no provisionadas |
| Recuperación | Copia SQL sin aislamiento de efectos puede reproducir envíos | Archivo AEAD, detección de manipulación antes de SQL, destino vacío, cuarentena, sesiones fuera, jobs cancelados, acciones/envíos ambiguos sin replay | S3, IAM, PITR y recuperación de volumen real pendientes. Iniciar restore no marca simulacro aprobado |
| Estadística | Backtesting y separación temporal correctos en el alcance probado, pero cobertura de totales no universal | Se conserva evidencia y advertencias; forecasting deshabilitado por defecto en producción con flag explícito | MAE relativo no equivale a MASE; faltan datos reales suficientes y validación de agregados correlacionados |
| Seguridad LLM | Herramientas de lectura, schemas, verificación de cifras, límites y defensas ante instrucciones en datos | Fixtures de inyección, alcance, costos y rechazo; IA no dispone de herramientas para escribir Meta | Proveedor guionizado no demuestra resistencia de un modelo real a todas las inyecciones; RAG aprobado aún no implementado |

Los puntos de seguridad se evaluaron también contra [SECURITY.md](SECURITY.md). El runtime usa conexiones con timeout y pool acotado, proxy de confianza limitado al salto inmediato, CSRF por Origin y límites HTTP. Los límites y la caché por instancia no sustituyen un gateway distribuido. Ni los avisos técnicos ni el monitoreo de negocio autorizan una escritura Meta automática.

## 2. Experimentos y pruebas ejecutadas

| Prueba | Resultado | Alcance real |
|---|---|---|
| Unitarias, integración y contratos | **346/346**, 37 archivos | Vitest, Fastify, PostgreSQL 17 real, RLS, RBAC, cifrado, cola, Action Center, monitoreo, IA y estadística. Contratos Meta v26 y proveedor mediante respuestas controladas; sin tráfico a esos proveedores |
| E2E | **5/5** | Chromium, HTTP real, Better Auth/cookies firmadas, lectura/errores/roles, reglas e incidentes, reporte descargado; axe WCAG 2A/AA y 2.1AA sobre el panel, móvil 390 px sin desborde. No Google OAuth externo ni accesibilidad de todas las pantallas |
| Carga cartera | **p95 caliente 132 ms**, p50 76 ms, 121,8 req/s, cero errores en 100 peticiones | Diez concurrentes; primera petición fría **2.209 ms**; caché 15 s |
| Carga campaña | **p95 caliente 79 ms**, p50 71 ms, 138,4 req/s, cero errores en 100 peticiones | Primera petición fría 74 ms; mismo entorno local |
| Recuperación | **3.989 ms total**, **3.051 ms restore**, archivo cifrado 589.727 bytes | Dos tenants sintéticos; manipulación rechazada antes de SQL, token cifrado recuperado, RLS y cuarentena, worker vencido bloqueado y claim prohibido tras restore. No prueba RPO/RTO cloud |
| Dependencias | Cero vulnerabilidades conocidas en `pnpm audit --audit-level moderate` tras corrección | Resultado de registro al ejecutar; sin pentest ni garantía de cero vulnerabilidades |
| Secretos | Cero hallazgos gitleaks sobre fuentes versionadas/nuevas (3,67 MB) y los diez commits de historia (3,24 MB) | Canarios API/logs y escaneos redactados. `.env.local`, archivos reales de spike y dependencias no se publican ni se incluyen en el escaneo de fuentes |
| CI/configuración | Tipos, lint, build y enlaces; actionlint sin errores | Workflows validados estáticamente; shellcheck no disponible. La ejecución remota del workflow todavía requiere publicar el árbol de trabajo |
| Estadística | Ocho experimentos sintéticos reproducibles, semillas fijas | `pnpm forecast:experiments`; evidencia y fórmulas en [experimentos](FORECAST_EXPERIMENTS_2026-10-26.md) y [forecasting](FORECASTING.md) |

Carga: HTTP loopback + Fastify + Better Auth + Postgres, Intel i5-13500/20 CPU lógicas, 50 cuentas ×395 días ×4 niveles = **79.000 filas**. Cada cuenta contiene solo una campaña, un conjunto y un anuncio. No reproduce un catálogo grande, varias organizaciones simultáneas, funciones frías, reconexiones a Neon, Google, proveedores remotos ni siete días de operación. La reducción de p95 caliente demuestra utilidad de la caché para consultas repetidas; no satisface por sí sola el SLO productivo ni el criterio de consulta fría.

Evidencias detalladas locales, ignoradas por git: `spike-output/readiness/unit.json`, `e2e.json`, `load.json`, `recovery.json`, `dependencies.json`, `secrets.json`, `secrets-history.json`, `licenses.json` y `costs.json`. Se conserva en el repositorio este resumen sin cookies, URLs privadas, datos de clientes ni secretos. CI publica solo los JSON seleccionados de pruebas con retención de siete días. Para ejecución nueva seguir [TESTING.md](TESTING.md); no correr Vitest, E2E y carga simultáneamente porque preparan la misma base de tests.

Las migraciones hasta 0016 se aplicaron también a la base local de desarrollo y se vinculó `development`. Se conservó su cuarentena: no se usó una organización de tests para autorizar esa base ni se activaron efectos externos. Antes de su uso interactivo, revisar/bootstrap de la organización y ejecutar la liberación local documentada.

## 3. Calidad estadística y límites de interpretación

Con historia sintética estable, el perfil semanal/ETS superó al ingenuo estacional: medianas de MAE relativo de gasto/leads 0,78/0,76, cobertura diaria nominal 80 % observada 82/83 % y cobertura del total oculto 80/87 %. Es evidencia sintética específica, no error esperado para clientes reales. El ejemplo de tendencia tiene MAE relativo 0,80 y MASE 1,07: las dos métricas no son equivalentes. La desviación del criterio original necesita ratificación explícita.

Los datos reales registrados por el spike contienen 27 días; para un horizonte de 28 días el motor pide 199 días maduros y se abstiene. Escenarios por campaña requieren al menos 18 semanas elegibles, variación de gasto, soporte y backtest. Se mantienen ventanas de maduración, series homogéneas por atribución/moneda/objetivo, segmentación ante cambios, calendario semanal y eventos externos conocidos dentro del corte. No se introduce un evento futuro con información observada después del origen de evaluación.

Riesgos empíricos decisivos: en E7 los totales correlacionados lograron **65 % de cobertura** con intervalos nominales del 80 %; en E6 la recuperación del efecto causal con confusión omitida tuvo **0 % de cobertura** y el diseño aleatorizado/IV sintético alcanzó 75 %, sin ser garantía. El ajuste de una curva y el seguimiento antes/después son asociaciones condicionadas. Grupos congelados, comparadores y advertencias no convierten una acción en experimento aleatorizado. Se muestran factores de confusión y selección, y se bloquea la extrapolación no validada.

La ingesta aún no tiene un ledger diario de completitud: un día sin fila puede interpretarse como cero bajo el supuesto de backfill completo, descrito en la ficha. Es una deuda crítica antes de habilitar previsión real. Las métricas explícitamente desconocidas permanecen nulas. No se infiere calidad de lead, venta ni llamada confirmada sin CRM conectado; la interfaz e informes indican su ausencia. Markov/supervivencia quedan diferidos porque faltan transiciones individuales consentidas y observaciones de etapa/tiempo; no se fabricó un funnel probabilístico con agregados publicitarios. Bayes aproximado y Monte Carlo se usan para incertidumbre condicionada, no para justificar causalidad ni precisión universal.

## 4. Criterios de aceptación: verificación exhaustiva

Estados: **L** = demostrado localmente en el alcance indicado; **P** = parcial o desviación; **B** = bloqueado por datos/infra/permisos; **D** = diferido explícitamente. L no equivale a aceptación de producción. Se revisan los 41 identificadores de [ROADMAP.md](ROADMAP.md), además de salida MVP y verificaciones de integración.

| Criterio | Estado | Evidencia o trabajo faltante |
|---|---|---|
| CA-F0-01 | P | Instalación existente, tipos/tests/build locales y CI preparada. Falta repetir onboarding desde máquina limpia con el nuevo bind/release |
| CA-F0-02 | B | Spike real de 27 días, inferior a 30; conciliación visual completa no acreditada |
| CA-F0-03 | L | Canarios, redacción anidada, gitleaks; no hallazgos en el alcance examinado |
| CA-F0-04 | P | Evidencia redactada histórica de scopes/tasks y development_access; no acredita estado actual ni producción |
| CA-F0-05 | L | V-01…V-14 revisados abajo con respuesta o aplazamiento y criterio de cierre |
| CA-F0-06 | B | App Review/verificación no enviadas; responsable de Meta debe fijar fecha al provisionar staging |
| CA-F1-01 | L | Sync repetido y reexpresión no duplican hechos en PostgreSQL real |
| CA-F1-02 | L | Catálogo de todas las tablas tenant, RLS forzado, aislamiento de lectura/mutación y fallo ante tabla sin protección |
| CA-F1-03 | L | Contratos sin credenciales, canarios de respuesta/log/eventos/sync |
| CA-F1-04 | L | 190 invalida conexión y detiene jobs; nueva alerta técnica crítica deduplicada. No se acredita email real |
| CA-F1-05 | L | Throttling reprograma sin consumir intentos ni duplicar con cabeceras simuladas |
| CA-F1-06 | B | No hay staging; faltan siete días continuos y cuota real <75 % |
| CA-F1-07 | B | Pendiente conciliación Ads Manager 3 cuentas ×3 rangos |
| CA-F1-08 | L | sync_runs/connection guardan ventanas, versión, filas, llamadas, scopes, validación y error redactado |
| CA-F2-01 | L | Catálogo de métricas visible y golden tests de fórmulas/estados |
| CA-F2-02 | B | Igual que F1-07, incluidos resultados y atribución |
| CA-F2-03 | L | E2E muestra dato desconocido como no disponible, sin convertirlo en cero |
| CA-F2-04 | L | Tests de alcance no aditivo: no suma días para rango arbitrario |
| CA-F2-05 | P | p95 caliente bajo objetivo en muestra local; primera cartera 2,209 s y catálogo mínimo. Falta referencia cloud/fría |
| CA-F2-06 | L | Separación por moneda en agregados; no mezcla de totales monetarios |
| CA-F3-01 | P | Reglas implementadas con parámetros/muestras/tres estados probados; catálogo funcional de 15 reglas frente a alcance inicial más amplio |
| CA-F3-02 | L | Hallazgos incluyen evidencia, periodo, referencia, fuente, umbral, muestra, versión, impacto y confianza; revisión de utilidad visual real pendiente |
| CA-F3-03 | L | Datos insuficientes no producen puntuación baja; recomposición desde componentes probada |
| CA-F3-04 | L | Ciclo/dedup y resolución por N evaluaciones; finding_events para hallazgos y monitoring_events para incidentes, separación documentada |
| CA-F3-05 | B | Outbox y canales locales; no correo real ni SLA ≤15 min. Silencios, cupos, cron y caída de proveedor pueden retrasar |
| CA-F3-06 | B | Utilidad ≥70 % exige feedback del piloto; objetivo no bloqueante por sí solo |
| CA-F4-01 | P | Verificador determinista probado; falta set representativo de ≥50 preguntas y revisión con modelo real autorizado |
| CA-F4-02 | L | Herramientas expuestas a IA de lectura; no tienen escritura ni llamada a Meta; propuesta requiere acción humana separada |
| CA-F4-03 | P | Suite guionizada de inyección/alcance pasa; no acredita resistencia del proveedor real o documentos aún inexistentes |
| CA-F4-04 | L | Reservas atómicas, presupuestos por periodo, bloqueo y ambigüedad conservadora probados |
| CA-F4-05 | D | Recuperación de documentos aprobados/RAG no implementada; no se marca cumplido por ausencia del módulo |
| CA-F4-06 | B | Valoración de gestores ≥70 % requiere piloto |
| CA-F5-01 | L | Rutas y tests exigen approved, autorización explícita, proponente/aprobador independiente, política, scopes y consentimiento vigentes |
| CA-F5-02 | L | Snapshots/diff/revisión/resultado y bitácora append-only probados; resultados ambiguos quedan explícitos |
| CA-F5-03 | P | Reversión contra Graph falso pasa; sandbox/cuenta propia sin gasto y autorización concreta aún pendientes |
| CA-F5-04 | L | Kill se comprueba al claim y antes de efectos externos. No revierte llamadas ya transmitidas |
| CA-F5-05 | L | Códigos 613/subcódigos reprograman rechazos explícitos; timeout ambiguo solo concilia por lectura |
| CA-F6-01 | P | Gate MAE relativo estacional <1; MASE se reporta. Desviación respecto a MASE<1 no debe llamarse equivalente |
| CA-F6-02 | P | Gate diario y experimentos de calibración pasan en casos elegibles; agregados correlacionados 65 % fallan el objetivo 70–90 % |
| CA-F6-03 | L | UI muestra supuestos, intervalos nominales, soporte/extrapolación y estimación sin garantía; flag productivo bloquea cálculo |
| CA-F6-04 | L | Recuperación sintética, confusión, soporte y diseños de evaluación probados dentro de supuestos; no valida datos reales |

Salida MVP:

| Condición | Estado |
|---|---|
| F0–F3 completos | B: criterios externos sin acreditar |
| Checklist seguridad F0–F3 | P: controles locales; Workspace 2FA, roles cloud, PITR, gestor de claves, destinatarios y retención pendientes |
| Piloto 2 semanas, ≥3 clientes, sync ≥99 % de días | B: no ejecutado |
| Restauración de backup superada | P: simulacro sintético local, no recuperación cloud |
| Documentación y CHANGELOG 0.4.0 | P: documentación ampliada; no se etiqueta un release MVP sin cumplir lo anterior |

Checklist de seguridad por fase: F0 código/secretos/CI local verificados, validación empresarial pendiente; F1 RLS/cifrado/RBAC/sesiones/cabeceras/CSRF probados, cloud/2FA/PITR pendientes; F2 métricas/monedas/exports probados, conciliación pendiente; F3 dedup/autorización/inmutabilidad probadas, entregabilidad/guardia pendientes; F4 aislamiento/costos/verificador probados, DPA/evals reales/RAG pendientes; F5 aprobaciones/kill/concurrencia probados, permisos/sandbox/step-up pendientes; F6 separación temporal y advertencias probadas, cobertura real y completitud pendientes. No se declara satisfecha la checklist completa.

## 5. V-01 a V-14 y permisos de integración

La evidencia histórica proviene del spike documentado en [API_INTEGRATIONS.md](API_INTEGRATIONS.md). Esta auditoría no repitió llamadas reales ni renovó autorización. Un aplazamiento documentado cierra la revisión documental, no la verificación empírica.

| ID | Estado actual y cierre pendiente | Responsable funcional / hito |
|---|---|---|
| V-01 | Lectura compartida con development_access observada históricamente; repetir con app/cuentas de staging | Administrador Meta / antes del piloto |
| V-02 | Bearer sin token URL confirmado por spike y cliente/tests | Ingeniería / conservar contrato por versión |
| V-03 | Filtro updated_time aceptado, comparación con catálogo completo pendiente; se conserva listado completo | Ingesta / optimización posterior al piloto |
| V-04 | results parseado; equivalencia Ads Manager en tres objetivos pendiente | Analítica / conciliación F2 |
| V-05 | Unidades menores observadas; confirmar acumulados y monedas sin decimales en cuentas autorizadas | Analítica / conciliación F2 |
| V-06 | Sandbox no probado; no se habilitan escrituras reales hasta cuenta de prueba y autorización | Administrador Meta / antes de F5 productivo |
| V-07 | Cabeceras reales conocidas y parser probado; revalidar con nivel de acceso actual | Ingesta / staging |
| V-08 | Misma zona/atribución y tres rangos sin conciliar; sigue bloqueado | Analítica / antes de release |
| V-09 | since 90 días aceptado; paginación completa/antigüedad máxima y job activities diferidos | Ingesta / siguiente incremento |
| V-10 | Solicitudes no enviadas; fijar responsable nominal y fecha una vez creada app de staging | Dueño de negocio/Meta / provisión inicial |
| V-11 | Revisión empírica vigente de sobreentrega/reparto pendiente; no autorizar cambios basados en esos porcentajes | Administrador Meta / antes de reglas de ritmo productivas |
| V-12 | Lectura histórica con DRAFT/ANALYZE/ADVERTISE; mínimos reales de lectura/escritura por validar | Administrador Meta / rotación y staging |
| V-13 | Webhooks diferidos, sin suscripción ni recepción implantada; se usa polling | Integraciones / posterior a piloto |
| V-14 | Calidad EMQ no probada; no se presenta como dato disponible | Integraciones / autorización y conector posterior |

No confundir Full access con permiso de escritura. El [anuncio oficial de Meta](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/) distingue el nivel de acceso, actividad/errores para optar a Full y el proceso asociado. El permiso `ads_management`, la tarea sobre cada cuenta, la autorización del cliente y la aprobación interna siguen siendo requisitos independientes. Los tests prueban rechazo cuando faltan, no su concesión por Meta.

## 6. Riesgos residuales y deuda priorizada

| ID / prioridad | Riesgo | Cierre verificable y responsable |
|---|---|---|
| R-01 / P0 | No existen staging/producción, roles y secretos externos | Plataforma: dos proyectos/bases, smoke completo, separación y registro de configuración |
| R-02 / P0 | Protección de main/entornos no disponible en el plan privado actual (API GitHub 403) | Dueño repositorio: habilitar protección/revisores o control equivalente auditado. No poner APPROVAL_CONFIGURED=true antes |
| R-03 / P0 | App Review, Full access, ads_management y permisos reales sin acreditar | Administrador Meta: evidencia redactada actual y prueba autorizada; mantener META_WRITES_ENABLED=false |
| R-04 / P0 | PITR, backup externo, claves y recuperación real no probados | Plataforma/seguridad: restauración aislada desde S3 y PITR, acceso/retención, RPO/RTO medidos y atestados |
| R-05 / P0 para F6 | Completitud diaria e intervalos agregados/identificación sin validar | Ciencia/ingesta: ledger de cobertura, holdout real maduro, criterios por agregado, revisión estadística; mantener forecasting desactivado |
| R-06 / P1 | Catálogo grande, cold starts y múltiples tenants no medidos | Plataforma: carga en staging con picos, cold cache, async Insights y volumen real; índices/paginación según perfil |
| R-07 / P1 | Límite HTTP y cache locales por instancia; pool10 multiplicado por funciones | Plataforma: gateway/límite distribuido y presupuesto de conexiones Neon medidos |
| R-08 / P1 | Evals LLM reales, DPA/retención y revisión de prompts sin completar | IA/seguridad: eval autorizado con presupuesto, ≥50 preguntas, inyección adversarial y cambios de versión evaluados |
| R-09 / P1 | Alertas técnicas no llegan a guardia, correo sin entregabilidad ni SLA | Operaciones: canales autorizados, prueba de caída de monitor/proveedor, on-call nominada y tiempos medidos |
| R-10 / P1 | Privilegiados pueden alterar bitácora/recibos; clave maestra sin ID de versión en archivo | Seguridad: exportación WORM, separación de claves y roles, catálogo de versiones y pruebas de rotación |
| R-11 / P1 | Restore puede recuperar permisos/consentimientos revocados y estados externos anteriores | Seguridad/operaciones: revisión de accesos y reconciliación obligatoria antes de release; nunca replay automático |
| R-12 / P2 | Actividades/cambios, creatividades, async Insights, RAG y CRM incompletos | Producto/integraciones: alcance por incremento y contratos/datos consentidos; no inferir funciones ausentes |
| R-13 / P2 | Deprecación pg por consultas concurrentes en una misma conexión | Ingeniería: serializar consultas de la misma transacción antes de migrar a pg9; actualmente tests pasan con advertencia |
| R-14 / P2 | Fairness del tick y evaluación técnica limitada por lote; jobs agotados requieren intervención | Plataforma: medir atraso por tenant, paginar y rotar lote, política de DLQ/reconciliación antes de ampliar escala |

Licencias: inventario disponible; predominan MIT/Apache/ISC/BSD y hay MPL-2.0 en herramientas de accesibilidad/build (axe/lightningcss). Conservar avisos y revisar distribución de modificaciones si aplica; no se emitió dictamen jurídico. No se incorporó una dependencia de producción para colas/telemetría ni un servicio contratado sin necesidad demostrada.

## 7. Costos y activación

El modelo reproducible y fuentes están en [OPERATING_COSTS.md](OPERATING_COSTS.md). Un entorno ilustrativo cuesta piloto **87,63–127,63 USD/mes**, agencia **371,63–446,63**, escala **1.688,12–2.088,12**, con los supuestos explícitos de ese documento. Excluye publicidad, impuestos, operación humana, costo de planes de protección y consumo del segundo entorno. Son provisiones de escenarios, sin distribución probabilística ni cotización vinculante. No se ha verificado tarifa Meta por llamada aplicable: no se certifica costo API igual a cero.

Aplicar presupuestos de proveedor y alertas de facturación reales, además del bloqueo LLM interno. Contabilizar todas las iteraciones, caché, reservas ambiguas, GB-h, CU-h, invocaciones, historial, almacenamiento y egress. La reserva evita concurrencia por presupuesto, pero no elimina cargos ya realizados ni uso fuera del sistema.

Secuencia de entrega posterior, ordenada por dependencia:

1. **Puerta A — provisión y seguridad:** resolver R-01/R-02; Google Internal/2FA, roles, región, claves y entorno vinculado. Publicar y ejecutar CI sobre el mismo SHA. Mantener side effects bloqueados.
2. **Puerta B — operación demostrable:** backup/PITR y simulacro cloud, monitor/guardia, siete días de sync, carga y conciliación 3×3. Medir presupuesto real. Salir solo con R-03/R-04 y SLA revisados.
3. **Puerta C — piloto de lectura:** ≥3 clientes autorizados durante dos semanas, ≥99 % de días sincronizados, feedback ≥70 % útil y conciliaciones firmadas. No etiquetar MVP0.4.0 antes de completar sus criterios.
4. **Puerta D — canary de acciones:** evidencia Meta actual, cuenta de prueba sin gasto, rollback técnicamente permitido, step-up revisado; permitir un tenant y operaciones sencillas con aprobación. Revisar ambigüedades antes de ampliar.
5. **Puerta E — IA/forecasting:** eval real y costo; ledger de completitud; holdout real, intervalos de totales, criterio MAE/MASE ratificado y aceptación de límites. Activación explícita de flag; causalidad solo con diseño identificable.
6. **Evolución:** activities/cambios, async/particiones/retención por carga observada, RAG aprobado y CRM consentido; luego 500 cuentas/10 tenants con pruebas de escala y aislamiento. No se declara F7 validado por la carga de 50 cuentas.

Procedimientos, variables, kill/release, canary 5/25/100, backups, restauración y plan de incidentes se detallan en [OPERATIONS.md](OPERATIONS.md). La aprobación final debe referenciar el SHA desplegable, evidencias y riesgos aceptados por sus responsables; este informe no activa esa aprobación.
