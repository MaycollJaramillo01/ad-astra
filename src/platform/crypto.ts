import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Cifrado de credenciales en reposo (ADR-008, docs/SECURITY.md §4.4): AES-256-GCM, nonce de
// 12 bytes por cifrado y AAD que ata el cifrado a su fila (un cifrado copiado a otra fila no
// se descifra). Varias versiones de clave para poder rotar.

export interface Sealed {
  ciphertext: Buffer; // texto cifrado + etiqueta de autenticación (16 bytes al final)
  nonce: Buffer;
  keyVersion: number;
}

const TAG_BYTES = 16;

export function createTokenCipher(keys: Map<number, Buffer>, activeVersion: number) {
  const keyFor = (version: number) => {
    const key = keys.get(version);
    if (!key) throw new Error(`Clave de cifrado v${version} no configurada`);
    return key;
  };

  return {
    seal(plaintext: string, aad: string): Sealed {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyFor(activeVersion), nonce);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
        nonce,
        keyVersion: activeVersion,
      };
    },

    open(sealed: Sealed, aad: string): string {
      const decipher = createDecipheriv('aes-256-gcm', keyFor(sealed.keyVersion), sealed.nonce);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
      // Lanza si el cifrado, el nonce o el AAD se alteraron.
      return Buffer.concat([
        decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

export type TokenCipher = ReturnType<typeof createTokenCipher>;

/** Huella corta para soporte: identifica un token sin revelarlo. */
export const fingerprint = (secret: string) =>
  createHash('sha256').update(secret).digest('hex').slice(0, 8);
