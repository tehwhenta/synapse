import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173' })
const runtimePath = fileURLToPath(new URL('./.otp-runtime.mjs', import.meta.url))
let runtime, mount, flushPromises, authEvent, session, calls, auth
const account = { id: 'otp-user', email: 'student@example.com' }
before(async () => {
  for (const key of ['window','document','Document','HTMLElement','Element','SVGElement','Node','localStorage','sessionStorage','location','history']) globalThis[key] = dom.window[key]
  const compiled = await build({ stdin: { contents: "export { default as AuthScreen } from './src/components/AuthScreen.vue'; export { createPinia,setActivePinia } from 'pinia'; export { useAuthStore } from './src/stores/auth.js';", resolveDir: fileURLToPath(new URL('..',import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external', define: { 'import.meta.env': '{}' }, plugins: [{ name: 'otp-test', setup(builder) {
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'supabase-mock', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const supabase = globalThis.__otpClient; export const isConfigured = true;', loader: 'js' }))
    builder.onLoad({ filter: /\.vue$/ }, args => { const { descriptor } = parse(readFileSync(args.path,'utf8')); return { contents: compileScript(descriptor,{ id: args.path, inlineTemplate: true }).content, loader: 'js', resolveDir: dirname(args.path) } })
  } }] })
  globalThis.__otpClient = {
    async rpc(name) { calls.push(['rpc',name]); return { data:null,error:null } },
    auth: {
      onAuthStateChange(fn) { authEvent = fn; return { data: { subscription: { unsubscribe() {} } } } },
      async getSession() { return { data: { session } } },
      async signUp(input) { calls.push(['signup', input]); return { data: { session: null, user: account }, error: null } },
      async resetPasswordForEmail(email) { calls.push(['reset', email]); return { error: null } },
      async resend(input) { calls.push(['resend', input]); return { error: null } },
      async verifyOtp(input) {
        calls.push(['verify', input, auth.recovering])
        if (input.token !== '12345678') return { data: {}, error: new Error('Token has expired or is invalid') }
        session = { user: account, access_token: 'test-session' }; authEvent('SIGNED_IN', session)
        return { data: { session, user: account }, error: null }
      },
      async updateUser(input) { calls.push(['update', input]); return { error: null } },
      async signOut(options) { calls.push(['signout',options]); session = null; authEvent('SIGNED_OUT', null); return { error: null } },
    },
    from() { return { select() { return this }, eq() { return this }, async single() { return { data: { id: account.id, display_name: 'Student' }, error: null } } } },
  }
  writeFileSync(runtimePath, compiled.outputFiles[0].contents)
  runtime = await import(pathToFileURL(runtimePath).href)
  const utils = await import('@vue/test-utils'); mount = utils.mount; flushPromises = utils.flushPromises
})
beforeEach(async () => { calls = []; session = null; sessionStorage.clear(); runtime.setActivePinia(runtime.createPinia()); auth = runtime.useAuthStore(); await auth.initialize() })
after(() => { delete globalThis.__otpClient; dom.window.close(); try { unlinkSync(runtimePath) } catch {} })

test('Password visibility controls preserve the value and reset when switching forms',async t => {
  const wrapper=mount(runtime.AuthScreen,{attachTo:document.body});t.after(()=>wrapper.unmount())
  await wrapper.find('#auth-password').setValue('private-password')
  await wrapper.find('[aria-label="Show password"]').trigger('click')
  assert.equal(wrapper.find('#auth-password').attributes('type'),'text');assert.equal(wrapper.find('#auth-password').element.value,'private-password')
  await wrapper.find('[aria-label="Hide password"]').trigger('click')
  assert.equal(wrapper.find('#auth-password').attributes('type'),'password')
  await wrapper.find('[aria-label="Show password"]').trigger('click')
  await wrapper.findAll('button').find(b=>b.text().includes('Create an account')).trigger('click')
  assert.equal(wrapper.find('#auth-password').attributes('type'),'password');assert.equal(wrapper.find('#auth-password').element.value,'')
})
test('Auth refocus and token refresh do not reset a loaded workspace or repeat profile queries',async () => {
  session={user:account,access_token:'test-session'};authEvent('SIGNED_IN',session);await new Promise(resolve=>setTimeout(resolve,5));await flushPromises()
  assert.equal(auth.accountReady,true)
  const profileRequests=calls.filter(c=>c[0]==='rpc'&&c[1]==='account_deletion_status').length
  authEvent('SIGNED_IN',session);assert.equal(auth.accountReady,true)
  authEvent('TOKEN_REFRESHED',session);await flushPromises()
  assert.equal(auth.accountReady,true)
  assert.equal(calls.filter(c=>c[0]==='rpc'&&c[1]==='account_deletion_status').length,profileRequests)
})

