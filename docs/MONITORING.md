# Monitoreo, seguimiento e informes

Implementación `monitoring-1`, 2026-10-26. Vista `/monitoreo/:accountId` y API `/v1/monitoring`. Complementa el [motor de auditoría](ARCHITECTURE.md) y el [Action Center](ACTION_CENTER.md). No ejecuta recomendaciones ni escribe en Meta. Las reglas y canales empiezan deshabilitados; una persona con permiso debe guardar la configuración y su motivo.

## 1. Alcance y autorización

Owner y admin configuran cualquier cuenta del tenant; manager configura sus clientes asignados. Analyst puede evaluar, generar informes y decidir incidentes de sus cuentas. Viewer solo lee. Toda lectura, decisión e informe comprueba el alcance de la cuenta además del RLS forzado. Un ID ajeno responde 404. Las ediciones usan revisión optimista; las evaluaciones se serializan por tenant y cuenta con un advisory lock.

El trabajo automático requiere cliente activo y consentimiento `read_insights`. No hay lectura de un CRM conectado en este entorno: calidad de leads y llamadas confirmadas aparecen como **no disponibles**, nunca se deducen de los leads de Meta. Integrar un CRM requiere fuente autorizada, correspondencia verificable campaña/lead, definiciones de calidad y llamada confirmada, fechas del evento y maduración, deduplicación y cobertura; no se incorpora PII por este subsistema.

## 2. Reglas y ventanas

Configuración por cuenta, validada con Zod, con revisión y autorización auditadas. Ventana reciente 1–28 días, baseline 7–84, maduración excluida 1–28. Corte `asOf = fecha local actual − 1 − maturityDays`: excluye el día actual y los días de maduración. La maduración es una hipótesis configurable, no una garantía de completitud.

| Regla | Condición | Datos mínimos / desconocido |
| --- | --- | --- |
| Aumento CPR | `S_r/R_r >= (S_b/R_b) × (1 + umbral/100)` | Cobertura completa de ambas ventanas, gasto mínimo y resultados mínimos en ambas; denominador positivo; mismo KPI/atribución |
| Caída de resultados | `R_r/n_r <= (R_b/n_b) × (1 − umbral/100)` | Cobertura completa, baseline con resultados mínimos, gasto mínimo en ambas, KPI/atribución iguales |
| Gasto sin resultados | `S_r >= max(umbral, gasto mínimo)` y `R_r = 0` | Cero explícito, no null; ventana reciente completa con KPI/atribución conocidos |
| Auditoría | Cantidad de hallazgos abiertos/reconocidos/silenciados por entidad alcanza umbral | Última auditoría exitosa, corte suficiente y terminada hace menos de 48 h; en otro caso desconocido |
| Conexión | Ausente, distinta de activa o expirada | Estado local persistido; no consulta ni valida tokens en vivo |
| Sync obsoleto | Último Insights hace más de umbral horas o nunca sincronizado | Si sync está deshabilitado, desconocido |
| Recomendación pendiente | Abierta/aceptada sin decisión reciente durante umbral días | Usa fecha de decisión si existe; no vuelve a ejecutar ni acepta recomendaciones |
| Acción fallida | Acción en fallo o resultado desconocido creada dentro de umbral días | La condición deja de estar presente al salir de esa ventana; el historial sigue disponible |

`S` es suma de gasto y `R` suma de resultados; CPR se calcula como ratio de sumas. Nunca se promedian CPR diarios ni se suman niveles cuenta/campaña/conjunto/anuncio entre sí. Gasto, leads y compras son campos distintos; resultados Meta representan el KPI identificado, no todas las conversiones posibles.

Un día ausente, null, valor negativo o no finito no equivale a cero. Las métricas con cobertura incompleta se abstienen. Los resultados y CPR requieren un único KPI/atribución conocido y sin flags; leads y compras requieren atribución estable. Un cambio de atribución/KPI impide comparar resultados, sin reescalar ventanas distintas. El gasto completo puede mostrarse aunque no sea posible comparar conversiones.

