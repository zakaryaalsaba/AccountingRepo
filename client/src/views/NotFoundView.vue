<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const router = useRouter();
const route = useRoute();

const secondsLeft = ref(5);
let timer;

function goToLogin() {
  router.replace({
    name: 'login',
    query: { redirect: route.fullPath },
  });
}

onMounted(() => {
  timer = setInterval(() => {
    secondsLeft.value -= 1;
    if (secondsLeft.value <= 0) {
      clearInterval(timer);
      timer = null;
      goToLogin();
    }
  }, 1000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="auth-shell flex min-h-screen items-center justify-center p-4 sm:p-8">
    <div class="auth-grid" />
    <div class="auth-orb start-1/3 top-1/4 h-64 w-64 bg-rose-500/40" />
    <div class="auth-orb end-1/4 bottom-1/4 h-80 w-80 bg-brand-600/35" />

    <div class="relative z-10 w-full max-w-[480px] text-center">
      <div
        class="rounded-3xl border border-white/10 bg-white/[0.08] p-8 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-10"
      >
        <div
          class="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-400/90 to-brand-700 text-3xl font-black text-white shadow-lg shadow-rose-900/30"
          aria-hidden="true"
        >
          404
        </div>
        <h1 class="text-2xl font-bold text-white sm:text-3xl">
          {{ t('notFound.title') }}
        </h1>
        <p class="mt-3 text-sm leading-relaxed text-slate-300 sm:text-base">
          {{ t('notFound.body') }}
        </p>
        <p
          v-if="secondsLeft > 0"
          class="mt-6 text-sm font-medium text-brand-200/90"
        >
          {{ t('notFound.redirecting', { n: secondsLeft }) }}
        </p>
        <div class="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button type="button" class="ui-btn-primary w-full sm:w-auto" @click="goToLogin">
            {{ t('notFound.goLogin') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
