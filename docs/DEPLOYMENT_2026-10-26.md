# Despliegue inicial de staging — 2026-10-26

Registro histórico. La configuración posterior de un proyecto y una base de producción separados se documenta en [DEPLOYMENT_2026-10-27.md](DEPLOYMENT_2026-10-27.md); no implica una liberación operativa de producción.

**Actualización posterior a la captura de configuración pendiente:** Neon de staging está provisionado con roles separados y migraciones 0016. El usuario confirmó que no tiene Workspace; el nuevo acceso usa `AUTH_MODE=password` y una cuenta inicial invitada. Controles en [AUTHENTICATION.md](AUTHENTICATION.md). Los pendientes OAuth de este registro original corresponden al modo Workspace y no impiden el nuevo modo explícito de credenciales.

Repositorio: [MaycollJaramillo01/ad-astra](https://github.com/MaycollJaramillo01/ad-astra), rama `main`. El primer commit publicado en esta entrega es `f801ab2`, con monitoreo y controles operativos. Las correcciones de despliegue se publican después sobre esa misma rama.

Proyecto Vercel: `ad-astra-staging`, en el equipo `maycolljaramillo01s-projects` (Pro existente), vinculado al repositorio. URL estable: [ad-astra-staging-six.vercel.app](https://ad-astra-staging-six.vercel.app). Región inicial del build y función: iad1. La separación regional con Neon se decidirá al provisionar la base.

Este es un **bootstrap de staging**, no una liberación productiva ni un piloto aceptado. Aunque Vercel denomine `production` al target que sirve el alias de este proyecto, el entorno de la aplicación es `staging`. No se creó el proyecto de producción y no se configuró aprobación productiva ficticia. La integración Git no publica automáticamente mientras `git.deploymentEnabled=false`.

## Configuración y verificación

- SPA, assets y adaptador serverless publicados. `.vercelignore` excluye secretos locales, datos reales del spike, resultados de pruebas y dependencias locales.
- Node limitado a la serie 22; tipos de Node resueltos desde el proyecto para la compilación temporal de TypeScript 7 usada por Vercel. La comprobación completa de tipos sigue en CI.
- La prueba Monte Carlo de calibración conserva sus doce semillas y umbrales; tiene timeout individual de 20 s para runners compartidos. El primer CI remoto excedió los 5 s predeterminados, sin fallar el criterio estadístico.
- La función devuelve HTTP 503 con un problema seguro y mensaje de configuración pendiente cuando no puede cargar la configuración. No expone errores internos, claves ni datos simulados. `/v1/ready` no debe declararse saludable en este estado.
- Meta writes, correo y forecasting permanecen desactivados. No se cargaron credenciales de desarrollo ni una URL localhost como base cloud.

## Pendiente para habilitar el acceso

1. Crear Neon de staging y roles `app_owner`/`app_rw`/operación separados; migrar, vincular `APP_ENV=staging` y revisar cuarentena.
2. Configurar `DATABASE_URL` del runtime, secreto de sesión y claves/versiones de cifrado mediante canales secretos. La credencial de migración no debe existir en el runtime.
3. Configurar Google Workspace real (OAuth Internal, dominio real, callback `https://ad-astra-staging-six.vercel.app/v1/auth/callback/google`, invitación inicial y 2FA). El dominio de pruebas local no habilita login real.
4. Configurar CRON_SECRET, monitor privado, backups/PITR, permisos de Meta y los servicios opcionales autorizados. Habilitar cron solo después de comprobar configuración y trabajos.
5. Repetir smoke de login, tenant/alcance, readiness, cron y recuperación, y completar las puertas de [OPERATIONS.md](OPERATIONS.md) y [preparación productiva](PRODUCTION_READINESS_2026-10-26.md).

El despliegue de archivos no sustituye estas tareas ni acredita una aplicación operativa. Los requisitos pendientes se conservan en el informe de riesgos; no se hicieron escrituras publicitarias ni envíos de correo para comprobar el despliegue.
