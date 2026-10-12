<script setup>
import { ref } from 'vue'
import { useWorkspaceStore } from '../stores/workspace'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
const emit=defineEmits(['close','created']), workspace=useWorkspaceStore()
const title=ref(''),cards=ref([{id:crypto.randomUUID(),front:'',back:''}]),busy=ref(false),error=ref('')
function add() { if(cards.value.length<100) cards.value.push({id:crypto.randomUUID(),front:'',back:''}) }
async function save() { busy.value=true;error.value='';try { emit('created',await workspace.createManualDeck(title.value,cards.value)) } catch(e) { error.value=e.message } finally { busy.value=false } }
</script>
<template>
  <Modal title="Flashcards, in your own words" wide @close="!busy&&emit('close')">
    <form class="stack-form manual-deck-form" @submit.prevent="save">
      <p class="muted">Write your own questions and answers. Custom decks don’t use any AI attempts.</p>
      <p v-if="error" class="error-box" role="alert">{{ error }}</p>
      <label>Deck title<input v-model="title" required maxlength="150" placeholder="e.g. Biology · terms to remember" :disabled="busy" /></label>
      <section v-for="(card,index) in cards" :key="card.id" class="custom-card-row"><div class="custom-card-heading"><strong>Card {{ index+1 }}</strong><button type="button" class="icon-button" :disabled="busy||cards.length===1" :aria-label="'Remove card '+(index+1)" @click="cards.splice(index,1)"><Icon name="Trash2" :size="16" /></button></div><div class="custom-card-fields"><label>Question<textarea v-model="card.front" required maxlength="1000" rows="3" :disabled="busy" :aria-label="'Question '+(index+1)" placeholder="What would you like to remember?"></textarea></label><label>Answer<textarea v-model="card.back" required maxlength="2000" rows="3" :disabled="busy" :aria-label="'Answer '+(index+1)" placeholder="Write a clear answer…"></textarea></label></div></section>
      <button type="button" class="button secondary" :disabled="busy||cards.length>=100" @click="add"><Icon name="Plus" :size="16" />Add a card<span class="tiny">{{ cards.length }} / 100</span></button>
      <button class="button primary" :disabled="busy||!title.trim()||cards.some(c=>!c.front.trim()||!c.back.trim())">{{ busy?'Saving…':'Save custom deck' }}<Icon name="Check" :size="16" /></button>
    </form>
  </Modal>
</template>
