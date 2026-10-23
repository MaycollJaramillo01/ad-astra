# Estrategia de pruebas — Ad Astra

> Versión 0.1 · 2026-10-23. Las pruebas son parte de la definición de terminado ([MASTER_PLAN §11](MASTER_PLAN.md#11-principios-de-ingeniería-y-reglas-de-ejecución)). Los criterios de aceptación de cada fase están en [ROADMAP.md](ROADMAP.md) (identificadores `CA-Fx-nn`).

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
| Integración | Repositorios + Postgres (roles, RLS, upserts, particiones), trabajos del `tick`, API con Fastify `inject` | Vitest + Postgres en Docker (puerto 55432) o servicio de la CI | Cada PR |
| Contrato con Meta | Campos pedidos ⊆ specs de la versión fijada; parseo de fixtures v26 sanitizadas; respuestas de error | Vitest + snapshot de `api_specs` + `fetch` inyectado en el cliente | Cada PR |
| Documentación | Enlaces relativos y anclas entre los documentos de `docs/` | `pnpm docs:check` | Cada PR |
| Contrato propio | OpenAPI generado frente al anterior (cambios incompatibles); respuestas sin campos secretos | Script en la CI | Cada PR |
| Arquitectura | Reglas de dependencia entre módulos (`ai` no importa `meta` ni `optimization`; solo `optimization` escribe en Meta) | Test de grafo de imports | Cada PR |
| Seguridad | RLS cruzado en todas las tablas, autorización por endpoint, test canario de tokens, cabeceras, límites de peticiones | Vitest + Playwright | Cada PR |
| End-to-end | Flujos críticos en el navegador | Playwright (+ axe para accesibilidad) | PR a `main` |
| Rendimiento | p95 de dashboards con el dataset sintético de referencia | Script de carga (autocannon o k6) | Cierre de fase |
| Estadística y modelos | Recuperación de parámetros, tasa de falsos positivos, calibración, backtesting | Vitest con semillas | Cada PR (rápidas) y cierre de fase (completas) |
| Evals de IA (F4) | Exactitud de cifras, lenguaje no causal, cobertura de la pregunta, inyección | Script de evals con resultados versionados | Cambios de prompt o de modelo, y cierre de fase |
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
| — | F0 | Workflow de GitHub Actions | Pendiente: sin remoto todavía (TD-07) |
| — | F0 | Spike contra Meta real (CA-F0-02 a 05) | Pendiente: ejecución manual autorizada por el responsable |

## 9. Pruebas manuales autorizadas

**Procedimiento:**
1. Solicitud escrita del equipo: objetivo, cuenta(s), operaciones (lectura o escritura), datos que se guardarán y duración.
2. Autorización explícita del responsable para esa prueba concreta.
3. Token en una variable de entorno local, nunca en archivos del repositorio; se ejecuta el script del spike o el procedimiento acordado.
4. Sanitización y revisión de cualquier salida que vaya a guardarse.
5. Registro en la tabla siguiente.

| Fecha | Prueba | Cuenta(s) (alias) | Autorizada por | Resultado | Evidencia |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
