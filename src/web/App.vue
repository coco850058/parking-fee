<template>
  <router-view v-slot="{ Component }">
    <transition name="page-fade" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

watch(
  () => route.fullPath,
  () => {
    const title = route.meta.title;
    document.title = typeof title === 'string' ? title : '停车缴费';
  },
  { immediate: true },
);
</script>
