import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTokenCipher } from './crypto.ts';

const v1 = randomBytes(32);
const v2 = randomBytes(32);
const keys = new Map([
  [1, v1],
  [2, v2],
]);

it('cifra y descifra; el nonce cambia en cada cifrado', () => {
  const c = createTokenCipher(keys, 2);
  const a = c.seal('secreto', 'fila-1');
  const b = c.seal('secreto', 'fila-1');
  expect(a.keyVersion).toBe(2);
  expect(a.nonce.equals(b.nonce)).toBe(false);
  expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  expect(c.open(a, 'fila-1')).toBe('secreto');
});

it('falla si cambia el AAD o se altera un solo byte', () => {
  const c = createTokenCipher(keys, 2);
  const sealed = c.seal('secreto', 'fila-1');
  expect(() => c.open(sealed, 'fila-2')).toThrow();
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  expect(() => c.open({ ...sealed, ciphertext: tampered }, 'fila-1')).toThrow();
});

it('tras rotar, lo cifrado con la clave anterior sigue legible; una versión desconocida no', () => {
  const old = createTokenCipher(keys, 1).seal('antiguo', 'fila');
  expect(createTokenCipher(keys, 2).open(old, 'fila')).toBe('antiguo');
  expect(() => createTokenCipher(new Map([[2, v2]]), 2).open(old, 'fila')).toThrow(
    /v1 no configurada/,
  );
});
