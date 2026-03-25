import axios from 'axios';

const TOKEN_KEY = 'auth_token';
const COMPANY_KEY = 'current_company_id';

const baseURL = import.meta.env.VITE_API_URL || '';

export const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const t = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
  if (t) {
    config.headers.Authorization = `Bearer ${t}`;
  }
  const c = typeof localStorage !== 'undefined' ? localStorage.getItem(COMPANY_KEY) : null;
  if (c) {
    config.headers['X-Company-Id'] = c;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && typeof localStorage !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(COMPANY_KEY);
    }
    return Promise.reject(err);
  }
);
