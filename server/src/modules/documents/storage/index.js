import path from 'path';
import { createLocalDiskStorage } from './localDiskStorage.js';

/**
 * Document file storage (MVP: local disk). Swap driver via ESIGN_STORAGE_DRIVER.
 *
 * Future: add createS3Storage() behind the same shape { saveFile(buffer, meta) }.
 *
 * @typedef {object} EsignStorageMeta
 * @property {string} companyId
 * @property {string} originalName
 * @property {string} [mimeType]
 *
 * @typedef {object} EsignStorage
 * @property {(buffer: Buffer, meta: EsignStorageMeta) => Promise<{ file_url: string, storage_key: string, bytes_written: number }>} saveFile
 */

function parseMimeList(raw) {
  if (!raw || String(raw).trim() === '') return ['application/pdf'];
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function resolveUploadRoot() {
  const fromEnv = process.env.ESIGN_UPLOAD_DIR;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  const rel = fromEnv || 'uploads/esign';
  return path.join(process.cwd(), rel);
}

let cached = null;

/**
 * @returns {EsignStorage}
 */
export function getEsignStorage() {
  if (cached) return cached;

  const driver = (process.env.ESIGN_STORAGE_DRIVER || 'local').toLowerCase();
  if (driver !== 'local') {
    throw new Error(
      `ESIGN_STORAGE_DRIVER="${driver}" is not implemented. Use "local" for MVP, or add an S3 adapter in modules/documents/storage/.`
    );
  }

  const maxBytes = Number(process.env.ESIGN_MAX_FILE_BYTES || 15 * 1024 * 1024);
  const publicBaseUrl = (process.env.ESIGN_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(
    /\/$/,
    ''
  );
  const publicUrlPath = process.env.ESIGN_PUBLIC_URL_PATH || '/files/esign';
  const allowedMimeTypes = parseMimeList(process.env.ESIGN_ALLOWED_MIME);

  cached = createLocalDiskStorage({
    rootDir: resolveUploadRoot(),
    publicBaseUrl,
    publicUrlPath,
    maxBytes,
    allowedMimeTypes,
  });

  return cached;
}

/** @returns {{ maxBytes: number, allowedMimeTypes: string[], driver: string, uploadRoot: string }} */
export function getEsignStorageConfig() {
  return {
    driver: process.env.ESIGN_STORAGE_DRIVER || 'local',
    maxBytes: Number(process.env.ESIGN_MAX_FILE_BYTES || 15 * 1024 * 1024),
    allowedMimeTypes: parseMimeList(process.env.ESIGN_ALLOWED_MIME),
    uploadRoot: resolveUploadRoot(),
  };
}
