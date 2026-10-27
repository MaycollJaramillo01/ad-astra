# Asistente con NVIDIA NIM

Integración del 2026-10-27. `AI_PROVIDER=nvidia` selecciona el adaptador
`src/modules/ai/nvidia.ts`; `NVIDIA_API_KEY` es una variable sensible exclusiva del servidor.
No se envía al navegador, a las herramientas ni al registro de conversaciones.

## Configuración

```dotenv
AI_PROVIDER=nvidia
AI_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b
AI_EFFORT=low
NVIDIA_API_KEY=<secreto en el gestor del entorno>
NVIDIA_BUDGET_INPUT_USD_PER_MILLION=4
NVIDIA_BUDGET_OUTPUT_USD_PER_MILLION=20
```

El modelo predeterminado depende del proveedor si se omite `AI_MODEL`. Una combinación
incompatible detiene el arranque. Sin la clave del proveedor seleccionado, el asistente queda
desactivado. Anthropic sigue disponible mediante su configuración anterior. Las conversaciones
permanecen vinculadas a su proveedor y modelo: cambiar de proveedor requiere una conversación nueva.

## Contrato y controles

- Endpoint HTTPS fijo `https://integrate.api.nvidia.com/v1/chat/completions`, sin redirecciones.
  Transporte `fetch` nativo, sin dependencias nuevas, streaming desactivado y 90 s de timeout.
- Conserva los mensajes de sistema del operador. Traduce llamadas y resultados de herramientas,
  incluidos los resultados pendientes de `submit_answer` antes de la pregunta siguiente.
- Usa los esquemas JSON de las herramientas existentes. La aplicación vuelve a validar entradas,
  evidencia, cifras, suficiencia y recomendaciones; no confía en la salida del modelo.
- `low` se traduce a `reasoning_effort=low`; los otros esfuerzos a `high`, los niveles admitidos
  por este modelo. No se envían parámetros de Anthropic, instrucciones de caché ni muestreo.
- Solo permite el modelo configurado y el alias observado
  `private/nvidia/nemotron-3.5-super-120b-a12b`. Otro modelo, uso inconsistente, JSON ilegible,
  herramientas desconocidas, argumentos rotos o llamadas incompletas son resultados inciertos.
- No reintenta inferencias automáticamente. HTTP 401/403 es autenticación; 429, límite de tasa;
  400/404/422, rechazo. HTTP 202, 5xx, timeout o respuesta inválida conservan la reserva pendiente
  para conciliación, igual que otros fallos inciertos del asistente.
- Permanecen RBAC, RLS, consentimiento `ai_processing`, límites de llamadas y presupuesto,
  verificación del entorno, recuperación, modo de solo lectura y grupo autorizado de producción.
  Conectar el proveedor no concede consentimientos ni habilita escrituras de Meta.
- El estado del asistente y la interfaz indican el bloqueo operativo existente, en vez de
  anunciar que falta la clave cuando el proveedor ya está conectado.

## Presupuesto y facturación

Las tasas configuradas son una **valoración interna para controlar el presupuesto**, no una
tarifa verificada de NVIDIA ni una factura. Los valores iniciales mantienen la valoración por
token del control ya existente en la aplicación; se pueden ajustar mediante configuración.
No se supone que el consumo sea gratis ni se descuentan tokens en caché.

Para tasas internas `r_in` y `r_out`, el valor de control de una llamada es:

`C = ((input + cacheRead) × r_in + output × r_out) / 1 000 000`.

La reserva anterior a la llamada usa los bytes UTF-8 de la petición más 1024 de margen como
cota conservadora de entrada y la salida máxima completa. Se comprueban los límites por
pregunta, usuario/día y organización/mes. Un error incierto no libera la reserva. El ledger
conserva tokens y modelo respondido; `ai.asked` y `/v1/ai/status` identifican
`costBasis=budget_estimate`. La interfaz dice «presupuesto estimado».

El proveedor no devuelve un importe facturado. Los cargos o créditos reales requieren
conciliación con el servicio contratado. El catálogo público se documenta como evaluación;
esta integración y sus pruebas no acreditan licencia comercial, SLA ni disponibilidad futura.
Referencias: [API del modelo](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-super-vl-120b-a12b-infer),
[condiciones del servicio y alcance del catálogo](https://docs.api.nvidia.com/nim/docs/product).

## Pruebas reproducibles

`pnpm test` incluye contratos del adaptador y dos pruebas de integración de la aplicación con
transporte simulado. No hay claves reales ni acceso externo en CI.

`pnpm ai:smoke:nvidia -- --yes` usa la API real con fixtures sintéticos. Requiere
`NVIDIA_API_KEY`, Postgres local y haber inicializado `ad_astra_test` con `pnpm test`.
`test/env.ts` rechaza cualquier destino distinto de localhost:55432/ad_astra_test. No ejecutar
al mismo tiempo que otra suite que vacíe esa base. La prueba hace dos turnos por las rutas,
herramientas y verificador reales; guarda solo estado, uso y metadatos en
`spike-output/nvidia-assistant-smoke.json`, excluido de Git y del despliegue.

Las pruebas sintéticas verifican integración y defensas; no miden la calidad del análisis de
campañas reales ni autorizan el envío de datos de clientes sin consentimiento.

### Ejecución del 2026-10-27

- Regresión local: 385 pruebas en 42 archivos, sin fallos; incluye 26 casos del proveedor y su
  integración, además de las defensas existentes de consentimiento, alcance y presupuesto.
- Prueba NVIDIA real: dos turnos por `/v1/ai/ask`, ambos HTTP 200, `answered` y `verified`.
  El primer turno consultó `get_metrics` y citó los totales conocidos del fixture: 700 USD de
  gasto y 70 leads. Se verificaron ambas cifras, sin incidencias del verificador.
- El segundo turno reutilizó la evidencia y terminó sin incidencias. Duraciones observadas:
  15,437 s y 3,951 s en una ejecución; no son una garantía de latencia.
- Valoración interna total: 0,169968 USD según las tasas de control configuradas. **No es un
  cargo facturado por NVIDIA.** No se enviaron datos reales de cuentas publicitarias.
