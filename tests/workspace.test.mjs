import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync, unlinkSync } from 'node:fs'

function memoryStorage() { const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)} }
test('Sample workspace supports isolated folders, saved notes, quizzes, card reviews, and focus progress',async()=>{
  const old={localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage,location:globalThis.location,history:globalThis.history}
  globalThis.localStorage=memoryStorage();globalThis.sessionStorage=memoryStorage();globalThis.location={search:'',pathname:'/',hash:'',origin:'http://localhost:5173'};globalThis.history={replaceState(){}}
  const path=fileURLToPath(new URL('./.workspace-test-runtime.mjs',import.meta.url))
  try{
    const bundled=await build({stdin:{contents:"export { createPinia, setActivePinia } from 'pinia'; export { useAuthStore } from './src/stores/auth.js'; export { useWorkspaceStore } from './src/stores/workspace.js';",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'node',external:['@supabase/supabase-js','cfb'],define:{'import.meta.env':'{}'}})
    writeFileSync(path,bundled.outputFiles[0].contents)
    const {createPinia,setActivePinia,useAuthStore,useWorkspaceStore}=await import(pathToFileURL(path).href)
    setActivePinia(createPinia());const auth=useAuthStore();await auth.initialize();const workspace=useWorkspaceStore();await workspace.load()
    assert.equal(auth.demo,true);assert.equal(workspace.latestAssets.length,3)
    const quiz=workspace.folderAssets.find(x=>x.kind==='quiz');const result=await workspace.submitQuiz(quiz,['Breadth-first search','False','queue','O(n)','inorder']);assert.equal(result.correct,5);assert.equal(workspace.stats.quizzes,1)
    const deck=workspace.folderAssets.find(x=>x.kind==='deck');for(let i=0;i<3;i++)await workspace.reviewCard(deck,0,3);assert.equal(workspace.stats.mastered,1)
    await workspace.logSession(120);assert.equal(workspace.stats.minutes,2)
    const folder=await workspace.createFolder('My own subject','A new start','#8c8d65');assert.equal(workspace.folderAssets.length,0);assert.equal(workspace.canEdit,true)
    await workspace.saveNote('First note','# A note');assert.equal(workspace.folderAssets.length,1);const savedId=workspace.folderAssets[0].id
    await workspace.saveNote('Revised','# Updated',savedId);assert.equal(workspace.folderAssets[0].title,'Revised')
    const custom=await workspace.createManualDeck('My custom deck',[{front:'What is FIFO?',back:'First in, first out.'}])
    assert.equal(custom.kind,'deck');assert.equal(custom.data.length,1);assert.equal(custom.material_id,undefined)
    await assert.rejects(workspace.createManualDeck('Bad cards',[{front:'Question',back:''}]),/question and answer/)
    await workspace.deleteAsset(custom.id)
    await workspace.selectFolder('algorithms');assert.equal(workspace.latestAssets.length,3)
    await workspace.selectFolder(folder.id);await workspace.deleteAsset(savedId);assert.equal(workspace.folderAssets.length,0)
    assert.ok(JSON.parse(localStorage.getItem('synapse.demo')).folders.find(x=>x.id===folder.id))
    await workspace.renameAsset(workspace.assets.find(a=>a.folder_id==='algorithms').id,'An easier title')
    await workspace.deleteFolder();assert.equal(workspace.folders.some(f=>f.id===folder.id),false)
    assert.equal(workspace.selectedFolderId,'algorithms')
    for(const remaining of [...workspace.folders]){await workspace.selectFolder(remaining.id);await workspace.deleteFolder()}
    await workspace.load();assert.equal(workspace.folders.length,0) // Deleting the final demo space must not restore sample data.
    await assert.rejects(workspace.uploadDocument({name:'notes.pdf',size:100}),/Connect your Supabase/)
    await workspace.dispose();assert.equal(workspace.folders.length,0)
  }finally{for(const [key,value]of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}try{unlinkSync(path)}catch{}}
})
