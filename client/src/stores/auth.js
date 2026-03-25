import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '@/api/client';

const TOKEN_KEY = 'auth_token';

export const useAuthStore = defineStore('auth', () => {
  const token = ref(typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null);
  const user = ref(null);
  const loading = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value));

  function setToken(t) {
    token.value = t;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function clear() {
    user.value = null;
    setToken(null);
  }

  async function login(email, password) {
    loading.value = true;
    try {
      const { data } = await api.post('/api/auth/login', { email, password });
      setToken(data.token);
      user.value = data.user;
      return data;
    } finally {
      loading.value = false;
    }
  }

  async function register(payload) {
    loading.value = true;
    try {
      const { data } = await api.post('/api/auth/register', payload);
      setToken(data.token);
      user.value = data.user;
      return data;
    } finally {
      loading.value = false;
    }
  }

  async function fetchMe() {
    if (!token.value) return;
    loading.value = true;
    try {
      const { data } = await api.get('/api/auth/me');
      user.value = data.user;
    } catch {
      clear();
    } finally {
      loading.value = false;
    }
  }

  return { token, user, loading, isAuthenticated, setToken, clear, login, register, fetchMe };
});
