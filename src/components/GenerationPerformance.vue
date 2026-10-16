<script setup>
defineProps({ data:Object })
const labels={prepare:'Source preparation',note:'Reviewer',deck:'Flashcards',quiz:'Practice quiz',highlights_generating:'Highlight cards',highlights_checking:'Highlight source check',connections_generating:'Concept connections',connections_checking:'Connection source check'}
function duration(ms){
 if(ms===null || ms===undefined)return '—'
 const seconds=Math.max(0,Number(ms))/1000
 const rounded=Math.round(seconds)
 return seconds<1?`${Math.round(ms)} ms`:seconds<60?`${seconds.toFixed(1)} s`:`${Math.floor(rounded/60)}m ${rounded%60}s`
}
// No polling in this panel: measurements load only with the admin's refresh.
</script>
<template>
 <section v-if="data" class="inactive-section generation-performance">
  <h2>Generation performance</h2>
  <p class="muted">{{ data.capacity.overall }} tasks overall · up to {{ data.capacity.per_user }} per account · one per material.</p>
  <p v-if="!data.totals.measured" class="empty-state">Timings will appear as new materials are generated.</p>
  <template v-else>
   <div class="admin-metrics timing-metrics">
    <div><span>Average queue wait</span><strong>{{ duration(data.totals.queue_wait_ms) }}</strong><small>Includes scheduled retry waits</small></div>
    <div><span>Average server source reading</span><strong>{{ duration(data.totals.source_read_ms) }}</strong><small>Uncached sources; excludes AI response time</small></div>
    <div><span>Average Gemini response</span><strong>{{ duration(data.totals.gemini_ms) }}</strong><small>Total AI response time per measured stage</small></div>
   </div>
   <p class="tiny muted">{{ data.totals.measured }} measured deliveries · {{ data.totals.draft_retries }} draft corrections · {{ data.totals.provider_retries }} service retries · {{ data.totals.worker_retries }} queued retries</p>
   <details class="timing-details">
    <summary>Compare stages and recent deliveries</summary>
    <p class="tiny muted">Last {{ data.window_days }} days, up to {{ data.sample_limit.toLocaleString() }} recent deliveries. A delivery is one stage, rather than a whole upload. Queue and worker startup are recorded by the database; source reading, AI responses, and saving are recorded by the worker.</p>
    <p v-if="data.streaming" class="tiny muted">First content received: {{ duration(data.streaming.first_token_ms) }} average · Saved worker time: {{ duration(data.streaming.worker_p50_ms) }} median / {{ duration(data.streaming.worker_p95_ms) }} 95th percentile ({{ data.streaming.saved_workers }} saved deliveries). Use comparable sources and load when comparing releases.</p>
    <p v-if="data.intake?.uploads" class="tiny muted">Browser-reported averages across {{ data.intake.uploads }} uploads: source reading {{ duration(data.intake.read_ms) }} · file upload {{ duration(data.intake.upload_ms) }}. DOCX/PPTX text extraction happens in the browser before admission to the queue.</p>
    <div class="timing-table" tabindex="0" aria-label="Generation stage averages; scroll horizontally for all columns">
     <table><thead><tr><th>Stage</th><th>Measured</th><th>Queue</th><th>Startup</th><th>Source</th><th>Gemini</th><th>Save</th></tr></thead><tbody><tr v-for="stage in data.stages" :key="stage.stage"><th>{{ labels[stage.stage] }}</th><td>{{ stage.measured }}</td><td>{{ duration(stage.queue_wait_ms) }}</td><td>{{ duration(stage.dispatch_wait_ms) }}</td><td>{{ duration(stage.source_read_ms) }}</td><td>{{ duration(stage.gemini_ms) }}</td><td>{{ duration(stage.save_ms) }}</td></tr></tbody></table>
    </div>
    <p class="tiny muted">{{ data.totals.source_cached }} of {{ data.totals.source_checks }} measured deliveries reused a prepared source. Provider-reported tokens: {{ data.totals.input_tokens.toLocaleString() }} input · {{ data.totals.output_tokens.toLocaleString() }} output · {{ data.totals.thought_tokens.toLocaleString() }} thinking. These totals include rejected drafts when the provider reports usage.</p>
    <ul class="timing-recent"><li v-for="(run,index) in data.recent" :key="index"><div><strong>{{ run.title }}</strong><span class="tiny muted">{{ labels[run.stage] }} · {{ run.outcome==='saved'?'Saved':run.outcome==='running'?'In progress':run.outcome==='abandoned'?'Worker interrupted':'Requeued or paused' }}</span></div><p class="tiny muted">Queue {{ duration(run.queue_wait_ms) }} · AI {{ duration(run.gemini_ms) }} · {{ (run.draft_retries||0)+(run.provider_retries||0)+(run.worker_retries||0) }} retries</p></li></ul>
   </details>
  </template>
 </section>
</template>
