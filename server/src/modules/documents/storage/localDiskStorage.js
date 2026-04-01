import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

function safeBasename(name) {
  const b = path.basename(String(name || 'document'));
  return b.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'document';
}

/**
 * @param {object} options
 * @param {string} options.rootDir - Absolute directory to store files (e.g. .../uploads/esign)
 * @param {string} options.publicBaseUrl - No trailing slash (e.g. http://localhost:4000)
 * @param {string} [options.publicUrlPath='/files/esign'] - URL path prefix for file_url
 * @param {number} options.maxBytes
 * @param {string[]} options.allowedMimeTypes - Empty = allow any (not recommended)
 */
export function createLocalDiskStorage(options) {
  const {
    rootDir,
    publicBaseUrl,
    publicUrlPath = '/files/esign',
    maxBytes,
    allowedMimeTypes,
  } = options;

  const base = String(publicBaseUrl || '').replace(/\/$/, '');
  const urlPrefix = `${base}${publicUrlPath.startsWith('/') ? '' : '/'}${publicUrlPath}`.replace(/\/$/, '');

  return {
    /**
     * @param {Buffer} buffer
     * @param {{ companyId: string, originalName: string, mimeType?: string | null }} meta
     * @returns {Promise<{ file_url: string, storage_key: string, bytes_written: number }>}
     */
    async saveFile(buffer, meta) {
      const companyId = String(meta.companyId || '').trim();
      if (!companyId) throw new Error('companyId is required');

      const size = buffer?.length ?? 0;
      if (size <= 0) throw new Error('Empty file');
      if (size > maxBytes) {
        throw new Error(`File exceeds maximum size (${maxBytes} bytes)`);
      }

      const mime = String(meta.mimeType || '').trim().toLowerCase();
      if (allowedMimeTypes.length > 0) {
        const ok = allowedMimeTypes.some((m) => m.toLowerCase() === mime);
        if (!ok) {
          throw new Error(`MIME type not allowed: ${mime || '(missing)'}`);
        }
      }

      const baseName = safeBasename(meta.originalName);
      const ext = path.extname(baseName) || '.pdf';
      const fileName = `${randomUUID()}${ext}`;
      const dir = path.join(rootDir, companyId);
      await fs.mkdir(dir, { recursive: true });
      const fullPath = path.join(dir, fileName);
      await fs.writeFile(fullPath, buffer);

      const storage_key = `${companyId}/${fileName}`;
      const file_url = `${urlPrefix}/${storage_key}`;

      return { file_url, storage_key, bytes_written: size };
    },
  };
}
