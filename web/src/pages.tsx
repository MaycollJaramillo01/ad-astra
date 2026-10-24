import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import type { AdAccount, Client, Connection } from '../../src/contracts.ts';
import type { Role } from '../../src/domain.ts';
import { ApiError, api } from './api.ts';

// Pantallas base. La UI oculta lo que el rol no puede hacer, pero quien decide es el servidor.

const isAdmin = (role: Role) => role === 'owner' || role === 'admin';
const input =
  'w-full rounded border border-gray-300 bg-transparent px-2 py-1.5 dark:border-gray-700';
const button =
  'rounded bg-gray-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-gray-900';

export function ClientsPage({ role }: { role: Role }) {
  const queryClient = useQueryClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api<Client[]>('/v1/clients') });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (body: { name: string }) => api<Client>('/v1/clients', { method: 'POST', body }),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  return (
    <section aria-labelledby="clientes">
      <h2 id="clientes" className="mb-4 text-lg font-semibold">
        Clientes
      </h2>
      {isAdmin(role) && (
        <form
          className="mb-4 flex items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate({ name });
          }}
        >
          <label className="flex-1 text-sm">
            Nuevo cliente
            <input
              className={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <button type="submit" className={button} disabled={create.isPending}>
            Crear
          </button>
        </form>
      )}
      {create.error && <ErrorBox error={create.error} />}
      {clients.error && <ErrorBox error={clients.error} />}
      <Table
        empty="Todavía no hay clientes."
        headers={['Nombre', 'Estado', 'Alta']}
        rows={(clients.data ?? []).map((c) => ({
          key: c.id,
          cells: [c.name, c.status, new Date(c.createdAt).toLocaleDateString('es')],
        }))}
      />
    </section>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es') : '—');

export function AccountsPage({ role }: { role: Role }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => api<AdAccount[]>('/v1/ad-accounts'),
  });
  const toggle = useMutation({
    mutationFn: (a: AdAccount) =>
      api<AdAccount>(`/v1/ad-accounts/${a.id}`, {
        method: 'PATCH',
        body: { syncEnabled: !a.syncEnabled },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['ad-accounts'] }),
  });
  return (
    <section aria-labelledby="cuentas">
      <h2 id="cuentas" className="mb-1 text-lg font-semibold">
        Cuentas publicitarias
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        Se descubren al validar una conexión con Meta. Al activar la sincronización se traen las
        entidades, los Insights recientes y el histórico (13 meses por defecto).
      </p>
      {accounts.error && <ErrorBox error={accounts.error} />}
      {toggle.error && <ErrorBox error={toggle.error} />}
      <Table
        empty="No hay cuentas visibles para ti."
        headers={[
          'Cuenta',
          'ID de Meta',
          'Moneda',
          'Zona horaria',
          'Sincronización',
          'Últimos datos',
        ]}
        rows={(accounts.data ?? []).map((a) => ({
          key: a.id,
          cells: [
            a.name,
            a.metaAccountId,
            a.currency,
            a.timezoneName,
            isAdmin(role) ? (
              <button
                key="sync"
                type="button"
                className={button}
                disabled={toggle.isPending}
                aria-label={`${a.syncEnabled ? 'Desactivar' : 'Activar'} la sincronización de ${a.name}`}
                onClick={() => toggle.mutate(a)}
              >
                {a.syncEnabled ? 'Activa · desactivar' : 'Activar'}
              </button>
            ) : a.syncEnabled ? (
              'Activa'
            ) : (
              'Inactiva'
            ),
            when(a.lastInsightsSyncAt),
          ],
        }))}
      />
    </section>
  );
}

export function ConnectionsPage({ role }: { role: Role }) {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/v1/meta/connections'),
  });
  const [form, setForm] = useState({ label: '', metaAppId: '', accessToken: '' });
  const create = useMutation({
    mutationFn: (body: typeof form) =>
      api<Connection>('/v1/meta/connections', { method: 'POST', body }),
    onSuccess: () => {
      setForm({ label: '', metaAppId: '', accessToken: '' }); // el token no se conserva en la UI
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
  });

  if (!isAdmin(role)) return <p>Solo owner y admin gestionan las conexiones con Meta.</p>;
  return (
    <section aria-labelledby="conexiones">
      <h2 id="conexiones" className="mb-1 text-lg font-semibold">
        Conexiones con Meta
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        El token se cifra al guardarlo y nunca se vuelve a mostrar; solo su huella. Queda pendiente
        hasta que el siguiente ciclo de sincronización lo valida con Meta y descubre sus cuentas.
      </p>
      <form
        className="mb-4 grid gap-2 sm:grid-cols-3"
        autoComplete="off"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate(form);
        }}
      >
        <label className="text-sm">
          Nombre
          <input
            className={input}
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            required
          />
        </label>
        <label className="text-sm">
          ID de la app de Meta
          <input
            className={input}
            inputMode="numeric"
            value={form.metaAppId}
            onChange={(e) => setForm({ ...form, metaAppId: e.target.value })}
            required
          />
        </label>
        <label className="text-sm">
          Token del usuario del sistema
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            value={form.accessToken}
            onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
            required
          />
        </label>
        <div className="sm:col-span-3">
          <button type="submit" className={button} disabled={create.isPending}>
            Guardar conexión
          </button>
        </div>
      </form>
      {create.error && <ErrorBox error={create.error} />}
      {connections.error && <ErrorBox error={connections.error} />}
      <Table
        empty="No hay conexiones."
        headers={['Nombre', 'App', 'Huella del token', 'Estado', 'Última validación']}
        rows={(connections.data ?? []).map((c) => ({
          key: c.id,
          cells: [c.label, c.metaAppId, c.tokenFingerprint, c.status, when(c.lastValidatedAt)],
        }))}
      />
    </section>
  );
}

function Table({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: Array<{ key: string; cells: ReactNode[] }>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 dark:border-gray-800">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-gray-100 dark:border-gray-900">
              {row.cells.map((cell, i) => (
                <td key={`${headers[i]}`} className="py-2 pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorBox({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="m-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      {error.message}
      {error instanceof ApiError && error.detail ? `: ${error.detail}` : ''}
    </div>
  );
}
