const { pathToFileURL } = require('node:url')

// Electron's utility process supplies its bundled Node runtime. Users do not
// need Node.js installed, a terminal, or a separately running web server.
async function run() {
  if (!process.env.MUZ_SERVER_ENTRY) throw new Error('缺少应用内置服务入口。')
  await import(pathToFileURL(process.env.MUZ_SERVER_ENTRY).href)
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.parentPort?.postMessage({ type: 'startup-error', message })
  console.error(message)
  process.exit(1)
})