Los umbrales son condiciones operativas descriptivas. No hay prueba de significación, control FDR ni calibración estadística de falsas alarmas en estas nuevas reglas. El motor de auditoría mantiene su evaluación propia. Los valores predeterminados no están calibrados para una industria o cuenta real. Ventanas 7/28 reducen diferencias semanales, pero estas alertas no ajustan automáticamente tendencia, feriados, promociones ni estacionalidad anual; se revisa su evidencia junto con los eventos externos declarados.

## 3. Incidentes y ruido

Se agrupan varias señales de rendimiento de la misma campaña en un incidente; los hallazgos de auditoría se agrupan por entidad. Las condiciones operativas se agrupan por tipo y cuenta. La clave única es `(tenant, cuenta, categoría:nivel:entidad)`. No reemplaza los hallazgos ni su `finding_events`: los incidentes tienen su propio historial `monitoring_events` y también escriben en `audit_log`.

Estados: `pending → open → acknowledged / snoozed / dismissed`; una condición que desaparece pasa a `resolved` tras N observaciones limpias. Una recurrencia abre otro episodio en la misma identidad. El descarte persiste hasta decisión humana o cambio de revisión de política. Reconocer conserva el incidente; silenciar evita avisos hasta el plazo elegido. Las decisiones necesitan motivo y revisión vigente.

La apertura requiere N observaciones consecutivas con condición; el cierre N limpias. Una señal positiva mantiene abierto el grupo. Solo un grupo con **todas** sus reglas en falso cuenta como limpio; desconocido rompe la racha y no resuelve. Rendimiento/auditoría cuentan como máximo una observación por día local; operaciones, una por franja de 15 minutos. La corrección de datos dentro de la misma observación reemplaza su contribución, sin incrementar la racha dos veces. La huella canónica de las entradas evita duplicar runs idénticos. Una evaluación desconocida conserva la severidad anterior del incidente.

Control de ruido: severidad mínima, persistencia, agrupación por cuenta/destinatario, cooldown 1–168 h, horario silencioso local y máximo 1–24 resúmenes por destinatario/canal/día. Horas iguales desactivan silencio. El cupo cuenta reservas de entregas, incluidas ambiguas; las canceladas no consumen cupo. Un resumen reúne los incidentes elegibles; no se envía un mensaje por señal.

## 4. Canales y entrega

Canales iniciales: aplicación y correo mediante Resend. No existen destinos URL arbitrarios, webhooks o direcciones introducidas libremente. Los destinatarios son miembros con acceso a la cuenta; para email necesitan dirección verificada. El configurador y cada destinatario se revalidan al entregar, junto con revisión, consentimiento, estado del incidente y silencio. Una política nueva cancela entregas de la anterior. Una entrega caducada de un día anterior se cancela y una evaluación posterior puede producir un resumen actual.

Para correo deben configurarse **todos**:

```dotenv
NOTIFICATIONS_EMAIL_ENABLED=true
RESEND_API_KEY=... # secreto solo del servidor
NOTIFICATIONS_FROM=notificaciones@dominio-verificado.example
```

Además, se necesita habilitar email y seleccionar destinatarios en la política. El proveedor debe tener remitente/dominio validado y los acuerdos operativos requeridos. Nunca se usan credenciales reales en las pruebas. El mensaje contiene conteo y enlace autenticado; no incluye gasto, nombres de clientes, datos de leads ni informes adjuntos. Los informes permanecen en la aplicación.

La outbox usa clave única por cuenta, destinatario, canal, revisión y franja. Los trabajos solo transportan IDs. Un lock de entrega y una reserva confirmada antes del HTTP previenen despachos concurrentes. Se envía `Idempotency-Key: ad-astra/<deliveryId>` a un host fijo con timeout y sin redirecciones. Resend conserva idempotencia durante 24 h; esta implementación adopta la política conservadora de **no reenviar automáticamente un resultado ambiguo**. Un reinicio con estado `sending` lo convierte en `unknown`. Debe comprobarse el proveedor antes de cualquier reenvío por fuera del sistema. No hay promesa de exactly-once distribuido ni de llegada a bandeja: `sent` significa aceptado por el proveedor o disponible en aplicación.

