import {defineStore} from 'pinia'
import {ref,watch} from 'vue'
import {useAuthStore} from './auth'
import {supabase} from '../lib/supabase'

export const useLearningStore=defineStore('learning',()=>{
 const auth=useAuthStore(),mistakes=ref([]),more=ref(false),loading=ref(false),revision=ref(0)
 let version=0
 function demoItems(){try{return JSON.parse(localStorage.getItem('synapse.demo.mistakes') || '[]')}catch{return []}}
 function saveDemo(items){localStorage.setItem('synapse.demo.mistakes',JSON.stringify(items))}
 function dispose(){version++;mistakes.value=[];more.value=false;loading.value=false;revision.value++}
 watch(()=>auth.user?.id,dispose,{flush:'sync'})
 async function load(mastered=false,append=false){
  if(!auth.user){version++;mistakes.value=[];more.value=false;loading.value=false;return}
  const request=++version,uid=auth.user?.id;loading.value=true
  try{
   const last=append?mistakes.value.at(-1):null
   let rows
   if(auth.demo){rows=demoItems().filter(m=>!!m.mastered_at===mastered).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.id.localeCompare(a.id));if(last)rows=rows.filter(m=>m.updated_at<last.updated_at || m.updated_at===last.updated_at && m.id<last.id);rows=rows.slice(0,51)}
   else {const result=await supabase.rpc('my_mistakes',{p_mastered:mastered,p_before:last?.updated_at || null,p_before_id:last?.id || null});if(result.error)throw result.error;rows=result.data || []}
   if(request!==version || uid!==auth.user?.id)return
   more.value=rows.length>50;mistakes.value=append?[...mistakes.value,...rows.slice(0,50)]:rows.slice(0,50)
  }finally{if(request===version)loading.value=false}
 }
 function recordDemo(asset,answers,result){
  if(!auth.demo)return
  const items=demoItems(),stamp=new Date().toISOString()
  result.feedback.forEach((feedback,index)=>{
   if(feedback.correct)return
   const q=asset.data[index],old=items.find(m=>m.asset_id===asset.id&&m.question_index===index)
   const row={id:old?.id || crypto.randomUUID(),asset_id:asset.id,folder_id:asset.folder_id,question_index:index,source_title:asset.title,question:q.question,question_type:q.type,answer:q.answer,accepted_answers:q.accepted_answers || [],explanation:q.explanation || '',user_answer:answers[index] || '',misses:(old?.misses || 0)+1,mastered_at:null,created_at:old?.created_at || stamp,updated_at:stamp}
   if(old)Object.assign(old,row);else items.push(row)
  });saveDemo(items)
 }
 async function setMastered(item,value){
  const request=version,uid=auth.user?.id;if(!uid)return
  if(auth.demo){const items=demoItems(),row=items.find(m=>m.id===item.id);if(row)row.mastered_at=value?new Date().toISOString():null;saveDemo(items)}
  else {const result=await supabase.from('mistake_items').update({mastered_at:value?new Date().toISOString():null}).eq('id',item.id).eq('user_id',auth.user.id);if(result.error)throw result.error}
  if(uid!==auth.user?.id)return
  if(request!==version){revision.value++;return}
  mistakes.value=mistakes.value.filter(m=>m.id!==item.id);revision.value++
 }
 async function remove(item){
  const request=version,uid=auth.user?.id;if(!uid)return
  if(auth.demo)saveDemo(demoItems().filter(m=>m.id!==item.id))
  else {const result=await supabase.from('mistake_items').delete().eq('id',item.id).eq('user_id',auth.user.id);if(result.error)throw result.error}
  if(uid!==auth.user?.id)return
  if(request!==version){revision.value++;return}
  mistakes.value=mistakes.value.filter(m=>m.id!==item.id);revision.value++
 }
 function invalidate(){revision.value++}
 return {mistakes,more,loading,revision,load,recordDemo,setMastered,remove,invalidate,dispose}
})
