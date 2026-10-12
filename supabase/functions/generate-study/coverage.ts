import { guidedPrompt,guidedSchema,validateGuidedOutput } from './guided.ts'
import type { GenerationOptions,PreviousItem } from './guided.ts'
export type SourceConcept = {id:string;label:string;topic_id:string}
export function coveragePrompt(kind:string,options:GenerationOptions) {
 return guidedPrompt(kind,options)+`\n\nThe server supplies the finite UNCOVERED CONCEPT INVENTORY in the user data. Never invent or rename its IDs. Each flashcard/question must test one distinct listed concept and return its exact concept_id; choose exactly the requested number of distinct IDs. Use concept_id as coverage_key. Previous concept coverage is already excluded, even if an earlier saved set was deleted. A reviewer must thoroughly explain ALL the listed uncovered concepts, preserving needed context and source terminology, and return covered_concepts containing every supplied ID exactly once. Do not merely list IDs without teaching those concepts. Return no fabricated or padded content. Coverage is tracked separately for reviewer, flashcard, and quiz formats. Do not claim broader coverage than the source permits.`
}
export function coverageSchema(kind:string,options:GenerationOptions,concepts:SourceConcept[]) {
 const schema:any=guidedSchema(kind,options)
 // A material can contain 500 concepts. Keep these IDs in the reference inventory,
 // not in a large constrained enum; validateCoveredOutput enforces them before saving.
 const conceptId={type:'string',description:'Copy an exact concept ID from the supplied uncovered concept inventory.'}
 if (kind==='note') {schema.required.push('covered_concepts');schema.properties.covered_concepts={type:'array',items:conceptId}}
 else {const item=schema.properties[kind==='deck'?'flashcards':'quiz'].items;item.required.push('concept_id');item.properties.concept_id=conceptId}
 return schema
}
export function validateCoveredOutput(raw:any,kind:string,options:GenerationOptions,previous:PreviousItem[],concepts:SourceConcept[]) {
 if (!Array.isArray(concepts) || !concepts.length) throw new Error('The source coverage inventory is unavailable. Scan the material again.')
 const ids=new Set(concepts.map(c=>c.id))
 if (kind==='note') {
  const covered=raw?.covered_concepts
  if (!Array.isArray(covered) || covered.length!==ids.size || new Set(covered).size!==covered.length || covered.some(id=>!ids.has(id))) throw new Error('AI did not cover all remaining concepts. Existing sets are kept.')
  return {...validateGuidedOutput(raw,kind,options,previous),covered_concepts:covered}
 }
 const key=kind==='deck'?'flashcards':'quiz',items=raw?.[key],chosen=new Set<string>()
 if (!Array.isArray(items)) throw new Error('AI returned an incomplete set.')
 for (const item of items) {
  if (!ids.has(item?.concept_id) || chosen.has(item.concept_id)) throw new Error('AI reused a covered concept or invented a source concept. Existing sets are kept.')
  chosen.add(item.concept_id)
 }
 const value:any=validateGuidedOutput({[key]:items.map((item:any)=>({...item,coverage_key:item.concept_id}))},kind,options,previous)
 return {[key]:value[key].map((item:any,i:number)=>({...item,concept_id:items[i].concept_id}))}
}
