import {supabase} from './supabase'

export async function invokeGeneration(body) {
 const response=await supabase.functions.invoke('generate-study',{body})
 if(response.error){
  let message=response.error.message
  try{message=(await response.error.context.json()).error || message}catch{}
  const error=new Error(message)
  error.transient=!response.error.context || response.error.context.status>=500
  throw error
 }
 if(response.data?.error)throw new Error(response.data.error)
 return response.data
}
