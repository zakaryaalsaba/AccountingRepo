<script setup>
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { setDocumentDir } from './i18n';

const { locale } = useI18n();

watch(
  locale,
  (v) => {
    setDocumentDir(v);
    localStorage.setItem('locale', v);
  },
  { immediate: false }
);
</script>

<template>
  <router-view />
</template>
