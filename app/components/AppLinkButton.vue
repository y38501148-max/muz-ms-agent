<script setup lang="ts">
withDefaults(defineProps<{ to: string; type?: 'primary' | 'default'; block?: boolean }>(), { type: 'default', block: false })
</script>

<template>
  <NuxtLink v-slot="{ href, navigate }" :to="to" custom><a-button :href="href || undefined" :type="type" :block="block" @click="navigate"><slot /></a-button></NuxtLink>
</template>
