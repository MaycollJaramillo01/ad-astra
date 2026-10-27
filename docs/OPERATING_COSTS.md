# Costos operativos y capacidad

Estimación de planificación al 2026-10-26, USD/mes, sin entornos cloud provisionados ni consumo real de proveedores durante estas pruebas. Los rangos siguientes son provisiones de escenarios, no intervalos estadísticos. Ejecutar `pnpm ops:costs` para reproducir fórmulas y generar `spike-output/readiness/costs.json` local. El gasto publicitario de Meta se presupone aparte.

## 1. Tarifas y fórmulas de referencia

| Componente | Referencia usada | Fórmula/limitación |
|---|---|---|
| Vercel Pro | 20 USD por puesto de desarrollador; crédito de uso de equipo de 20 USD | Puestos de quienes despliegan, no usuarios de la agencia. Validar contrato/región y proyectos incluidos. [Precios](https://vercel.com/pricing) |
| Funciones Vercel | CPU activa 0,128 USD/h; memoria provisionada 0,0106 USD/GB-h; invocaciones adicionales 0,60 USD/millón sobre 1 millón | Referencia regional cle1: `20·puestos + max(0, CPUh·0,128 + GBh·0,0106 + max(inv−1e6,0)·0,6e−6 −20)`. Excluye transferencia, logs y otros conceptos. [Funciones](https://vercel.com/docs/functions/usage-and-pricing) |
| Neon Launch | 0,106 USD/CU-h; almacenamiento 0,35 USD/GB-mes; historial de restauración 0,20 USD/GB-mes | `CU·720·0,106 + GB·0,35 + GBhist·0,20`. Supone capacidad activa 24 h: cron/monitor puede impedir scale-to-zero. Facturación real depende de autoscaling, mínimo y ventana PITR. [Neon](https://neon.com/pricing) |
| Claude Opus 5.5 | Por millón: entrada 4 USD, salida 20 USD, escritura caché 5 USD, lectura caché 0,20 USD | El precio se aplica a uso acumulado de todas las iteraciones de una pregunta, no solo su última respuesta. [Claude](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Sonnet 5.5 | Por millón: entrada 2 USD, salida 10 USD, escritura caché 2,50 USD, lectura caché 0,10 USD | Alternativa explícita por configuración tras evals; no se cambia automáticamente de modelo ante rechazo. Misma fuente de precios de Claude. |
| GitHub Actions | Linux estándar de dos núcleos: 0,006 USD/min sobre lo incluido en el plan | Cada job puede facturar un mínimo de un minuto. Comprobar minutos compartidos de la cuenta, runners y revisión de entornos. [Facturación](https://docs.github.com/en/enterprise-cloud%40latest/billing/reference/actions-runner-pricing) |
| S3, correo, monitor, logs | Provisión separada; no hay cotización contratada | Dependen de región, retención, volumen y proveedor. Object Lock/versionado puede conservar varias copias facturables. Cotizar antes de contratar. |
| Meta Marketing API | No se ha verificado una tarifa monetaria por llamada aplicable a esta integración | No asignar costo cero certificado. Hay costo de capacidad, cuota y operación además del gasto publicitario. El nivel Limited/Full y los permisos son restricciones separadas. [Acceso de Meta](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/) |

No se han incluido impuestos, soporte, operación humana, migración de planes, asesoría de privacidad, transferencia de backups ni egress entre regiones. Validar las tarifas otra vez antes del despliegue. El crédito y los límites incluidos no se multiplican por organización de negocio dentro de la aplicación.

## 2. Escenarios reproducibles

Consumo LLM ilustrativo por pregunta, sumando sus llamadas: 30.000 tokens de entrada normal + 3.000 de salida + 10.000 de lectura de caché = **0,182 USD** en Opus 5.5. No incluye escrituras nuevas de caché ni grandes conversaciones; una pregunta puede costar más. Las reservas usan el máximo conservador de entrada/salida y quedan bloqueadas si el proveedor falla ambiguamente.

| Escenario | Cuentas / puestos | Neon CU / GB / GBhist | CPU h / GB-h / invocaciones | Preguntas | Vercel | Neon | LLM | Otros provisionados | Total ilustrativo |
|---|---|---|---|---|---:|---:|---:|---:|---:|
| Piloto | 10 / 1 | 0,25 / 5 / 2 | 1 / 720 / 30.000 | 200 | 20,00 | 21,23 | 36,40 | 10–50 | **87,63–127,63** |
| Agencia | 50 / 2 | 1 / 25 / 20 | 20 / 5.000 / 200.000 | 1.000 | 75,56 | 89,07 | 182,00 | 25–100 | **371,63–446,63** |
| Escala | 500 / 3 | 4 / 200 / 200 | 80 / 20.000 / 2.000.000 | 5.000 | 262,84 | 415,28 | 910,00 | 100–500 | **1.688,12–2.088,12** |

Estos perfiles de CPU/memoria/almacenamiento son supuestos configurables del script, no consumo inferido de las pruebas locales ni capacidad certificada. No prueban que 0,25 CU soporte el piloto ni que 4 CU soporten 500 cuentas. Staging duplica parte del costo fijo y su propio consumo; el total de tabla representa un entorno, no ambos. El presupuesto LLM predeterminado es 100 USD por tenant/mes: el escenario agencia en un solo tenant se bloquearía antes de 1.000 preguntas, salvo ampliación explícita.

## 3. Capacidad y límites de Meta

El script calcula un sobre de llamadas por cuenta: `30·24·4·pInsights + 30·4·pRestatement + 30·4·3·pEntidades + 30`. Supone cuatro niveles, actualizaciones horarias, reexpresión diaria, catálogo cuatro veces/día y validación de token diaria. Los valores de páginas son supuestos: piloto 1/4/1; agencia 3/30/2; escala 10/100/6. El resultado mensual es 37.500, 649.500 y 21.495.000 llamadas respectivamente. Backfill inicial, tareas de permisos, previews/verificación de acciones, reintentos y actividades pueden aumentarlo. La frecuencia efectiva del código y los `sync_runs.api_calls` prevalecen sobre esta aproximación.

Medir cabeceras de uso, porcentaje de throttling, páginas, tiempo por cuenta y atraso de cola. No derivar una cuota universal de esas cifras; Meta aplica límites por app, cuenta y caso de uso. El cambio de acceso requiere validación con la app real. El anuncio oficial de Meta distingue Limited/Full y exige, para optar a Full, actividad reciente y tasa de errores; no equivale a conceder `ads_management`.

## 4. Controles y mediciones pendientes

- Topes LLM por tenant/mes, usuario/día y pregunta con reserva atómica antes de cada llamada; precio desconocido o cambio de modelo falla cerrado. Las reservas ambiguas no caducan automáticamente. Conciliar con factura/usage real y registrar el ajuste con auditoría.
- Panel `/operaciones`: gasto observado, tokens, reservas, fallos y cuotas. Las alertas de facturación del proveedor deben configurarse en sus cuentas; un presupuesto interno no limita cargos ajenos a la aplicación.
- Monitor cada 15 min en GitHub genera aproximadamente 2.880 jobs/mes antes de CI y backups. Aunque duren pocos segundos, considerar minutos mínimos y cupo compartido: no presentarlo como gratis ni como servicio de SLA. Evaluar un monitor dedicado durante provisión.
- La carga local utiliza 79.000 filas y diez solicitudes concurrentes. No mide residencia en Neon, transferencia, funciones frías, picos de varias organizaciones, async Insights ni un pool serverless agregado. Registrar CU-h, CPU-h, GB-h, conexiones, egress, almacenamiento y costo/pregunta durante siete días de staging; extrapolar después con márgenes explícitos.
- Alertas iniciales de presupuesto operativo: 50/80/100 % del techo aprobado por proveedor. Los umbrales de bloqueo LLM son efectivos en el código; los de Vercel/Neon/S3/Actions requieren configuración cloud aún pendiente.

Revisar mensualmente precios y calibración de reservas. Archivar versión del modelo, tarifario, consumo y supuestos con cada decisión de ampliación. No reducir las reservas para disimular una factura superior a la estimación.
