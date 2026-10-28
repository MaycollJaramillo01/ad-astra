# Experiencia de monitoreo por cuenta

Implementado el 2026-10-28. El inicio abre `/cuentas`: una cartera que prioriza problemas de acceso, señales críticas, datos atrasados y acciones pendientes. Se puede buscar por nombre, cliente o ID de Meta y filtrar por atención, datos o acciones.

## Espacio de la cuenta

`/cuentas/:accountId?vista=resumen` mantiene cuenta, cliente, moneda, zona horaria, última sincronización y período de analítica visibles. Las secciones son Resumen, Problemas, Campañas, Acciones, Seguimiento, Historial y Configuración. La cuenta y el período viven en la URL y se conservan entre secciones; los filtros de entidad se aplican explícitamente y no se arrastran a otra cuenta.

- **Resumen:** siguiente paso, indicadores y tendencia. Las alertas no sustituyen la comprobación de cobertura.
- **Problemas:** incidentes por severidad, descripciones de las métricas, comparación de ventanas, última decisión y su autor. Enlaces a la entidad o a la configuración que necesita atención y a las recomendaciones ejecutables disponibles. Los detalles técnicos permanecen desplegables.
- **Campañas:** tabla de campañas y navegación a conjuntos y anuncios dentro de la misma cuenta. Una entidad de otra cuenta no se muestra bajo una cabecera incorrecta.
- **Acciones:** recomendaciones y propuestas de la cuenta, filtros por entidad o acción, nombres de entidades y proponentes, progreso por acción y enlaces a seguimiento. Crear una propuesta conserva la revisión en vivo y las aprobaciones del [Action Center](ACTION_CENTER.md).
- **Seguimiento:** ventanas antes y después, fecha desde la que puede revisarse la ventana madura y acceso a la acción original. Sigue siendo una comparación descriptiva, con los límites del [monitoreo](MONITORING.md).
- **Historial:** eventos con fecha, autor, transiciones y motivos; evidencia técnica desplegable. Se conservan los últimos 300 eventos de la API existente.
- **Configuración:** conexión, sincronizaciones, reglas, canales, informes y permisos de escritura. Owner y admin pueden asignar cliente, registrar una autorización de lectura ya recibida, reactivar un cliente y activar/desactivar sincronización. Cambiar cliente desactiva la sincronización hasta habilitarla con el consentimiento correcto. El registro de lectura no concede autorización de escritura.

## Datos, prioridad y permisos

El estado de datos distingue conexión inválida/caducada, falta de consentimiento o cliente activo, sincronización desactivada, primera carga pendiente y datos atrasados. El plazo de atraso usa la regla `sync_stale` habilitada, o 24 horas. Una sincronización reciente no garantiza cobertura completa del período.

La prioridad se ordena por bloqueo de acceso, incidentes/hallazgos de severidad alta o crítica o acciones fallidas, datos pendientes/atrasados, señales abiertas, acciones en curso y evaluación pendiente. No se muestra una ausencia de alertas como buena salud si faltan datos o no se ha evaluado el monitoreo. La salud procede de la última evaluación guardada, sin fabricar puntuaciones.

Reconocer un incidente lo deja en revisión; no confirma una recuperación ni ejecuta un cambio. La última decisión identifica a quien la registró, sin crear una asignación formal. La recuperación sigue dependiendo de observaciones y persistencia del motor. Las escrituras de Meta conservan sus permisos, consentimiento y aprobación humana.

## API y búsqueda

| Ruta | Comportamiento |
| --- | --- |
| GET `/v1/account-workspace` | Metadatos de las cuentas visibles y agregados de incidentes, hallazgos, acciones, salud y monitoreo. Número fijo de consultas; no solicita un informe completo por cuenta. |
| GET `/v1/workspace-search?q=…` | Clientes, cuentas y campañas visibles. Entre 2 y 100 caracteres, hasta ocho resultados por tipo. Escapa comodines SQL y excluye campañas eliminadas. |

Ambas rutas requieren `accounts:read`, contexto de tenant y alcance por cliente además de RLS. No exponen secretos de conexión. La búsqueda de navegación mantiene Ctrl K y admite nombres de clientes, cuentas y campañas, con espera breve al escribir y recuperación de errores. Las pantallas anteriores de analítica, monitoreo y acciones siguen accesibles; `/cuentas/gestion` conserva la gestión de sincronización.

## Verificación

Pruebas de integración de agregados, autenticación, aislamiento de clientes/tenants, comodines de búsqueda y autores de decisiones en `test/workspace.test.ts`. Pruebas de interpretación de métricas y conservación del contexto en `test/account-experience.test.ts`. Recorridos con sesiones reales de prueba, navegación por cuenta, búsqueda por teclado, creación de propuestas, accesibilidad y móvil en `test/e2e/readiness.spec.ts`. Usan datos sintéticos y no ejecutan operaciones reales de Meta.