Referencias primarias: [envío de email](https://resend.com/docs/api-reference/emails/send-email), [idempotencia y plazo de 24 h](https://resend.com/docs/dashboard/emails/idempotency-keys).

## 5. Seguimiento antes y después

Justo antes de confirmar el marcador de despacho del Action Center, en la misma transacción y antes de su POST, se guarda un plan inmutable, incluso con alertas deshabilitadas. Guarda la entidad, nombres, objetivo/optimización, filas históricas, KPI/atribución, IDs de comparadores, ventanas, fecha y eventos externos conocidos. Si falla la captura, no se envía la operación. La cola revisa el seguimiento cada hora hasta 28 días después de la maduración de la ventana posterior; después sigue consultable y puede regenerarse mediante evaluación/informe manual.

Ventanas de 7, 14 o 28 días. Se excluye el día del envío. La ventana posterior empieza al día siguiente. Si `D` es el día de acción, `n` los días y `m` la maduración:

```text
postStart = D + 1
postEnd = D + n
offset = 7 × ceil((n + 1 + m) / 7)
preStart = postStart − offset
preEnd = preStart + n − 1
```

Así se conservan los mismos días de semana, con separación suficiente para el baseline maduro. No elimina cambios de tendencia ni sesgos por seleccionar ventanas. Solo se calcula delta con ambas ventanas completas, maduras y de la misma firma KPI/atribución.

Selección previa de hasta tres comparadores: mismo nivel, misma familia de objetivo y optimización conocida, otra campaña para evitar compartir el mismo presupuesto, firma idéntica, baseline completo y gasto entre 0,5× y 2× el objetivo. Orden por distancia absoluta logarítmica del gasto y desempate por ID. No usa resultados posteriores. Se conservan los IDs aunque luego falten datos o pierdan comparabilidad; **no se sustituyen** por controles con mejor resultado posterior.

Se muestra cada grupo por separado y la diferencia absoluta observada `post − pre` en gasto, resultados y CPR. No se calcula lift causal, p-valor ni intervalo de efecto. No se ejecuta una diferencia en diferencias como estimador causal: no se han establecido tendencias paralelas ni independencia del tratamiento. Se señalan acciones simultáneas en toda la cuenta, eventos declarados que solapan ventanas, ausencia de confirmación de escritura, datos/KPI/atribución incompatibles, estacionalidad y posibles shocks de mercado, competencia o contagio. Si el día real de despacho difiere del plan por demora o reintento, las ventanas se declaran insuficientes. Acciones antiguas sin baseline se registran como retrospectivas e inadmisibles para esta comparación.

Objetivo y gasto similares no garantizan intercambio entre grupos. Pausar puede causar días sin filas: no se rellenan con ceros para fabricar una mejoría. La confirmación de configuración de Meta no prueba entrega ni resultado comercial. Para una afirmación causal se requiere diseño y análisis adicional adecuado; por ejemplo, asignación aleatoria con medición definida, o identificación cuasiexperimental defendible y comprobada. Véase la discusión metodológica sobre [correlación, causalidad y forecasting](https://otexts.robjhyndman.com/fpp3/regression.html#correlation-causation-and-forecasting).

## 6. Informes

Manual: ventanas de 7/28/84 días maduros. Automático opcional: un informe de 28 días por período de 1/7/28 días del calendario local, con clave única por período (anclado al epoch). No envía correos de informes. Cada snapshot es inmutable y versionado; una corrección posterior de Meta produce un informe distinto.

Ejecutivo: gasto, resultados, leads, compras y CPR del período y del anterior, incidentes abiertos, fallos de acciones del período, próximos pasos y límites. Los valores anteriores son referencias descriptivas; solo comparten interpretación si KPI/atribución son compatibles. No se agrega moneda entre cuentas.

Técnico: series observadas, corte y maduración, reglas, auditoría, estado de hallazgos/recomendaciones/incidentes al generar, acciones del período, seguimientos, eventos externos y bitácora. Las decisiones posteriores al corte maduro se incluyen hasta generación; no se confunden con la ventana de métricas. La UI permite descargar ejecutivo Markdown y técnico JSON; los textos se renderizan escapados. Se conservan hasta 1.000 eventos en cada informe, con indicador de truncamiento, y la API muestra los últimos 300 en la bitácora. El histórico completo persiste en base de datos; exportación paginada de toda la bitácora queda pendiente.

## 7. Operación y API

Aplicar migraciones `0013_monitoring` y `0014_monitoring_rls`. Siete tablas con RLS: políticas, incidentes, eventos, runs, entregas, informes y planes de seguimiento. Eventos/runs/informes impiden UPDATE/DELETE mediante permisos y triggers; el baseline de seguimiento impide modificación y no puede borrarse con `app_rw`. La inmutabilidad protege frente al rol de aplicación, no frente a un propietario con DDL.

| Método / ruta | Uso |
| --- | --- |
| GET `/v1/monitoring/:accountId` | Estado, reglas, últimos runs/informes, seguimientos y notificaciones propias |
| GET `/v1/monitoring/:accountId/recipients` | Miembros elegibles, solo configuradores |
| PUT `/v1/monitoring/:accountId/policy` | Política completa, revisión y motivo de autorización |
| POST `/v1/monitoring/:accountId/evaluate` | Evaluar datos existentes; no sincroniza Meta ni envía correo en línea |
| POST `/v1/monitoring/incidents/:id/decide` | Reconocer, silenciar, descartar o reabrir, con revisión/motivo |
| GET `/v1/monitoring/:accountId/events` | Últimos 300 eventos |
| POST `/v1/monitoring/:accountId/reports` | Guardar snapshot, `days: 7 / 28 / 84` |
| GET `/v1/monitoring/reports/:id` | Leer informe inmutable y comprobar alcance actual |

`monitor_evaluate` usa la cola existente cada 900 s; una revisión de política cancela los trabajos pendientes anteriores y crea uno con clave nueva para no perder una reactivación concurrente. `monitor_notify` drena entregas y `monitor_followup` revisa acciones. El tick/worker existente necesita configuración de Meta y cron activo; sin ellos solo funcionan evaluaciones e informes manuales. No se promete SLA de email de 15 min: influyen persistencia, cadencia del cron, silencio, cupos y proveedor. No hay ingesta del historial externo de cambios de Meta; solo las acciones locales y eventos declarados son observables.

## 8. Experimentos y validación

Casos reproducibles en `src/modules/monitoring/model.test.ts`, `test/monitoring.test.ts` y extensión del recorrido de `test/actions.test.ts`. Solo datos sintéticos y transportes simulados:

| Experimento | Resultado esperado |
| --- | --- |
| Cobertura incompleta / null frente a cero | Abstención; cero explícito puede disparar gasto sin resultados |
| CPR ponderado y caída normalizada | Ratio de sumas y tasas por día; no media de ratios |
| Cambio de atribución/KPI | Sin comparación admisible |
| Baseline y comparadores congelados | Datos futuros no alteran elección ni filas previas |
| Falta posterior de comparador | Mismo ID, sin reemplazo; se marca insuficiente |
| Ventana inmadura / captura retrospectiva | Sin delta admisible |
| Acciones concurrentes y promoción | Advertencias de confusión; `causal=false` |
| Evaluación/entrega concurrentes y reintentos | Una identidad de incidente, una contribución por observación y una entrega |
| Serialización Date → JSONB y orden de claves | Misma huella, sin duplicar eventos al releer snapshots |
| N observaciones de apertura y cierre | Repetir la misma observación no adelanta el estado |
| Alcance, revisión y motivo | Rechazo de acceso ajeno, destinatario sin asignación y edición obsoleta |
| Silencio, cupos y apagado global | Sin despacho no autorizado |
| Envío ambiguo / revocación | No reenvío ciego; cancelación al perder acceso |
| Inmutabilidad de plan/informe/historial | Rechazo por Postgres incluso usando el rol de aplicación |

Estos experimentos verifican el comportamiento del software, no prueban mejoras comerciales ni tasas reales de falsas alertas. Pendientes: piloto con cuentas autorizadas, backtest de ruido por vertical, calibración de umbrales y maduración, prueba real de entregabilidad/SLA, controles de escala para cuentas muy grandes e integración CRM si se conecta una fuente apropiada. No se han enviado notificaciones ni operaciones Meta reales para desarrollar esta capa.
