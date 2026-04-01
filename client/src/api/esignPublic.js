/** Public signing API (no JWT / company headers). */

function baseUrl() {
  const b = import.meta.env.VITE_API_URL || '';
  return String(b).replace(/\/$/, '');
}

function signPath(token) {
  const b = baseUrl();
  const path = `/api/sign/${encodeURIComponent(token)}`;
  return b ? `${b}${path}` : path;
}

export async function fetchSignSession(token) {
  const url = signPath(token);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = data.error;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function submitSignatures(token, signatures) {
  const url = signPath(token);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ signatures }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.code = data.error;
    err.payload = data;
    throw err;
  }
  return data;
}
