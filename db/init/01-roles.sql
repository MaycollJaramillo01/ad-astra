-- Roles de base de datos (docs/DATABASE_SCHEMA.md §4). Contraseñas solo de desarrollo local.
-- docker compose lo ejecuta en el primer arranque; la CI lo aplica con psql.
create role app_owner login password 'app_owner_local';           -- migraciones: dueño de las tablas
create role app_rw login password 'app_rw_local' nobypassrls;     -- API y worker: sin DDL, con RLS

create database ad_astra owner app_owner;       -- desarrollo
create database ad_astra_test owner app_owner;  -- tests automáticos (se vacía en cada ejecución)

\connect ad_astra
-- Postgres 15+ ya no deja crear en public a cualquiera; se deja explícito.
revoke create on schema public from public;
grant usage on schema public to app_rw;
alter default privileges for role app_owner in schema public
  grant select, insert, update, delete on tables to app_rw;
alter default privileges for role app_owner in schema public
  grant usage, select on sequences to app_rw;

\connect ad_astra_test
revoke create on schema public from public;
grant usage on schema public to app_rw;
alter default privileges for role app_owner in schema public
  grant select, insert, update, delete on tables to app_rw;
alter default privileges for role app_owner in schema public
  grant usage, select on sequences to app_rw;
