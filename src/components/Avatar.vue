<script setup>
import { ref, watch } from 'vue'
import { supabase } from '../lib/supabase'
import { initials } from '../lib/utils'
const props = defineProps({ name: String, path: String })
const url = ref(''); let request = 0
watch(() => props.path, async path => {
  const current = ++request; url.value = ''
  if (!path) return
  if (/^data:image\/(jpeg|png|webp);base64,/.test(path)) { url.value = path; return }
  if (!supabase) return
  const { data, error } = await supabase.storage.from('profile-photos').createSignedUrl(path, 3600)
  if (current === request && !error) url.value = data.signedUrl
}, { immediate: true })
</script>
<template><span class="avatar"><img v-if="url" :src="url" :alt="name || 'Profile photo'" @error="url = ''" /><span v-else>{{ initials(name) }}</span></span></template>