test('Signup remembers only the pending email and verifies codes without a fixed digit count', async () => {
  assert.equal(await auth.signUp(account.email, 'private-password', 'Student'), false)
  assert.equal(auth.pendingOtp.type, 'email')
  assert.doesNotMatch(sessionStorage.getItem('synapse.pending-otp'), /private-password|12345678/)
  await assert.rejects(auth.resendCode(), /wait/)
  runtime.setActivePinia(runtime.createPinia()); auth = runtime.useAuthStore(); await auth.initialize()
  assert.equal(auth.pendingOtp.email, account.email)
  await auth.verifyCode('1234 5678')
  assert.deepEqual(calls.find(c => c[0] === 'verify')[1], { email: account.email, token: '12345678', type: 'email' })
  assert.equal(auth.user.id, account.id); assert.equal(auth.pendingOtp, null); assert.equal(auth.recovering, false)
})
test('Recovery requires a valid recovery OTP, hides the workspace before sign-in, and survives reload', async () => {
  await assert.rejects(auth.updatePassword('new-password'), /Verify/)
  await auth.resetPassword(account.email)
  await assert.rejects(auth.verifyCode('87654321'), /expired/)
  assert.equal(auth.recovering, false); assert.equal(auth.user, null); assert.equal(auth.pendingOtp.type, 'recovery')
  await auth.verifyCode('12345678')
  const verified = calls.filter(c => c[0] === 'verify').at(-1)
  assert.equal(verified[1].type, 'recovery'); assert.equal(verified[2], true)
  assert.equal(auth.recovering, true); assert.equal(sessionStorage.getItem('synapse.password-recovery'), account.id)
  runtime.setActivePinia(runtime.createPinia()); auth = runtime.useAuthStore(); await auth.initialize()
  assert.equal(auth.recovering, true)
  await auth.updatePassword('new-password')
  assert.equal(auth.recovering, false); assert.equal(sessionStorage.getItem('synapse.password-recovery'), null)
  assert.equal(calls.filter(c => c[0] === 'update').length, 1)
})
test('Resending confirmation and recovery uses the correct server flow and enforces the cooldown', async () => {
  await auth.requestConfirmation(account.email); auth.pendingOtp.sentAt = Date.now() - 61000
  await auth.resendCode()
  assert.deepEqual(calls.filter(c => c[0] === 'resend').at(-1)[1], { type: 'signup', email: account.email })
  await assert.rejects(auth.resendCode(), /wait/)
  await auth.resetPassword(account.email); auth.pendingOtp.sentAt = Date.now() - 61000; await auth.resendCode()
  assert.equal(calls.filter(c => c[0] === 'reset').length, 2)
})
test('The signup screen enters OTP mode, supports eight-character codes, and offers resend/correct-email states', async () => {
  const wrapper = mount(runtime.AuthScreen, { attachTo: document.body })
  await wrapper.findAll('button').find(b => b.text().includes('Create an account')).trigger('click')
  await wrapper.find('input[autocomplete="name"]').setValue('Student')
  await wrapper.find('input[type="email"]').setValue(account.email)
  await wrapper.find('input[type="password"]').setValue('private-password')
  await wrapper.find('form').trigger('submit'); await flushPromises()
  assert.equal(wrapper.find('input[autocomplete="one-time-code"]').exists(), true)
  assert.equal(wrapper.find('input[type="password"]').exists(), false)
  assert.doesNotMatch(wrapper.text(), /6.digit|six.digit|confirmation link/i)
  await wrapper.find('.otp-input').setValue('00000000'); await wrapper.find('form').trigger('submit'); await flushPromises()
  assert.match(wrapper.find('[role="alert"]').text(), /expired/)
  assert.equal(wrapper.findAll('button').find(b => b.text().startsWith('Resend')).attributes('disabled'), '')
  await wrapper.findAll('button').find(b => b.text() === 'Use a different email').trigger('click')
  assert.equal(auth.pendingOtp, null); assert.equal(wrapper.find('input[type="email"]').exists(), true)
  wrapper.unmount()
})
test('Password reset screen verifies a code first, then requires matching passwords', async () => {
  const wrapper = mount(runtime.AuthScreen, { attachTo: document.body })
  await wrapper.findAll('button').find(b => b.text() === 'Forgot password?').trigger('click')
  await wrapper.find('input[type="email"]').setValue(account.email)
  await wrapper.find('form').trigger('submit'); await flushPromises()
  await wrapper.find('.otp-input').setValue('12345678'); await wrapper.find('form').trigger('submit'); await flushPromises()
  assert.equal(wrapper.findAll('input[type="password"]').length, 2)
  const passwords = wrapper.findAll('input[type="password"]')
  await passwords[0].setValue('new-password'); await passwords[1].setValue('mismatched-password')
  await wrapper.find('form').trigger('submit'); await flushPromises()
  assert.match(wrapper.find('[role="alert"]').text(), /do not match/); assert.equal(calls.filter(c => c[0] === 'update').length, 0)
  await passwords[1].setValue('new-password'); await wrapper.find('form').trigger('submit'); await flushPromises()
  assert.equal(auth.recovering, false); assert.equal(calls.filter(c => c[0] === 'update').length, 1)
  wrapper.unmount()
})
test('Scheduling account deletion blocks the workspace and signs out globally with its recovery deadline',async () => {
  const client=globalThis.__otpClient,originalRpc=client.rpc
  const request={delete_after:new Date(Date.now()+48*3600000).toISOString(),status:'pending'}
  try {
    await auth.requestConfirmation(account.email);await auth.verifyCode('12345678')
    assert.equal(auth.accountReady,true)
    client.rpc=async name=>name==='request_account_deletion'?{data:request,error:null}:originalRpc(name)
    assert.equal(await auth.requestAccountDeletion(),request.delete_after)
    assert.equal(auth.user,null);assert.equal(auth.accountReady,false)
    assert.deepEqual(calls.filter(call=>call[0]==='signout').at(-1),['signout',{scope:'global'}])
    assert.match(auth.notice,/Sign in before then to cancel/)
  } finally {client.rpc=originalRpc}
})
test('Restoring an old session cannot cancel deletion, while explicit sign-in cancels and awaits one profile load',async () => {
  const client=globalThis.__otpClient,originalRpc=client.rpc,originalSignIn=client.auth.signInWithPassword
  let pending={delete_after:new Date(Date.now()+48*3600000).toISOString(),status:'pending'},statusReads=0
  try {
    session={user:account,access_token:'test-session'}
    client.rpc=async name=>{
      if(name==='account_deletion_status'){statusReads++;await new Promise(resolve=>setTimeout(resolve,10));return {data:pending,error:null}}
      if(name==='cancel_account_deletion'){pending=null;return {data:true,error:null}}
      return originalRpc(name)
    }
    runtime.setActivePinia(runtime.createPinia());auth=runtime.useAuthStore();await auth.initialize()
    assert.equal(auth.accountReady,false);assert.ok(auth.accountDeletion);assert.ok(pending)
    statusReads=0
    client.auth.signInWithPassword=async()=>{authEvent('SIGNED_IN',session);return {data:session,error:null}}
    await auth.signIn(account.email,'test-password')
    assert.equal(auth.accountReady,true);assert.equal(auth.accountDeletion,null);assert.equal(pending,null)
    assert.equal(statusReads,1);assert.match(auth.notice,/deletion cancelled/)
  } finally {client.rpc=originalRpc;client.auth.signInWithPassword=originalSignIn}
})
