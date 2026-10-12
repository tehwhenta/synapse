<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useAuthStore } from '../stores/auth'
import { isConfigured } from '../lib/supabase'
import Icon from './Icon.vue'
const auth = useAuthStore()
const emit = defineEmits(['connect'])
const mode = ref('signin'), name = ref(''), email = ref(''), password = ref(''), confirmation = ref(''), code = ref(''), busy = ref(false), message = ref(''), error = ref(''), now = ref(Date.now())
const showPassword = ref(false), showConfirmation = ref(false)
const verifying = computed(() => !!auth.pendingOtp && !auth.recovering)
const cooldown = computed(() => Math.max(0, Math.ceil(((auth.pendingOtp?.sentAt || 0) + 60000 - now.value) / 1000)))
const heading = computed(() => auth.recovering ? 'Choose a new password.' : verifying.value ? auth.pendingOtp.type === 'recovery' ? 'Check your reset code.' : 'Confirm your email.' : mode.value === 'signup' ? 'Create your account.' : mode.value === 'reset' ? 'Reset your password.' : mode.value === 'confirm' ? 'Confirm your email.' : 'Welcome back.')
const timer = setInterval(() => { now.value = Date.now() }, 1000)
onBeforeUnmount(() => clearInterval(timer))
function changeMode(value) { mode.value = value; auth.clearPendingOtp(); code.value = ''; password.value = ''; confirmation.value = ''; showPassword.value = false; showConfirmation.value = false; error.value = ''; message.value = ''; auth.error = '' }
async function submit() {
  if (busy.value) return
  error.value = ''; message.value = ''; busy.value = true
  try {
    if (auth.recovering) {
      if (password.value !== confirmation.value) throw new Error('The passwords do not match.')
      await auth.updatePassword(password.value)
    } else if (verifying.value) { await auth.verifyCode(code.value); code.value = ''; password.value = '' }
    else if (mode.value === 'reset') { await auth.resetPassword(email.value); message.value = 'If an account exists for this email, a reset code has been sent.' }
    else if (mode.value === 'confirm') { await auth.requestConfirmation(email.value); message.value = 'Check your email for your confirmation code.' }
    else if (mode.value === 'signup') {
      const immediate = await auth.signUp(email.value, password.value, name.value)
      password.value = ''
      if (!immediate) message.value = 'Check your email for your confirmation code.'
    } else await auth.signIn(email.value.trim(), password.value)
  } catch (err) { error.value = err.message; if (err.code === 'email_not_confirmed') { mode.value = 'confirm'; password.value = '' } }
  finally { now.value = Date.now(); busy.value = false }
}
async function resend() {
  busy.value = true; error.value = ''; message.value = ''
  try { await auth.resendCode(); code.value = ''; message.value = 'A new code was requested. Use the latest email.' }
  catch (err) { error.value = err.message }
  finally { now.value = Date.now(); busy.value = false }
}
async function cancelRecovery() { busy.value = true; try { await auth.signOut(); changeMode('signin') } catch (err) { error.value = err.message } finally { busy.value = false } }
</script>
<template>
  <main class="auth-layout">
    <section class="auth-story">
      <a class="brand" href="/" aria-label="Synapse home"><img src="/favicon.svg" alt="" /><span>synapse<span class="brand-dot">.</span></span></a>
      <div class="auth-story-body"><span class="eyebrow">YOUR STUDY SPACE</span><h1>Learn with<br>a little clarity.</h1><p>Your reviewers, flashcards, and practice quizzes.<br>One place for you and your study group.</p></div>
    </section>
    <section class="auth-form-panel"><div class="auth-form-inner"><span class="eyebrow">SYNAPSE</span><h2>{{ heading }}</h2><p class="muted auth-description">{{ auth.recovering ? 'Your code is verified. Set a password for your account.' : verifying ? 'Enter the OTP sent to ' + auth.pendingOtp.email + '.' : mode === 'reset' ? 'We will email you a code to verify your reset request.' : mode === 'confirm' ? 'Request a code for your existing account.' : 'Your materials stay private until you share a space.' }}</p>
      <p v-if="auth.notice" class="info-box" role="status">{{ auth.notice }}</p><p v-if="auth.accountDeletion" class="info-box">Account deletion is scheduled for {{ new Date(auth.accountDeletion.delete_after).toLocaleString() }}. Sign in before the deadline to cancel.</p>
      <form v-if="isConfigured" @submit.prevent="submit" class="stack-form">
        <label v-if="mode === 'signup' && !auth.recovering && !verifying">Your name<input v-model="name" required maxlength="80" autocomplete="name" placeholder="Your name" /></label>
        <label v-if="!auth.recovering && !verifying">Email address<input v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" /></label>
        <label v-if="verifying">OTP / code<input v-model="code" class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="64" placeholder="Enter your code" autofocus /></label>
        <div v-if="auth.recovering || (!verifying && ['signin','signup'].includes(mode))" class="password-field"><label for="auth-password">{{ auth.recovering ? 'New password' : 'Password' }}</label><div class="password-input"><input id="auth-password" v-model="password" :type="showPassword ? 'text' : 'password'" required minlength="8" :autocomplete="mode === 'signin' && !auth.recovering ? 'current-password' : 'new-password'" placeholder="At least 8 characters" /><button class="icon-button" type="button" :aria-label="showPassword ? 'Hide password' : 'Show password'" :aria-pressed="showPassword" @click="showPassword = !showPassword"><Icon :name="showPassword ? 'EyeOff' : 'Eye'" :size="18" /></button></div></div>
        <div v-if="auth.recovering" class="password-field"><label for="auth-confirmation">Confirm new password</label><div class="password-input"><input id="auth-confirmation" v-model="confirmation" :type="showConfirmation ? 'text' : 'password'" required minlength="8" autocomplete="new-password" /><button class="icon-button" type="button" :aria-label="showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'" :aria-pressed="showConfirmation" @click="showConfirmation = !showConfirmation"><Icon :name="showConfirmation ? 'EyeOff' : 'Eye'" :size="18" /></button></div></div>
        <p v-if="error || auth.error" class="error-box" role="alert">{{ error || auth.error }}</p><p v-if="message" class="success-box" role="status">{{ message }}</p>
        <button class="button primary full" :disabled="busy">{{ busy ? 'Please wait...' : auth.recovering ? 'Update password' : verifying ? 'Verify code' : mode === 'signup' ? 'Create account' : ['reset','confirm'].includes(mode) ? 'Send code' : 'Sign in' }}<Icon name="ArrowRight" /></button>
      </form>
      <template v-else><p class="info-box">Connect your Supabase project to create accounts and save your materials.</p><button class="button primary full" @click="emit('connect')">Connect workspace<Icon name="ArrowRight" /></button></template>
      <div v-if="isConfigured" class="auth-links">
        <template v-if="verifying"><button :disabled="busy || cooldown > 0" @click="resend">{{ cooldown > 0 ? 'Resend code in ' + cooldown + 's' : 'Resend code' }}</button><button :disabled="busy" @click="changeMode(auth.pendingOtp.type === 'recovery' ? 'reset' : 'confirm')">Use a different email</button><button :disabled="busy" @click="changeMode('signin')">Back to sign in</button></template>
        <button v-else-if="auth.recovering" :disabled="busy" @click="cancelRecovery">Cancel password reset</button>
        <template v-else><button :disabled="busy" @click="changeMode(mode === 'signup' ? 'signin' : mode === 'signin' ? 'signup' : 'signin')">{{ mode === 'signup' ? 'Already have an account? Sign in' : mode === 'signin' ? 'New here? Create an account' : 'Back to sign in' }}</button><button v-if="mode === 'signin'" :disabled="busy" @click="changeMode('reset')">Forgot password?</button><button v-if="mode === 'signin'" :disabled="busy" @click="changeMode('confirm')">Confirm an existing account</button></template>
      </div>
      <template v-if="!verifying && !auth.recovering"><div class="auth-divider"><span>or explore first</span></div><button class="button ghost full" :disabled="busy" @click="auth.enterDemo()">Explore the sample workspace<Icon name="ArrowUpRight" /></button></template>
    </div></section>
  </main>
</template>
