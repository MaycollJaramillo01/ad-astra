# Acceso sin Workspace y provisión de cuentas

Revisión 2026-10-26: el usuario confirmó que no dispone de Google Workspace. Se añadió un modo explícito de credenciales por invitación para habilitar staging; Workspace conserva el valor predeterminado.

## Modos

| AUTH_MODE | Identidad y configuración | Alta |
|---|---|---|
| workspace | Google OAuth Internal, dominio/email verificados y membresía | Cuenta Google válida e invitación vigente |
| password | Better Auth, hash scrypt y contraseña de 14–128 caracteres | Solo operador con invitación vigente; signup público desactivado |

`password` no configura Google ni simula un Workspace. `email_verified` permanece false en las cuentas provisionadas: no se afirma haber verificado el buzón mediante un proveedor. La autorización procede de la invitación explícita y la posesión de la contraseña entregada por un canal privado. No existe acceso social en ese modo. Workspace sigue exigiendo sus tres variables Google y email verificado; seleccionar password elimina únicamente el requisito de ese proveedor.

Las cookies de producción son Secure/HttpOnly y se valida el mismo origen. El límite inicial de login es cinco intentos/minuto/IP en Better Auth, además del límite HTTP general. Son contadores por instancia; no sustituyen controles distribuidos ni 2FA. Quitar la última membresía impide nuevas sesiones y retira el acceso a datos con sesiones existentes.

## Provisión

1. Crear organización e invitación mediante las herramientas administrativas autorizadas. Seleccionar `AUTH_MODE=password`.
2. Preparar un archivo privado con una contraseña aleatoria fuerte, fuera del repositorio/despliegue.
3. Configurar `ACCOUNT_TENANT_ID`, `ACCOUNT_EMAIL`, `ACCOUNT_NAME`, `ACCOUNT_PASSWORD_FILE` y `OPS_CHANGE_REASON`, además de las variables del servidor.
4. Ejecutar `pnpm admin:password-user`. Exige invitación vigente y registra `auth.account_provisioned`, sin contraseña/hash en la bitácora. No sustituye ni resetea cuentas existentes.
5. Entregar por un canal privado. El usuario puede cambiar su clave en **Mi cuenta**, comprobando la actual y cerrando las otras sesiones.

No hay proveedor de recuperación por correo configurado. La UI dirige al administrador; una recuperación requiere una operación privilegiada revisada, sin activar signup ni marcar el buzón como verificado. La clave inicial de staging se entrega en un archivo local privado, ignorado por git y excluido de Vercel; no se incluye aquí.

## Staging real

Neon `ad-astra-staging-db`, recurso independiente `blue-night-06297061`, región iad1, plan Free. Migraciones hasta 0016 aplicadas con `app_owner`; API pooled con `app_rw` sin propiedad, superusuario, CREATEROLE ni BYPASSRLS. Base vinculada a staging y una organización inicial; no se copiaron campañas ni datos del spike.

La instalación Neon ya existía. La conexión administrativa temporal se usó para provisión y se desconectó del proyecto; sus variables no forman parte del runtime. La URL limitada, claves de sesión/cifrado y secretos cron/monitor se cargan cifrados en Vercel. La función no contiene credencial DDL. El responsable custodia las copias operativas privadas de claves y conexiones.

Meta writes, correo y forecasting permanecen desactivados. El plan Free y este arranque no acreditan PITR, backup externo, RPO/RTO ni preparación productiva. Los riesgos del [informe](PRODUCTION_READINESS_2026-10-26.md) siguen vigentes salvo la provisión básica y el acceso de staging, comprobados por separado.

## Verificación

- PostgreSQL real: falta de invitación, hash sin texto plano, signup bloqueado, contraseña incorrecta, login sin Workspace, cambio de clave e invalidación de la anterior, revocación de membresía.
- Browser: formulario, login real, cambio y sesión renovada tras recargar; se conservan roles, aislamiento y CSRF.
- Smoke cloud: readiness, cookie segura, organización inicial y rutas autenticadas, sin datos simulados. Las pruebas no envían correo ni escriben en Meta.
