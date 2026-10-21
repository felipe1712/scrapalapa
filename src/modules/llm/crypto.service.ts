import crypto from 'node:crypto';
import { env } from '../../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recomendados por NIST para GCM

/**
 * Deriva una clave exacta de 32 bytes (256 bits) a partir de ENCRYPTION_KEY de entorno.
 */
function getMasterKey(): Buffer {
  const rawKey = env.ENCRYPTION_KEY.trim();
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

export interface EncryptedKeyResult {
  encrypted: string;
  last4: string;
}

/**
 * Cifra la API Key usando AES-256-GCM y extrae los últimos 4 caracteres para mostrar enmascarada.
 * Jamás registra la clave en claro.
 */
export function encryptApiKey(plainApiKey: string): EncryptedKeyResult {
  const cleaned = plainApiKey.trim();
  if (!cleaned) {
    throw new Error('La clave de API no puede estar vacía al cifrar.');
  }

  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encryptedBuf = Buffer.concat([cipher.update(cleaned, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = `${iv.toString('base64')}:${authTag.toString('base64')}:${encryptedBuf.toString('base64')}`;
  const last4 = cleaned.length >= 4 ? cleaned.slice(-4) : cleaned;

  return {
    encrypted: payload,
    last4,
  };
}

/**
 * Descifra la API Key en memoria justo antes de invocar al SDK de Anthropic.
 */
export function decryptApiKey(encryptedPayload: string | null | undefined): string | null {
  if (!encryptedPayload) return null;

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de clave cifrada inválido en la base de datos.');
  }

  const [ivB64, authTagB64, dataB64] = parts;
  const key = getMasterKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encryptedData = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Devuelve la representación enmascarada segura para la UI: "sk-ant-…XXXX"
 */
export function formatMaskedApiKey(last4: string | null | undefined): string | null {
  if (!last4) return null;
  return `sk-ant-…${last4}`;
}
