import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, authClient } from './api.ts';

export function AccountPage() {
  const options = useQuery({
    queryKey: ['access-options'],
    queryFn: () => api<{ mode: 'workspace' | 'password' }>('/v1/access-options'),
  });
  const [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [repeat, setRepeat] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function change(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    if (next !== repeat) {
      setMessage('Las contraseñas nuevas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error)
        setMessage('No se pudo cambiar la contraseña. Revisa la contraseña actual.');
      else {
        setCurrent('');
        setNext('');
        setRepeat('');
        setMessage('Contraseña actualizada. Se cerraron las otras sesiones.');
      }
    } catch {
      setMessage('No se pudo conectar. Inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }
  if (options.isPending) return <p role="status">Cargando cuenta…</p>;
  if (options.error) return <p role="alert">No se pudo consultar la configuración de acceso.</p>;
  if (options.data?.mode !== 'password')
    return (
      <section>
        <h1 className="text-xl font-semibold">Mi cuenta</h1>
        <p>El acceso se gestiona con Google Workspace.</p>
      </section>
    );
  return (
    <section className="max-w-md space-y-5">
      <h1 className="text-xl font-semibold">Mi cuenta</h1>
      <p className="text-sm text-gray-500">
        Cambia tu contraseña de acceso. Usa al menos 14 caracteres.
      </p>
      <form onSubmit={change} className="space-y-4">
        <label className="block text-sm">
          Contraseña actual
          <input
            required
            type="password"
            autoComplete="current-password"
            className="mt-1 w-full rounded border bg-transparent p-2"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Nueva contraseña
          <input
            required
            minLength={14}
            maxLength={128}
            type="password"
            autoComplete="new-password"
            className="mt-1 w-full rounded border bg-transparent p-2"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Confirmar contraseña
          <input
            required
            type="password"
            autoComplete="new-password"
            className="mt-1 w-full rounded border bg-transparent p-2"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <button
          disabled={busy}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
          type="submit"
        >
          {busy ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
