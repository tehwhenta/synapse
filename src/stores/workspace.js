import { defineStore } from 'pinia'
import { cleanAnnotations } from '../lib/annotations'
import { validateNoteContent, noteSaveError } from '../lib/noteContent'
import { invitationUrl, invitationToken } from '../lib/appUrl'
import { ref, computed } from 'vue'
import { supabase } from '../lib/supabase'
import { invokeGeneration } from '../lib/generationApi'
import { useLearningStore } from './learning'
import { useAuthStore } from './auth'
import { demoData } from '../lib/demo'
import { validateFile, fileType, extractOfficeText } from '../lib/documents'
import { quizResult, studyStreak } from '../lib/utils'
import { fileExpiry } from '../lib/sourceFiles'

function check(result) { if (result.error) throw result.error; return result.data }
export const useWorkspaceStore = defineStore('workspace', () => {
  const auth = useAuthStore()
  const folders = ref([]); const assets = ref([]); const documents = ref([]); const members = ref([]); const activities = ref([]); const messages = ref([])
  const attempts = ref([]); const progress = ref([]); const sessions = ref([]); const selectedFolderId = ref(null); const loading = ref(false); const uploading = ref(false); const uploadLabel = ref(''); const error = ref('')
  const generationTasks = ref([]), generationConnection = ref(''), recentGeneration=ref(new Set())
  const generationCompletionTimers=new Map()
  let generationTimer, generationVersion = 0, pollingGeneration = false, generationListening = false
  const activeGeneration = computed(() => generationTasks.value.filter(t => ['queued','processing'].includes(t.status) || t.status==='paused' && t.auto_resume_at))
  const folderGeneration = computed(() => {const latest=new Map();for(const task of generationTasks.value){const key=task.document_id || task.asset_id;if(!latest.has(key))latest.set(key,task)}return [...latest.values()].filter(t=>t.folder_id===selectedFolderId.value && (t.status!=='completed' || recentGeneration.value.has(t.id)))})
  const moreAssets = ref(false), moreDocuments = ref(false), personalStats = ref(null)
  const documentColumns = 'id,folder_id,material_id,uploaded_by,name,storage_path,mime_type,size_bytes,status,error_message,processing_started_at,expires_at,purged_at,created_at'
  let changeChannel, folderChannel, reloadTimer, workspaceReloadTimer, loadVersion = 0, folderVersion = 0, subscriptionVersion = 0, workspaceSubscriptionVersion = 0
  const reloadTables = new Set()
  const folderRequests = new Map()
  const selectedFolder = computed(() => folders.value.find(f => f.id === selectedFolderId.value))
  const folderAssets = computed(() => assets.value.filter(a => a.folder_id === selectedFolderId.value))
  const latestAssets = computed(() => {
    const series = new Map()
    for (const asset of folderAssets.value) { const key = asset.series_id || asset.id; if (!series.has(key) || (asset.set_number || 1) > (series.get(key).set_number || 1)) series.set(key,asset) }
    return [...series.values()].sort((a,b) => new Date(b.created_at)-new Date(a.created_at))
  })
  const folderDocuments = computed(() => documents.value.filter(a => a.folder_id === selectedFolderId.value))
  const isOwner = computed(() => selectedFolder.value?.owner_id === auth.user?.id)
  const canEdit = computed(() => isOwner.value || members.value.some(m => m.folder_id === selectedFolderId.value && m.user_id === auth.user?.id && m.role === 'editor'))
  const stats = computed(() => !auth.demo && personalStats.value ? personalStats.value : ({ minutes: Math.floor(sessions.value.reduce((sum, x) => sum + x.duration_seconds, 0) / 60), mastered: progress.value.filter(p => p.repetitions >= 3).length, quizzes: attempts.value.length, streak: studyStreak(sessions.value, attempts.value) }))
  function persistDemo() {
    if (!auth.demo) return
    localStorage.setItem('synapse.demo', JSON.stringify({ schemaVersion: 2, folders: folders.value, assets: assets.value, documents: documents.value, members: members.value, activities: activities.value, messages: messages.value, attempts: attempts.value, progress: progress.value, sessions: sessions.value }))
  }
  async function refreshStats() { if (!auth.demo) personalStats.value = check(await supabase.rpc('my_progress_stats', { p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })) }
  async function load() {
    error.value = ''; loading.value = true; const version = ++loadVersion
    try {
      if (auth.demo) {
        let saved; try { saved = JSON.parse(localStorage.getItem('synapse.demo') || 'null') } catch { /* reset invalid local demo */ }
        const data = saved && Array.isArray(saved.folders) ? saved : demoData()
        if (saved && !saved.schemaVersion) {
          const examples = demoData()
          // Add the new sample versions once, keeping existing user-created notes and deleted spaces.
          for (const example of examples.assets.filter(a => a.set_number > 1)) if (data.folders.some(f => f.id === example.folder_id) && data.assets.some(a => a.id === example.series_id) && !data.assets.some(a => a.id === example.id)) data.assets.push(example)
        }
        for (const [key, state] of Object.entries({ folders, assets, documents, members, activities, messages, attempts, progress, sessions })) state.value = data[key] || []
        assets.value = assets.value.map(a => {const custom=a.is_custom===true || (a.kind==='deck' && !a.document_id && !a.material_id && /^[0-9a-f-]{36}$/i.test(a.id));return { ...a,is_custom:custom,series_id:a.series_id || a.id, set_number:a.set_number || 1, content_format:a.content_format || 'markdown',data:custom?a.data.map(c=>({...c,id:c.id || crypto.randomUUID()})):a.data }})
        persistDemo()
      } else {
        const result = check(await supabase.from('folders').select('*').order('created_at', { ascending: true }))
        if (version !== loadVersion) return
        folders.value = result
        const personal = await Promise.all([
          supabase.from('quiz_attempts').select('*').eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(365),
          supabase.from('flashcard_progress').select('*').eq('user_id', auth.user.id),
          supabase.from('study_sessions').select('*').eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(365),
          supabase.rpc('my_progress_stats', { p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
        ])
        if (version !== loadVersion) return
        attempts.value = check(personal[0]); progress.value = check(personal[1]); sessions.value = check(personal[2]); personalStats.value = check(personal[3])
      }
      if (!folders.value.some(f => f.id === selectedFolderId.value)) selectedFolderId.value = folders.value[0]?.id || null
      if (!auth.demo) { await loadFolder(); startGenerationMonitor() }
    } catch (err) { error.value = err.message || 'Could not load your workspace.' }
    finally { if (version === loadVersion) loading.value = false }
  }
  async function loadFolder(tables = null) {
    if (auth.demo) return
    const id = selectedFolderId.value, version = folderVersion, userId = auth.user?.id
    if (!id) { assets.value = []; documents.value = []; members.value = []; activities.value = []; messages.value = []; moreAssets.value = false; moreDocuments.value = false; return }
    const wanted = table => !tables || tables.has(table)
    const requested = ['study_assets','document_files','folder_members','study_messages'].map(table => {
      if (!wanted(table)) return null
      const request = (folderRequests.get(table) || 0) + 1; folderRequests.set(table,request)
      return {table,request}
    })
    const rows = await Promise.all([
      wanted('study_assets') ? supabase.rpc('list_latest_assets', { p_folder_id: id, p_offset: 0, p_limit: 31 }) : null,
      wanted('document_files') ? supabase.from('document_files').select(documentColumns).eq('folder_id', id).order('created_at', { ascending: false }).limit(31) : null,
      wanted('folder_members') ? supabase.from('folder_members').select('*,profiles(display_name,avatar_path)').eq('folder_id', id) : null,
      wanted('study_messages') ? supabase.from('study_messages').select('*,profiles(display_name,avatar_path)').eq('folder_id', id).order('created_at', { ascending: false }).limit(100) : null,
    ])
    if (id !== selectedFolderId.value || version !== folderVersion || userId !== auth.user?.id) return
    const current = index => rows[index] && folderRequests.get(requested[index].table) === requested[index].request
    if (current(0)) { const data = check(rows[0]); moreAssets.value = data.length > 30; assets.value = data.slice(0, 30) }
    if (current(1)) { const data = check(rows[1]); moreDocuments.value = data.length > 30; documents.value = data.slice(0, 30) }
    if (current(2)) members.value = check(rows[2])
    if (current(3)) messages.value = check(rows[3]).reverse()
  }
  async function loadMore(type = 'assets') {
    if (auth.demo) return
    const id = selectedFolderId.value, target = type === 'assets' ? assets : documents, more = type === 'assets' ? moreAssets : moreDocuments
    const result = check(await (type === 'assets' ? supabase.rpc('list_latest_assets', { p_folder_id: id, p_offset: latestAssets.value.length, p_limit: 31 }) : supabase.from('document_files').select(documentColumns).eq('folder_id', id).order('created_at', { ascending: false }).range(target.value.length, target.value.length + 30)))
    if (id !== selectedFolderId.value) return
    more.value = result.length > 30; target.value.push(...result.slice(0, 30))
  }
  async function selectFolder(id) {
    const changed = id !== selectedFolderId.value; selectedFolderId.value = id; error.value = ''
    if (!auth.demo && changed) { ++folderVersion; assets.value = []; documents.value = []; members.value = []; messages.value = []; moreAssets.value = false; moreDocuments.value = false }
    try { await loadFolder(); if (id === selectedFolderId.value) { await subscribeFolder(); startGenerationMonitor() } } catch (err) { if (id === selectedFolderId.value) error.value = err.message }
  }
  async function createFolder(title, description, color) {
    const folder = auth.demo ? { id: crypto.randomUUID(), title, description, color, owner_id: auth.user.id, created_at: new Date().toISOString() }
      : check(await supabase.rpc('create_folder', { p_title: title, p_description: description, p_color: color }))
    folders.value.push(folder); persistDemo(); await selectFolder(folder.id); return folder
  }
  async function renameFolder(title, description, color) {
    if (!isOwner.value) throw new Error('Only the owner can edit this folder.')
    if (!auth.demo) check(await supabase.from('folders').update({ title, description, color }).eq('id', selectedFolderId.value))
    Object.assign(selectedFolder.value, { title, description, color }); persistDemo()
  }
  async function deleteFolder() {
    if (!isOwner.value) throw new Error('Only the space owner can delete this space.')
    const id = selectedFolderId.value
    if (!auth.demo) check(await supabase.rpc('delete_folder', { p_folder_id: id }))
    const removed = new Set(assets.value.filter(a => a.folder_id === id).map(a => a.id))
    folders.value = folders.value.filter(f => f.id !== id); assets.value = assets.value.filter(a => a.folder_id !== id); documents.value = documents.value.filter(d => d.folder_id !== id)
    members.value = members.value.filter(m => m.folder_id !== id); activities.value = activities.value.filter(a => a.folder_id !== id); messages.value = messages.value.filter(m => m.folder_id !== id)
    attempts.value = attempts.value.filter(a => !removed.has(a.asset_id)); progress.value = progress.value.filter(p => !removed.has(p.asset_id)); sessions.value = sessions.value.filter(s => s.folder_id !== id)
    persistDemo(); await selectFolder(folders.value[0]?.id || null); if (!auth.demo) await load()
  }
  async function saveNote(title, content, id, contentFormat = 'markdown', annotations) {
    if (!canEdit.value) throw new Error('Editor access required.')
    validateNoteContent(content,contentFormat)
    const drawingFields = annotations === undefined ? {} : { annotations:cleanAnnotations(annotations) }
    if (auth.demo) {
      if (id) Object.assign(assets.value.find(a => a.id === id), { title, content, content_format: contentFormat, ...drawingFields })
      else { const newId = crypto.randomUUID(); assets.value.unshift({ id: newId, series_id: newId, set_number: 1, folder_id: selectedFolderId.value, kind: 'note', title, content, content_format: contentFormat, data: [], ...drawingFields, created_by: auth.user.id, created_at: new Date().toISOString() }) }
      persistDemo()
    } else {
      try {
        if (id) check(await supabase.from('study_assets').update({ title, content, content_format: contentFormat,...drawingFields }).eq('id', id))
        else check(await supabase.from('study_assets').insert({ folder_id: selectedFolderId.value, kind: 'note', title, content, content_format: contentFormat, created_by: auth.user.id,...drawingFields }))
      } catch(error) { throw noteSaveError(error) }
      await loadFolder()
    }
  }
  async function renameAsset(id, title) {
    if (!canEdit.value) throw new Error('Editor access required.')
    title = title.trim(); if (!title || title.length > 150) throw new Error('Enter a title up to 150 characters.')
    if (!auth.demo) check(await supabase.from('study_assets').update({ title }).eq('id',id))
    const asset = assets.value.find(a => a.id === id); if (asset) asset.title = title
    persistDemo()
  }
  async function listSets(asset) {
    const seriesId = asset.series_id || asset.id
    if (auth.demo) return assets.value.filter(a => (a.series_id || a.id) === seriesId).sort((a,b) => (a.set_number || 1)-(b.set_number || 1))
    const rows = []
    for (let offset = 0; ; offset += 200) {
      const page = check(await supabase.rpc('list_asset_sets', { p_series_id: seriesId }).select('id,folder_id,series_id,set_number,kind,title,content_format,created_at').range(offset,offset+199))
      rows.push(...page); if (page.length < 200) return rows
    }
  }
  async function readAsset(id) {
    if (auth.demo) { const asset = assets.value.find(a => a.id === id); if (!asset) throw new Error('This set is unavailable.'); return asset }
    return check(await supabase.from('study_assets').select('*').eq('id',id).single())
  }
  async function readDocument(id) {
    const cached = documents.value.find(d => d.id === id)
    if (cached || auth.demo) return cached || null
    return check(await supabase.from('document_files').select(documentColumns).eq('id', id).maybeSingle())
  }
  async function refreshAsset(asset) {
    if (auth.demo) throw new Error('Connect Supabase to generate fresh AI study sets.')
    if (!canEdit.value || asset.is_custom) throw new Error('Editor access to an AI study set is required.')
    return enqueueGeneration({ asset_id:asset.id })
  }
  function taskForDocument(id) { return generationTasks.value.find(t => t.document_id === id) }
  async function pollGeneration() {
    if (pollingGeneration || auth.demo || !auth.user) return
    clearTimeout(generationTimer)
    const version=generationVersion, userId=auth.user.id, folderId=selectedFolderId.value
    pollingGeneration=true
    try {
      const rows=check(await supabase.rpc('my_generation_tasks',{p_folder_id:folderId})) || []
      if (version!==generationVersion || userId!==auth.user?.id) return
      if (folderId!==selectedFolderId.value) { generationTimer=setTimeout(pollGeneration,0); return }
      const previous=new Map(generationTasks.value.map(t=>[t.id,t]))
      const changed=rows.some(t=>t.folder_id===folderId && t.completed_kinds?.length!==(previous.get(t.id)?.completed_kinds?.length || 0))
      for(const task of rows){if(task.status==='completed' && previous.has(task.id) && previous.get(task.id).status!=='completed'){recentGeneration.value=new Set([...recentGeneration.value,task.id]);clearTimeout(generationCompletionTimers.get(task.id));generationCompletionTimers.set(task.id,setTimeout(()=>{recentGeneration.value=new Set([...recentGeneration.value].filter(id=>id!==task.id));generationCompletionTimers.delete(task.id)},6000))}}
      generationTasks.value=rows;generationConnection.value=''
      if(changed) await loadFolder(new Set(['study_assets','document_files'])).catch(()=>{})
    } catch {
      if(version===generationVersion) generationConnection.value='Reconnecting to generation status. Accepted work continues on the server.'
    } finally {
      if(version===generationVersion){pollingGeneration=false;if((activeGeneration.value.length || generationConnection.value) && !globalThis.document?.hidden)generationTimer=setTimeout(pollGeneration,globalThis.navigator?.onLine===false || activeGeneration.value.every(t=>t.status==='paused')?30000:5000)}
    }
  }
  function wakeGeneration() { if(!globalThis.document?.hidden)void pollGeneration() }
  function startGenerationMonitor() {
    if(auth.demo || !auth.user)return
    if(!generationListening){globalThis.window?.addEventListener('online',wakeGeneration);globalThis.document?.addEventListener('visibilitychange',wakeGeneration);generationListening=true}
    void pollGeneration()
  }
  async function enqueueGeneration(target) {
    // Keep the same key across a lost acknowledgement or a refreshed tab.
    const key='synapse.queue.'+auth.user.id+'.'+(target.asset_id || target.document_id)
    let requestId
    try {requestId=localStorage.getItem(key)}catch{}
    requestId=requestId || crypto.randomUUID()
    try {localStorage.setItem(key,requestId)}catch{}
    let result
    for(let attempt=0;attempt<2;attempt++){
      try {result=await invokeGeneration({action:'enqueue',request_id:requestId,...target});break}
      catch(err){if(attempt || !err.transient)throw err;await new Promise(resolve=>setTimeout(resolve,700))}
    }
    if(!result?.task)throw new Error('The generation service needs the latest project update.')
    try {localStorage.removeItem(key)}catch{}
    generationTasks.value=[result.task,...generationTasks.value.filter(t=>t.id!==result.task.id)]
    startGenerationMonitor()
    return result.task
  }
  async function createManualDeck(title, cards) {
    if (!canEdit.value) throw new Error('Editor access required.')
    title = title.trim(); cards = cards.map(c => ({ id:crypto.randomUUID(),front:c.front.trim(),back:c.back.trim() }))
    if (!title || title.length>150 || !cards.length || cards.length>100 || cards.some(c=>!c.front || !c.back || c.front.length>1000 || c.back.length>2000)) throw new Error('Enter a title and 1 to 100 cards, each with a question and answer.')
    if (new TextEncoder().encode(JSON.stringify(cards)).length>120000) throw new Error('This deck is too large. Split it into smaller decks.')
    let deck
    if (auth.demo) { const id=crypto.randomUUID(); deck={ id,series_id:id,set_number:1,is_custom:true,folder_id:selectedFolderId.value,kind:'deck',title,content:'',content_format:'markdown',data:cards,created_by:auth.user.id,created_at:new Date().toISOString() }; assets.value.unshift(deck); persistDemo() }
    else { deck=check(await supabase.rpc('create_manual_deck',{ p_folder_id:selectedFolderId.value,p_title:title,p_cards:cards })); await loadFolder() }
    return deck
  }
  async function saveHighlightCards(source,title,cards,deckId=null,context=null) {
    if(!canEdit.value || source.kind!=='note')throw new Error('Editor access required.')
    if(!cards.length || cards.length>100 || cards.some(c=>!c.front.trim() || !c.back.trim() || c.front.length>1000 || c.back.length>2000))throw new Error('Each card needs a question and answer within the card limits.')
    if(auth.demo){
      if(!deckId)return createManualDeck(title,cards)
      const deck=assets.value.find(a=>a.id===deckId && a.is_custom && a.created_by===auth.user.id && a.folder_id===source.folder_id)
      if(!deck)throw new Error('Choose your own custom deck in this space.')
      const data=[...deck.data,...cards.map(c=>({id:crypto.randomUUID(),front:c.front.trim(),back:c.back.trim()}))]
      if(data.length>100 || new TextEncoder().encode(JSON.stringify(data)).length>120000)throw new Error('This deck is full. Create another deck.')
      deck.data=data;persistDemo();return deck
    }
    if(!context?.fingerprint || !Array.isArray(context.highlights))throw new Error('Generate and check these highlights before saving.')
    const userId=auth.user.id,payload={p_source_id:source.id,p_title:title,p_cards:cards.map(c=>({front:c.front.trim(),back:c.back.trim()})),p_deck_id:deckId,p_highlights:context.highlights,p_fingerprint:context.fingerprint}
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))))).map(b=>b.toString(16).padStart(2,'0')).join('')
    if(auth.user?.id!==userId)throw new Error('Your account changed before the save started.')
    const key='synapse.highlight-save.'+userId+'.'+source.id
    let saved;try{saved=JSON.parse(localStorage.getItem(key) || 'null')}catch{}
    const requestId=saved?.hash===hash?saved.request_id:crypto.randomUUID()
    try{localStorage.setItem(key,JSON.stringify({hash,request_id:requestId}))}catch{}
    const savedResult=check(await supabase.rpc('save_highlight_cards_v2',{p_request_id:requestId,...payload}))
    const result=Array.isArray(savedResult)?savedResult[0]:savedResult
    if(!result?.id)throw new Error('The save response was interrupted. Try saving these same cards again.')
    try{localStorage.removeItem(key)}catch{}
    if(auth.user?.id!==userId)throw new Error('Your account changed after saving. Reopen your deck when signed in.')
    // A status reload failure must never turn a committed save into a second append.
    if(selectedFolderId.value===source.folder_id)await loadFolder(new Set(['study_assets'])).catch(()=>{})
    return result
  }
  async function updateCustomCard(asset,cardId,front=null,back=null,remove=false) {
    if(!canEdit.value || !asset.is_custom || asset.kind!=='deck') throw new Error('Editor access to a custom deck is required.')
    if(!remove && (!front?.trim() || !back?.trim() || front.length>1000 || back.length>2000)) throw new Error('Enter a question and answer within the card limits.')
    let result
    if(auth.demo) {
      const row=assets.value.find(a=>a.id===asset.id),index=row?.data.findIndex(c=>c.id===cardId)
      if(index==null || index<0) throw new Error('This card was already removed. Reopen the deck.')
      if(remove && row.data.length===1) {await deleteAsset(row.id);progress.value=progress.value.filter(p=>p.asset_id!==row.id);result={deleted_deck:true}}
      else {const data=[...row.data];if(remove)data.splice(index,1);else data[index]={id:cardId,front:front.trim(),back:back.trim()};row.data=data;progress.value=progress.value.filter(p=>p.asset_id!==row.id || p.card_index!==index).map(p=>remove&&p.asset_id===row.id&&p.card_index>index?{...p,card_index:p.card_index-1}:p);result={asset:{...row}}}
      persistDemo()
    } else {result=check(await supabase.rpc('update_custom_card',{p_asset_id:asset.id,p_card_id:cardId,p_front:front,p_back:back,p_delete:remove}));progress.value=check(await supabase.from('flashcard_progress').select('*').eq('user_id',auth.user.id));await loadFolder()}
    return result
  }
  async function deleteAsset(id) {
    if (!canEdit.value) throw new Error('Editor access required.')
    if (!auth.demo) check(await supabase.from('study_assets').delete().eq('id', id))
    assets.value = assets.value.filter(a => a.id !== id); persistDemo()
  }
  async function uploadDocument(file) {
    if (auth.demo) throw new Error('Connect your Supabase project to upload files and generate real study materials.')
    if (!canEdit.value || !selectedFolderId.value) throw new Error('Select a folder where you have editor access.')
    if (uploading.value) return
    validateFile(file); uploading.value = true; let documentId
    const folderId=selectedFolderId.value,userId=auth.user.id
    try {
      uploadLabel.value = 'Reading your document…'
      const readingStarted=performance.now()
      const text = await extractOfficeText(file)
      const readMs=Math.min(3600000,Math.max(0,Math.round(performance.now()-readingStarted)))
      if(auth.user?.id!==userId)throw new Error('Your account changed before the upload finished.')
      documentId = crypto.randomUUID()
      const path = `${folderId}/${auth.user.id}/${documentId}.${file.name.split('.').pop().toLowerCase()}`
      const uploadStarted=performance.now()
      check(await supabase.from('document_files').insert({ id: documentId, folder_id: folderId, uploaded_by: auth.user.id, name: file.name.slice(0, 200), storage_path: path, mime_type: fileType(file.name), size_bytes: file.size }))
      uploadLabel.value = 'Uploading privately…'
      check(await supabase.storage.from('study-files').upload(path, file, { contentType: fileType(file.name), upsert: false }))
      const uploadMs=Math.min(3600000,Math.max(0,Math.round(performance.now()-uploadStarted)))
      if(auth.user?.id!==userId)throw new Error('Your account changed before the upload finished.')
      uploadLabel.value = 'Reading your study material…'
      return await enqueueGeneration({document_id:documentId,text,intake:{read_ms:readMs,upload_ms:uploadMs}})
    } finally { uploading.value = false; uploadLabel.value = ''; await loadFolder().catch(() => {}) }
  }
  async function retryDocument(doc) {
    if (auth.demo) return
    if (uploading.value) return
    uploading.value = true; uploadLabel.value = 'Reading your study material…'
    try {
      let text=null
      if(!fileExpiry(doc).expired && !['application/pdf','text/plain'].includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {const blob=check(await supabase.storage.from('study-files').download(doc.storage_path));text=await extractOfficeText(new File([blob],doc.name,{type:doc.mime_type}))}
      return await enqueueGeneration({document_id:doc.id,text})
    } finally { uploading.value = false; uploadLabel.value = ''; await loadFolder().catch(() => {}) }
  }
  async function submitQuiz(asset, answers) {
    const result = auth.demo ? quizResult(asset.data, answers) : check(await supabase.rpc('submit_quiz', { p_asset_id: asset.id, p_answers: answers }))
    const learning=useLearningStore();learning.recordDemo(asset,answers,result);learning.invalidate()
    if (auth.demo) { attempts.value.unshift({ id: crypto.randomUUID(), asset_id: asset.id, correct: result.correct, total: result.total, created_at: new Date().toISOString() }); persistDemo() }
    else await load()
    return result
  }
  async function reviewCard(asset, index, rating) {
    if (!auth.demo) {
      const result = check(await supabase.rpc('review_card', { p_asset_id: asset.id, p_card_index: index, p_rating: rating }))
      progress.value = [...progress.value.filter(p => !(p.asset_id === asset.id && p.card_index === index)), result]; await refreshStats()
    } else {
      const old = progress.value.find(p => p.asset_id === asset.id && p.card_index === index)
      const repetitions = rating === 1 ? 0 : (old?.repetitions || 0) + 1
      const days = rating === 1 ? 0 : rating === 4 ? 3 : repetitions > 1 ? 3 : 1
      progress.value = [...progress.value.filter(p => !(p.asset_id === asset.id && p.card_index === index)), { asset_id: asset.id, card_index: index, repetitions, due_at: new Date(Date.now() + (days ? days * 86400000 : 600000)).toISOString() }]; persistDemo()
    }
  }
  async function logSession(seconds, folderId = selectedFolderId.value) {
    if (!folderId || seconds < 30) return
    if (!auth.demo) { check(await supabase.rpc('log_study_session', { p_folder_id: folderId, p_seconds: Math.min(seconds, 14400) })); await refreshStats() }
    sessions.value.unshift({ folder_id: folderId, duration_seconds: Math.min(seconds, 14400), created_at: new Date().toISOString() }); persistDemo()
  }
  async function createInvitation(role) {
    if (auth.demo) throw new Error('Connect Supabase to invite your study group.')
    const token = check(await supabase.rpc('create_invitation', { p_folder_id: selectedFolderId.value, p_role: role, p_email: null }))
    return invitationUrl(token)
  }
  async function acceptInvitation(value=null) {
    if(value && auth.demo) throw new Error('Connect Supabase and sign in to join a shared space.')
    const token = value ? invitationToken(value) : sessionStorage.getItem('synapse.invite'); if (!token || auth.demo) return
    const id = check(await supabase.rpc('accept_invitation', { p_token: token })); sessionStorage.removeItem('synapse.invite'); selectedFolderId.value = id; await load()
    return id
  }
  async function updateMember(userId, role) { check(await supabase.rpc('update_member', { p_folder_id: selectedFolderId.value, p_user_id: userId, p_role: role })); await loadFolder() }
  async function sendMessage(body) {
    if (!body.trim()) return
    if (auth.demo) { messages.value.push({ id: crypto.randomUUID(), folder_id: selectedFolderId.value, user_id: auth.user.id, body, created_at: new Date().toISOString(), profiles: { display_name: 'You' } }); persistDemo() }
    else { check(await supabase.from('study_messages').insert({ folder_id: selectedFolderId.value, user_id: auth.user.id, body: body.trim() })); await loadFolder(new Set(['study_messages'])) }
  }
  function queueReload(table, payload) {
    if (payload?.eventType === 'DELETE') {
      const state = { study_assets:assets, document_files:documents, study_messages:messages, folder_members:members }[table]
      const old = payload.old || {}
      if (old.id && state && !state.value.some(row => row.id === old.id)) return
      if (old.folder_id && old.folder_id !== selectedFolderId.value) return
    }
    reloadTables.add(table)
    if(table==='document_files')startGenerationMonitor()
    if (reloadTimer) return
    reloadTimer = setTimeout(() => { reloadTimer = null; const tables = new Set(reloadTables); reloadTables.clear(); void loadFolder(tables).catch(e => { error.value = e.message }) }, 350)
  }
  function queueWorkspaceReload() {
    clearTimeout(workspaceReloadTimer)
    const userId = auth.user?.id, version = loadVersion
    workspaceReloadTimer = setTimeout(async () => {
      try {
        const rows = check(await supabase.from('folders').select('*').order('created_at', { ascending:true }))
        if (version !== loadVersion || userId !== auth.user?.id || auth.demo) return
        folders.value = rows
        if (!rows.some(f => f.id === selectedFolderId.value)) await selectFolder(rows[0]?.id || null)
        else await loadFolder(new Set(['folder_members']))
      } catch (err) { if (version === loadVersion) error.value = err.message }
    }, 350)
  }
  async function subscribeFolder() {
    if (!supabase || auth.demo) return
    const version = ++subscriptionVersion, id = selectedFolderId.value
    const previous = folderChannel; folderChannel = null; if (previous) await supabase.removeChannel(previous)
    clearTimeout(reloadTimer); reloadTimer = null; reloadTables.clear()
    if (version !== subscriptionVersion || !id || id !== selectedFolderId.value || !auth.user) return
    const next = supabase.channel(`changes:${id}`); folderChannel = next
    for (const table of ['study_assets', 'document_files', 'study_messages','folder_members']) {
      const reload = payload => { if (version === subscriptionVersion && id === selectedFolderId.value) queueReload(table,payload) }
      for (const event of ['INSERT', 'UPDATE']) next.on('postgres_changes', { event, schema: 'public', table, filter: `folder_id=eq.${id}` }, reload)
      // Supabase cannot filter DELETE events; reload only RLS-visible rows on deletion.
      next.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, reload)
    }
    next.on('postgres_changes', { event:'UPDATE',schema:'public',table:'folders',filter:`id=eq.${id}` }, () => { if (version === subscriptionVersion && id === selectedFolderId.value) queueWorkspaceReload() }).subscribe(state => {
      if (state === 'SUBSCRIBED' && version === subscriptionVersion) {
        queueReload('study_messages')
        queueReload('study_assets') // Recover material inserts missed offline.
      }
    })
  }
  async function subscribe() {
    if (!supabase || auth.demo) return
    const version = ++workspaceSubscriptionVersion, userId = auth.user?.id
    const previous = changeChannel; changeChannel = null; if (previous) await supabase.removeChannel(previous)
    if (version !== workspaceSubscriptionVersion || userId !== auth.user?.id || !userId || auth.demo) return
    const next = supabase.channel(`workspace:${userId}`); changeChannel = next
    const reload = () => { if (version === workspaceSubscriptionVersion && userId === auth.user?.id) queueWorkspaceReload() }
    for (const event of ['INSERT','UPDATE']) {
      next.on('postgres_changes', { event,schema:'public',table:'folders',filter:`owner_id=eq.${userId}` }, reload)
      next.on('postgres_changes', { event,schema:'public',table:'folder_members',filter:`user_id=eq.${userId}` }, reload)
    }
    next.on('postgres_changes', { event:'DELETE',schema:'public',table:'folders' }, payload => { if (folders.value.some(f => f.id === payload.old?.id)) reload() })
      .on('postgres_changes', { event:'DELETE',schema:'public',table:'folder_members' }, payload => { if (!payload.old?.user_id || payload.old.user_id === userId) reload() }).subscribe()
    await subscribeFolder()
  }
  async function dispose() {
    ++generationVersion;for(const timer of generationCompletionTimers.values())clearTimeout(timer);generationCompletionTimers.clear();recentGeneration.value=new Set();clearTimeout(generationTimer);pollingGeneration=false;generationTasks.value=[];generationConnection.value='';globalThis.window?.removeEventListener('online',wakeGeneration);globalThis.document?.removeEventListener('visibilitychange',wakeGeneration);generationListening=false
    ++loadVersion; ++folderVersion; ++subscriptionVersion; ++workspaceSubscriptionVersion; clearTimeout(reloadTimer); reloadTimer = null; clearTimeout(workspaceReloadTimer); reloadTables.clear()
    useLearningStore().dispose()
    const channels = [changeChannel,folderChannel]; changeChannel = null; folderChannel = null
    folders.value = []; assets.value = []; selectedFolderId.value = null; members.value = []; messages.value = []; attempts.value = []; sessions.value = []; progress.value = []; documents.value = []; activities.value = []; moreAssets.value = false; moreDocuments.value = false; personalStats.value = null; loading.value = false
    await Promise.all(channels.filter(Boolean).map(channel => supabase?.removeChannel(channel)))
  }
  return { generationTasks,activeGeneration,folderGeneration,generationConnection,taskForDocument,pollGeneration,saveHighlightCards,updateCustomCard,folders, assets, documents, members, activities, messages, attempts, progress, sessions, selectedFolderId, selectedFolder, folderAssets, latestAssets, folderDocuments, isOwner, canEdit, stats, moreAssets, moreDocuments, loading, uploading, uploadLabel, error, load, loadFolder, loadMore, selectFolder, createFolder, renameFolder, deleteFolder, saveNote, renameAsset, listSets, readAsset, readDocument, refreshAsset, createManualDeck, deleteAsset, uploadDocument, retryDocument, submitQuiz, reviewCard, logSession, createInvitation, acceptInvitation, updateMember, sendMessage, subscribe, dispose }
})
