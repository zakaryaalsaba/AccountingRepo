import { api } from './client.js';

/**
 * @param {Record<string, string>} [query]
 */
export async function listDocuments(query = {}) {
  const { data } = await api.get('/api/documents', { params: query });
  return data.documents || [];
}

/**
 * @param {File} file
 * @param {string} [title]
 */
export async function uploadDocument(file, title) {
  const fd = new FormData();
  fd.append('file', file);
  if (title != null && String(title).trim()) fd.append('title', String(title).trim());
  const { data } = await api.post('/api/documents/upload', fd);
  return data;
}

export async function getDocument(id) {
  const { data } = await api.get(`/api/documents/${id}`);
  return data;
}

/**
 * @param {string} id
 * @param {{ title?: string, placements_json?: unknown[], recipients?: { name: string, email: string, signing_order: number }[] }} body
 */
export async function patchDocument(id, body) {
  const { data } = await api.patch(`/api/documents/${id}`, body);
  return data;
}

export async function sendDocument(id) {
  const { data } = await api.post(`/api/documents/${id}/send`);
  return data;
}
