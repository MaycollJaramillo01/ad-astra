# Rediseño y configuración separada de producción — 2026-10-27

Repositorio: `MaycollJaramillo01/ad-astra`, rama `main`. El rediseño conserva permisos, cálculos, advertencias y operaciones existentes; el sistema visual y las comprobaciones se describen en [DESIGN.md](DESIGN.md).

## Entornos y configuración

| Entorno de aplicación | Proyecto Vercel | Base Neon | URL |
| --- | --- | --- | --- |
| staging | `ad-astra-staging` | `blue-night-06297061` | [Staging](https://ad-astra-staging-six.vercel.app) |
| production | `ad-astra-production` | `winter-morning-19351144` | [Producción](https://ad-astra-production-phi.vercel.app) |

Producción usa un recurso Neon nuevo (`ad-astra-production-db`) en el plan gratuito, región iad1, con su propio esquema y roles. La conexión propietaria proporcionada por el usuario correspondía al staging existente; no se reasignó esa base ni se copiaron sus datos a producción.

El runtime de producción se configura con `APP_ENV=production`, el origen HTTPS del proyecto, conexión pooled de `app_rw`, secretos de sesión y cron nuevos y una clave de cifrado nueva con versión 1. Las credenciales de la app de Meta indicada por el usuario se guardan como variables sensibles. El acceso usa `AUTH_MODE=password`, una cuenta inicial invitada y registro público deshabilitado; Workspace no está configurado.

Las credenciales propietarias se usan para el alta y las migraciones. La conexión temporal de instalación de Neon a Vercel se desconecta después de preparar la base; no se suministra el rol propietario al runtime. Los valores de las variables y las credenciales de acceso se conservan en archivos locales ignorados y con permisos restringidos, sin incorporarlos a este informe ni al repositorio.

## Estado de liberación

El esquema está migrado a la versión 16 y vinculado a producción. **La cuarentena permanece activa**: no se ha acreditado todavía backup, restauración y PITR para una liberación operativa de producción. `/v1/ready` debe responder 503 mientras esta condición siga vigente, aunque el acceso y las consultas de la interfaz estén disponibles. El estado técnico muestra estos pendientes reales.

Actualización de ingesta: el usuario autorizó expresamente sincronizar las 17 cuentas accesibles por el token proporcionado. La migración 0017 añade un modo operativo de solo lectura para esa carga, sin convertirla en liberación productiva ni desactivar la pausa de emergencia. La conexión se registra cifrada y los consentimientos de lectura se vinculan a los clientes; las cuentas no se copian a staging. La activación, los trabajos y sus resultados dejan auditoría. La disponibilidad real se comprueba con los conteos, errores y fechas de sincronización, sin inferir éxito por la presencia de variables en Vercel.

`META_WRITES_ENABLED`, notificaciones por correo y forecasting permanecen desactivados. La publicación de la interfaz y la carga de las variables no constituyen autorización para escribir sobre campañas, enviar notificaciones o declarar predicciones disponibles. Los requisitos de liberación siguen en [OPERATIONS.md](OPERATIONS.md) y [PRODUCTION_READINESS_2026-10-26.md](PRODUCTION_READINESS_2026-10-26.md).

Los despliegues son manuales (`git.deploymentEnabled=false`). Antes de habilitar efectos externos se requieren evidencia de recuperación vigente, revisión de permisos, lista explícita de tenants autorizados y las reglas y aprobaciones de cada acción.
