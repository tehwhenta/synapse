import {plainStudyText} from './richText'

// Authored examples for the disconnected preview only. Never used in live mode
// and never claim to be a Gemini response for arbitrary user material.
const examples=[
 {front:'What makes a graph a tree?',back:'A tree is a connected graph without cycles.',quote:'A tree is a connected graph without cycles.'},
 {front:'What are the two elements of a graph?',back:'Vertices (nodes) and edges (connections).',quote:'A graph is a collection of vertices (nodes) and edges (connections)'},
 {front:'What ordering does a binary search tree preserve?',back:'Values in the left subtree are smaller; values in the right subtree are larger.',quote:'values in the left subtree are smaller and values in the right subtree are larger'},
 {front:'Which traversal produces sorted BST values?',back:'Inorder traversal: left → root → right.',quote:'left → root → right, producing sorted values.'},
 {front:'What does FIFO mean?',back:'First in, first out.',quote:'FIFO means first in first out.'},
]
export function sampleStudyTool(asset,tool,highlights=[]) {
 const source=plainStudyText(asset.content,asset.content_format).replace(/\s+/g,' ').trim()
 if(tool==='highlights'){
  const cards=highlights.map((highlight,i)=>{
   const match=examples.find(e=>source.includes(e.quote) && (e.quote.toLowerCase().includes(highlight.toLowerCase()) || highlight.toLowerCase().includes(e.quote.toLowerCase())))
   return match?{highlight_id:'h'+(i+1),front:match.front,back:match.back,evidence:{source:'reviewer',quote:match.quote}}:null
  })
  return cards.length && cards.every(Boolean)?{cards}:null
 }
 const tree='A tree is a connected graph without cycles.',graph='A graph is a collection of vertices (nodes) and edges (connections)'
 const order='values in the left subtree are smaller and values in the right subtree are larger'
 if(![tree,graph,order].every(quote=>source.includes(quote)))return null
 return {nodes:[
  {id:'c1',label:'Graph',body:'A collection of vertices and edges; it may contain cycles.',evidence:{source:'reviewer',quote:graph}},
  {id:'c2',label:'Tree',body:'A connected graph without cycles.',evidence:{source:'reviewer',quote:tree}},
  {id:'c3',label:'Binary search tree',body:'An ordered tree: smaller values are in the left subtree and larger values in the right.',evidence:{source:'reviewer',quote:order}},
 ],edges:[
  {from:'c2',to:'c1',label:'is a type of',explanation:'A tree is a graph with connectivity and no cycles.',evidence:{source:'reviewer',quote:tree}},
  {from:'c3',to:'c2',label:'adds an ordering to',explanation:'The subtree ordering is the defining search-tree property.',evidence:{source:'reviewer',quote:order}},
 ]}
}
