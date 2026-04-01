<script setup>
import { ref } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const full_name = ref('');
const error = ref('');

async function submit() {
  error.value = '';
  try {
    await auth.register({ email: email.value, password: password.value, full_name: full_name.value });
    await router.replace({ name: 'dashboard' });
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}
</script>

<template>
  <div class="auth-shell flex items-center justify-center p-4 sm:p-8">
    <div class="auth-grid" />
    <div class="auth-orb end-1/4 top-1/4 h-80 w-80 bg-fuchsia-500" />
    <div class="auth-orb start-0 bottom-0 h-72 w-72 bg-brand-600" />

    <div class="relative z-10 w-full max-w-[440px]">
      <div
        class="rounded-3xl border border-white/10 bg-white/[0.07] p-8 shadow-2xl shadow-black/50 backdrop-blur-2xl sm:p-10"
      >
        <div class="mb-8 text-center">
          <div
            class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-xl font-extrabold text-white shadow-lg shadow-brand-900/50"
          >
            م
          </div>
          <h1 class="text-2xl font-bold text-white sm:text-3xl">{{ t('auth.register') }}</h1>
          <p class="mt-2 text-sm text-slate-400">{{ t('app.tagline') }}</p>
        </div>

        <form class="space-y-5" @submit.prevent="submit">
          <div>
            <label class="ui-label !text-slate-400">{{ t('auth.fullName') }}</label>
            <input
              v-model="full_name"
              type="text"
              autocomplete="name"
              class="ui-input border-white/10 bg-white/5 text-white placeholder:text-slate-500 focus:border-brand-400/60 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label class="ui-label !text-slate-400">{{ t('auth.email') }}</label>
            <input
              v-model="email"
              type="email"
              required
              autocomplete="email"
              class="ui-input border-white/10 bg-white/5 text-white placeholder:text-slate-500 focus:border-brand-400/60 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label class="ui-label !text-slate-400">{{ t('auth.password') }}</label>
            <input
              v-model="password"
              type="password"
              required
              minlength="6"
              autocomplete="new-password"
              class="ui-input border-white/10 bg-white/5 text-white placeholder:text-slate-500 focus:border-brand-400/60 focus:ring-brand-500/20"
            />
          </div>
          <p v-if="error" class="rounded-xl bg-rose-500/15 px-3 py-2 text-sm text-rose-200 ring-1 ring-rose-400/30">
            {{ error }}
          </p>
          <button type="submit" class="ui-btn-primary w-full py-3 text-base shadow-xl" :disabled="auth.loading">
            {{ auth.loading ? t('common.loading') : t('auth.submitRegister') }}
          </button>
        </form>

        <p class="mt-8 text-center text-sm text-slate-400">
          {{ t('auth.hasAccount') }}
          <RouterLink to="/login" class="font-semibold text-brand-300 transition hover:text-brand-200">
            {{ t('auth.login') }}
          </RouterLink>
        </p>
      </div>
    </div>
  </div>
</template>
