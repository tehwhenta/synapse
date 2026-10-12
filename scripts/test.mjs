import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort()
let failures = 0
// Each file owns its browser/API fixtures; use a separate process for isolation.
for (const file of files) {
  console.log('\n' + file)
  const result = spawnSync(process.execPath, ['tests/' + file], { cwd: root, stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  if (result.error || result.status !== 0) failures++
}
console.log(`\n${files.length - failures}/${files.length} test files passed.`)
process.exitCode = failures ? 1 : 0
