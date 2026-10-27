import { expect, it, vi } from 'vitest';
import { ReadCache } from './read-cache.ts';

it('coalesce lecturas de la misma clave, conserva aislamiento entre claves y devuelve copias', async () => {
  const cache = new ReadCache(1000);
  let calls = 0;
  const load = async () => {
    calls++;
    await Promise.resolve();
    return { values: [1] };
  };
  const [a, b] = await Promise.all([
    cache.get('tenant-a:user-a:scope1', load),
    cache.get('tenant-a:user-a:scope1', load),
  ]);
  expect(calls).toBe(1);
  a.values.push(2);
  expect(b.values).toEqual([1]);
  await cache.get('tenant-b:user-a:scope1', load);
  await cache.get('tenant-a:user-a:scope2', load);
  expect(calls).toBe(3);
});
it('no conserva fallos y expira sus datos', async () => {
  vi.useFakeTimers();
  try {
    const cache = new ReadCache(1000);
    await expect(
      cache.get('a', async () => {
        throw new Error('db');
      }),
    ).rejects.toThrow('db');
    expect(await cache.get('a', async () => 1)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('a', async () => 2)).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
