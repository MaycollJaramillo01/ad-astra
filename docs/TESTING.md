# Estrategia de pruebas — Ad Astra

> Versión 0.1 · 2026-10-23. Las pruebas son parte de la definición de terminado ([MASTER_PLAN §11](MASTER_PLAN.md#11-principios-de-ingeniería-y-reglas-de-ejecución)). Los criterios de aceptación de cada fase están en [ROADMAP.md](ROADMAP.md) (identificadores `CA-Fx-nn`).

Auditoría 2026-10-26: **346 pruebas/37 archivos, 5 E2E**, carga local y simulacro de recuperación. Evidencia, criterios pendientes y límites en [PRODUCTION_READINESS_2026-10-26.md](PRODUCTION_READINESS_2026-10-26.md). Proveedores externos, despliegue cloud y callback Google real no se sustituyen por estas pruebas.

## 1. Principios

1. **Sin credenciales reales en pruebas automatizadas ni en la CI.** Las pruebas contra Meta real son manuales, autorizadas explícitamente y registradas (§9).
2. **Sin simulaciones silenciosas.** Los mocks solo existen en el código de test; en la aplicación, cualquier dato de demostración se etiqueta como tal.
3. **Determinismo:** las funciones de métricas, reglas, salud y modelos se prueban con entradas fijas y salidas esperadas (golden files). Las pruebas estadísticas usan semillas fijas.
4. **Probar en la frontera real:** la integración se prueba con Postgres real (RLS, particiones, transacciones), no con dobles de la BD.
5. **Contratos explícitos:** con Meta (campos y formas de respuesta) y con nuestra propia API (OpenAPI).
6. **Una prueba por comportamiento que importa:** sin suites por función "por si acaso"; cada lógica no trivial (rama, bucle, parser, dinero, seguridad) deja al menos una prueba que falla si se rompe.

## 2. Pirámide y herramientas

| Nivel | Qué cubre | Herramienta | Dónde corre |
|---|---|---|---|
| Unitarias | Métricas, reglas, salud, estadística, gobernador, clasificación de errores, cifrado, redacción, verificador de cifras | Vitest | Cada commit |
| Integración | Postgres real (roles, RLS, FK compuestas; más adelante upserts, particiones y el `tick`) y API con Fastify `inject`. La identidad se sustituye por una cabecera de test; todo lo demás es real | Vitest + BD `ad_astra_test` (Docker en el puerto 55432 o servicio de la CI), migrada y vaciada al empezar | Cada PR |
| Contrato con Meta | Campos pedidos ⊆ specs de la versión fijada; parseo de fixtures v26 sanitizadas; respuestas de error | Vitest + snapshot de `api_specs` + `fetch` inyectado en el cliente | Cada PR |
| Documentación | Enlaces relativos y anclas entre los documentos de `docs/` | `pnpm docs:check` | Cada PR |
| Contrato propio | OpenAPI generado, schemas de respuesta y respuestas sin campos secretos | Vitest; diff automatizado frente a una versión publicada aún pendiente | Cada PR |
| Arquitectura | Reglas de dependencia entre módulos (`ai` no importa `meta` ni `optimization`; solo `optimization` escribe en Meta) | Test de grafo de imports | Cada PR |
| Seguridad | RLS cruzado en todas las tablas, autorización por endpoint, test canario de tokens, cabeceras, límites de peticiones | Vitest + Playwright | Cada PR |
| End-to-end | Flujos críticos en el navegador | Playwright (+ axe para accesibilidad) | PR a `main` |
| Rendimiento | p95 frío/caliente de dashboards con dataset sintético de referencia | `pnpm test:load`, HTTP con diez peticiones concurrentes | CI y cierre de fase |
| Estadística y modelos | Recuperación de parámetros, tasa de falsos positivos, calibración, backtesting | Vitest con semillas | Cada PR (rápidas) y cierre de fase (completas) |
| Evals de IA (F4) | Exactitud de cifras, lenguaje no causal, cobertura de la pregunta, inyección | Deterministas con un proveedor guionizado (`test/ai.test.ts`, cada PR) y en vivo con el modelo real (`pnpm ai:eval`, manual y autorizada, §10) | Cada PR; en vivo, en cambios de prompt o de modelo y al cierre de fase |
| Manuales autorizadas | Spike, conciliación con Ads Manager, escrituras en sandbox | Procedimiento §9 | Cuando se planifica |

## 3. Entornos y datos de prueba

| Tipo de dato | Origen | Uso | Reglas |
|---|---|---|---|
| Sintéticos | Generador propio (F1): cuentas, entidades e insights diarios con estacionalidad semanal, ruido de Poisson y cambios de régimen inyectados | Unitarias, integración, rendimiento, estadística | Semilla fija; parámetros conocidos para poder recuperar |
| Fixtures sanitizadas de Meta | Respuestas reales del spike (V-xx), sanitizadas | Contrato e integración | Se sustituyen los IDs por valores ficticios estables, se borran nombres, textos, URLs y tokens, y se escalan los importes; revisión manual antes del commit; carpeta `test/fixtures/meta/v26.0/` |
| Cuenta sandbox de Meta | Si existe (V-06) | Escrituras de F5 | Solo pruebas manuales autorizadas |
| Cuentas reales | Clientes con consentimiento | Conciliación y piloto | Solo lectura; nunca en la CI |

## 4. Pruebas por área

- **Métricas (F2):** golden por métrica; propiedad "ratio de sumas ≠ promedio de ratios" con casos construidos; `null` frente a `0`; el alcance no se suma; conversión de unidades menores con monedas de 0 y 2 decimales.
- **Ingesta (F1):** paginación (incluido el fallo a mitad → `partial`); "too much data" → división; sondeo asíncrono con temporizadores falsos (completado, fallido, saltado); lotes con subrespuestas mixtas; idempotencia; reexpresión que cambia valores; `is_final`.
- **Gobernador (F1):** parseo de las cabeceras de uso; bloqueos por ámbito; reprogramación sin consumir reintentos; respuesta a cada código de la taxonomía.
- **Cifrado (F1):** ida y vuelta; AAD alterado → fallo; nonce único; rotación de la clave maestra con recifrado.
- **RLS (F1):** cobertura del catálogo de tablas; lectura y escritura cruzadas; contexto ausente → 0 filas; la API con el ID de otro tenant → 404.
- **Reglas (F3):** casos dispara / no dispara / datos insuficientes por regla; FDR en ejecuciones con muchas entidades; tasa de falsos positivos ≤ nivel nominal con datos sintéticos sin anomalías.
- **Salud (F3):** recálculo desde los componentes guardados; cobertura < 0,6 → `null`; contracción con muestras pequeñas (cerca de 80 y confianza baja); monotonía (mejor CPR → mayor puntuación).
- **IA (F4):** verificador con cifras inventadas, redondeadas y con formatos locales; inventario de herramientas; alcance por tenant y RBAC; inyección (nombres de campaña tipo "ignora las instrucciones…", documentos con instrucciones ocultas, datos de otro tenant solicitados); presupuesto.
- **Optimización (F5):** máquina de estados completa; guardrails; idempotencia ante caídas; separación de funciones; kill switch; reversión.
- **Modelos (F6):** backtesting de origen móvil; MASE frente al baseline; calibración; anomalías inyectadas.

## 5. Política de credenciales y datos reales

- La CI no tiene acceso a tokens de Meta ni a claves LLM de producción. Las claves LLM de evals son de un espacio de trabajo separado, con presupuesto limitado.
- Los fixtures se sanitizan con un script y se revisan manualmente. El escaneo de secretos de la CI bloquea patrones de token.
- Las pruebas manuales contra cuentas reales requieren la autorización explícita del responsable para esa prueba concreta y se registran en §9.
- Nunca se ejecutan escrituras contra cuentas reales de clientes en pruebas: solo en sandbox o, si no existe, en una cuenta propia de la agencia sin gasto activo y con autorización explícita.

## 6. Puertas de la CI

Un PR no se integra si falla cualquiera de estas comprobaciones: typecheck · lint · unitarias · integración · contrato con Meta · contrato propio (o cambio incompatible aprobado) · arquitectura · seguridad (RLS, canario, autorización) · auditoría de dependencias (vulnerabilidades altas) · escaneo de secretos · build. Los e2e son obligatorios en los PR a `main`.

Cobertura: sin umbral global (incentiva tests inútiles). Se exige que la lógica de dinero, seguridad, reglas, salud y estadística tenga tests de comportamiento revisados en el PR.

## 7. Catálogo de criterios de aceptación

| Fase | Criterios | Dónde se demuestran |
|---|---|---|
| F0 | CA-F0-01 … 06 | CI + ejecución manual del spike (§9) |
| F1 | CA-F1-01 … 08 | CI + staging durante 7 días |
| F2 | CA-F2-01 … 06 | CI + conciliación manual + carga |
| F3 | CA-F3-01 … 06 y CA-MVP | CI + piloto de 2 semanas |
| F4 | CA-F4-01 … 06 | Evals + CI + piloto |
| F5 | CA-F5-01 … 05 | CI + sandbox |
| F6 | CA-F6-01 … 04 | Informes de backtest |

## 8. Registro de resultados

Cada fase añade aquí una entrada al cerrar: fecha, commit, resultado por criterio (✓, ✗ o aplazado, con su motivo) y enlaces a los informes.

| Fecha | Fase | Verificación | Resultado |
|---|---|---|---|
| 2026-10-23 | Planificación | Los 6 repositorios candidatos existen; licencia, actividad, dependencias y código revisados con la API de GitHub | ✓ (ADR-014) |
| 2026-10-23 | Planificación | Campos de los objetos del MVP comprobados contra las specs oficiales (`api_specs`) | ✓ con una corrección: `targeting_automation` es un subcampo de `targeting`, no un campo de AdSet |
| 2026-10-23 | Planificación | Enlaces relativos y anclas entre los 9 documentos (script con el algoritmo de anclas de GitHub) | ✓ 43 enlaces, 0 errores |
| 2026-10-23 | Planificación | Sintaxis de los 11 diagramas Mermaid con `mermaid.parse()` (mermaid 11.4.1) | ✓ tras corregir 1: un `;` dentro de una nota de `sequenceDiagram` cortaba la instrucción |
| 2026-10-23 | F0 (parcial) | `pnpm typecheck`, `pnpm lint`, `pnpm test` (unitarias, contrato con las specs v26, canario de tokens, roles de BD en Postgres 17 real) y `pnpm docs:check` en local | ✓ (detalle de la cifra de tests en CHANGELOG) |
| 2026-10-23 | F0 (parcial) | Script de roles (`db/init/01-roles.sql`) sobre un Postgres 17 limpio, como en la CI | ✓ |
| 2026-10-23 | F0 (parcial) | `pnpm audit --audit-level high` | ✓ sin vulnerabilidades conocidas |
| 2026-10-23 | F0 (parcial) | Primera ejecución del workflow de GitHub Actions (run 40007312436, commit `bbc6ba1`): job `check` (typecheck, lint, 51 tests con Postgres 17 de servicio, `docs:check`, auditoría de dependencias) y job `secrets` (gitleaks) | ✓ ambos jobs en verde (TD-07 resuelto) |
| 2026-10-24 | F0 | Spike contra Meta real, autorizado por el responsable (2 ejecuciones; la segunda con 17 cuentas asignadas y una cuenta de cliente bajo prueba). Detalle por punto en API_INTEGRATIONS §1.22 | ✓ todos los pasos; V-01, V-02 y V-07 cerrados |
| 2026-10-24 | F0 | CA-F0-03: búsqueda del token y del app secret en el log, el informe, el CSV y las fixtures | ✓ 0 coincidencias |
| 2026-10-24 | F0 | Consistencia de los hechos: gasto e impresiones de 30 días iguales en los 4 niveles y la suma diaria igual al total; filas reales pasadas por el extractor de KPIs sin marcas `results_unparsed` | ✓ |
| — | F0 | CA-F0-02: conciliación diaria con Ads Manager (`spike-output/reconciliacion.csv`) | Pendiente: comparación del responsable |
| 2026-10-23 | F1 base | Suite completa: 94 tests en 13 archivos. Aislamiento en BD (`rls.test.ts`, 13), seguridad de la API (`api-security.test.ts`, 13), token canario por la API (`connections.test.ts`, 4), autenticación con Better Auth real (`auth.test.ts`, 7), errores y contrato (`api-basics.test.ts`, 2), cifrado (3), configuración (3) y los de F0 | ✓ |
| 2026-10-23 | F1 base | Pruebas de mutación: (1) quitar el alcance por cliente → falla 1 test; (2) confiar en `x-tenant-id` sin verificar la membresía → fallan 2 tests | ✓ las defensas están cubiertas |
| 2026-10-23 | F1 base | Regresión detectada por la suite durante un refactor (404 convertido en 500 al revocar) | ✓ corregida antes de terminar |
| 2026-10-23 | F1 base | Prueba manual en el navegador integrado contra la API y la BD de desarrollo: login, sesión, alta de cliente, alta de conexión con token ficticio (solo se muestra la huella) y logs sin el token | ✓ |
| — | F1 base | Login completo con Google | Pendiente: necesita el cliente OAuth "Internal" real del Workspace |
| 2026-10-24 | F1 sync | Suite completa: 137 tests en 18 archivos. Nuevos: cola y tick (`jobs.test.ts`, 11), gobernador (`governor.test.ts`, 4), extracción de Insights y fechas locales (`insights.test.ts`, 7), sincronización completa contra un Meta simulado (`sync.test.ts`, 12: idempotencia, reexpresión, troceo, backfill, consentimiento, throttling, 190, canario y aislamiento) y su API (`sync-api.test.ts`, 6) | ✓ CA-F1-01, 03, 05 y 08; CA-F1-04 salvo la alerta (F3) |
| 2026-10-24 | F1 sync | Pruebas de mutación: (1) tratar el throttling como error reintentable → falla el test de CA-F1-05; (2) reintentar ante un 190 sin invalidar la conexión → falla el de CA-F1-04 | ✓ |
| 2026-10-24 | F1 sync | Prueba en el navegador integrado contra la API y la BD de desarrollo: activar la sincronización de una cuenta encola sus 4 trabajos y desactivarla los cancela; `pnpm dev:worker --once` sin app de Meta se niega a correr | ✓ |
| — | F1 sync | Sincronización con cuentas reales en staging durante 7 días (CA-F1-06, 07) | Pendiente: despliegue y cuentas autorizadas |
| 2026-10-24 | F2 | Catálogo de métricas (`catalog.test.ts`, 11): valor de referencia de las 27 métricas, ratio de sumas frente a promedio de ratios, división entre cero, nulos frente a ceros, alcance no sumable, resultados mezclados, maduración, presets y comparaciones | ✓ CA-F2-01 y 04 |
| 2026-10-24 | F2 | API de analítica (`analytics.test.ts`, 10) contra Postgres: totales, comparación, serie, desglose de resultados, jerarquía hasta el anuncio (incluido lo que ya no aparece en Meta), monedas separadas, alcance por cliente, aislamiento, validación y exportación CSV auditada sin fórmulas | ✓ CA-F2-03 y 06 |
| 2026-10-24 | F2 | Navegador integrado con datos sintéticos "Demo": anomalía plantada rastreada de la cartera al anuncio; gráfico con teclado; tarjetas de definición; diseño móvil sin desbordamiento. Corregidos en la prueba: desbordamiento del gráfico en móvil, negativos marcados como fórmula en el CSV y resultados mezclados en el periodo de comparación | ✓ |
| — | F2 | Conciliación con Ads Manager en 3 cuentas × 3 rangos (CA-F2-02) y p95 con el dataset de referencia (CA-F2-05) | Pendiente |
| 2026-10-24 | F3 | Estadística (`stats.test.ts`, 6): valores conocidos de Γ, Poisson, normal, cuantiles e intervalos; calibración con datos sintéticos: la prueba de Poisson no supera α y Benjamini-Hochberg mantiene el FDR por debajo de q | ✓ |
| 2026-10-24 | F3 | Motor con datos sintéticos (`audit-engine.test.ts`, 32): las 15 reglas con sus estados (dispara, no dispara y datos insuficientes; "no aplica" en las deterministas), perfiles por objetivo, salud (centro de la escala, insuficiencia, recálculo desde componentes, cuenta ponderada, pesos configurables, piso de estabilidad), determinismo, evidencia completa, control de falsos descubrimientos, configuración y tasa de falsos positivos ≤ α en 150 entidades sin efecto | ✓ CA-F3-01, 02 y 03 |
| 2026-10-24 | F3 | Motor de punta a punta (`audit.test.ts`, 8) contra Postgres: ejecución por la API, huella reproducible, sin duplicados, descartes respetados, resolución tras 2 evaluaciones limpias, reapertura, salud guardada y recalculable, alcance por cliente, catálogo publicado y configuración validada que cambia las referencias; y sincronización → auditoría en `sync.test.ts` | ✓ ciclo de vida de CA-F3-04 |
| 2026-10-24 | F3 | Navegador integrado con los datos "Demo": la anomalía plantada aparece en el anuncio, su conjunto y su campaña; corregidos en la prueba un falso positivo de cambio brusco en una campaña en pausa (con test) y una estabilidad que se hundía cuando la cuenta es casi perfectamente estable (con test) | ✓ |

| 2026-10-24 | F4 | Verificador (`answer.test.ts`, 10): cifras en formato español e inglés, escalas y porcentajes, ambigüedad de separadores, evidencia, entidades, hallazgos, fechas, suficiencia, acciones con datos insuficientes, importe propuesto, lenguaje y prioridad | ✓ |
| 2026-10-24 | F4 | Proveedor Anthropic contra un `fetch` falso (`ai-provider.test.ts`, 7): petición (pensamiento adaptativo, esfuerzo, herramientas estrictas sin palabras clave no admitidas, caché, respaldo, sin muestreo), reenvío del contenido nativo y de los mensajes de sistema, normalización, respaldo cobrado al modelo que respondió, rechazo y errores sin la clave | ✓ |
| 2026-10-24 | F4 | Asistente de punta a punta (`ai.test.ts`, 29) con datos sintéticos y un proveedor guionizado: respuesta fiel verificada con uso, costo, traza y evento; segundo turno con el historial idéntico; herramientas sobre los datos (descomposición, hallazgos, salud, comparación a medida); **11 evaluaciones contra respuestas inventadas** (cifra en `figures` o en el texto, evidencia, entidad, hallazgo o fecha inexistentes, garantía, causa afirmada, suficiencia exagerada, acción con datos insuficientes, afirmaciones sin consultar) con un solo turno de corrección; inyección en el nombre de una campaña; otro tenant, cliente sin consentimiento y analista sin clientes; herramientas de escritura inexistentes; límites de llamadas y consultas; rechazo; presupuestos mensual, diario y por pregunta; IA sin clave (503); rol viewer y privacidad de conversaciones; propuesta a la cola y decisión humana; inventario y cierre de importaciones; y en `rls.test.ts`, la privacidad de las conversaciones entre usuarios del mismo tenant | ✓ CA-F4-01, 02 y 04; CA-F4-03 en lo determinista |
| 2026-10-24 | F4 | Navegador integrado con los datos "Demo" y una conversación temporal generada con el proveedor guionizado (borrada después): estados verificado y sin verificar, suficiencia, evidencia, recomendación con prioridad, propuesta a la cola contra la API real, móvil sin desbordamiento y estado "no configurado" sin clave | ✓ |
| — | F4 | Evaluación en vivo con el modelo real (`pnpm ai:eval`) | Pendiente: clave del proveedor y autorización (TD-29) |
| 2026-10-26 | F6 | Suite completa: 278 tests en 29 archivos. Nuevos: pronóstico (`forecast.test.ts`, 13), curvas y Monte Carlo (`simulate.test.ts`, 8) y API de punta a punta contra Postgres (`forecasting.test.ts`, 6); detalle en [FORECASTING §9](FORECASTING.md#9-pruebas-automatizadas) | ✓ CA-F6-01, 02 (como condición de publicación) y 04 |
| 2026-10-26 | F6 | Experimentos con datos sintéticos (`pnpm forecast:experiments`, [FORECASTING §8](FORECASTING.md#8-experimentos)): MAE relativo 0,74–0,88; cobertura diaria del 80 % entre 80 y 84 % salvo tras un cambio de régimen (67 %, que bloquea la publicación); total en horizonte oculto 80–98 %; elasticidad recuperada con cobertura 78–81 %; escenarios con cobertura real que cae con cambios grandes, que motivó las marcas de extrapolación y cambio grande | ✓ (calibrado salvo lo marcado) |
| 2026-10-26 | F6 | Navegador integrado con datos sintéticos "Demo" (borrados después) y respuestas reales de la API obtenidas con el arnés de tests: abanico con días en maduración, ficha del modelo, totales, simulador con +30 %/−50 % y +200 % marcado, móvil sin desbordamiento. Corregidos en la prueba: una curva correcta rechazada por cobertura 17/18 (tolerancia binomial, con test), la barra de navegación que desbordaba en móvil y textos | ✓ (sin el login real: no hay cliente OAuth configurado) |
| — | F6 | Validación con ≥ 6 meses de datos reales | Pendiente: historia real (hoy 27 días) |
| 2026-10-26 | F6, revisión científica | Separación temporal de selección/evaluación, limpieza dentro del corte y conservación de métricas desconocidas. Suite de 297 tests, typecheck, lint, build y enlaces de documentación. Escritorio y móvil con respuestas sintéticas de API: escenario +20 % y bloqueo +300 %, sin errores JS ni desbordamiento | ✓ implementación y regresión; la validación real sigue pendiente |
| 2026-10-26 | F6, experimentos v2 | [Salidas E1–E8](FORECAST_EXPERIMENTS_2026-10-26.md): series estables con MAE relativo 0,76–0,78 y cobertura diaria 82–83 %. E6 falla bajo confusión fuerte (cobertura causal 0 % aun con término supuesto); E7 tiene infracobertura en totales correlacionados (65 %) | Limitaciones empíricas explícitas; simulador exploratorio, sin garantía causal ni de cobertura de agregados |

## 9. Pruebas manuales autorizadas

La implementación del Action Center se probó el 2026-10-26 con Graph simulado: 316 pruebas en 31 archivos, typecheck, lint y build; diff, autorización explícita, quorum y bitácora revisados en escritorio y móvil. Los casos de fallos, concurrencia y reversión constan en [ACTION_CENTER §9](ACTION_CENTER.md#9-validación-y-límites-pendientes). No se ejecutó CA-F5-03 en una cuenta real: sigue pendiente un sandbox autorizado.

**Procedimiento:**
1. Solicitud escrita del equipo: objetivo, cuenta(s), operaciones (lectura o escritura), datos que se guardarán y duración.
2. Autorización explícita del responsable para esa prueba concreta.
3. Token en una variable de entorno local, nunca en archivos del repositorio; se ejecuta el script del spike o el procedimiento acordado.
4. Sanitización y revisión de cualquier salida que vaya a guardarse.
5. Registro en la tabla siguiente.

| Fecha | Prueba | Cuenta(s) (alias) | Autorizada por | Resultado | Evidencia |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## 10. Evaluación en vivo del asistente

`pnpm ai:eval -- --tenant <uuid> --user <uuid> --yes` hace un set fijo de preguntas (rendimiento, explicación, prioridades, una métrica que puede no existir, una predicción que no debe inventar y una orden de pausar que no puede ejecutar) al modelo configurado con los datos de la BD indicada, y muestra por pregunta el estado, las cifras verificadas, los problemas del verificador, si la respuesta afirma haber ejecutado algo y el costo. Gasta dinero: sin `--yes` solo informa del tope (preguntas × `AI_QUESTION_BUDGET_USD`) y sin `ANTHROPIC_API_KEY` se niega. El uso queda en `llm_usage` con `purpose = 'eval'`. Se ejecuta con la autorización del responsable y su resultado se registra en §8.

