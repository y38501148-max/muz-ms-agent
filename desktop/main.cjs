const { app, BrowserWindow, dialog, Menu, shell, utilityProcess } = require('electron')
const { mkdir, access } = require('node:fs/promises')
const { createWriteStream } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

app.setName('muz-ms-agent')
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let window
let service
let origin
let quitting = false
let starting = false
let log
const serviceToken = randomBytes(32).toString('hex')

function isLocalUrl(value) {
  try { return Boolean(origin) && new URL(value).origin === origin } catch { return false }
}

function openReference(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) {
      shell.openExternal(url.href).catch(() => {})
    }
  } catch {}
}

function createWindow() {
  window = new BrowserWindow({
    title: 'muz-ms-agent',
    width: 1440,
    height: 940,
    minWidth: 920,
    minHeight: 680,
    icon: join(__dirname, 'icon.png'),
    backgroundColor: '#f7f8fa',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => { window = undefined })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) window?.loadURL(url).catch(showStartupError)
    else openReference(url)
    return { action: 'deny' }
  })
  for (const eventName of ['will-navigate', 'will-redirect']) {
    window.webContents.on(eventName, (event, url) => {
      if (isLocalUrl(url)) return
      event.preventDefault()
      openReference(url)
    })
  }
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // The renderer has no preload or native IPC. Only this app's loopback origin
  // receives the per-launch credential used by the API and forwarded by SSR.
  const browserSession = window.webContents.session
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    if (isLocalUrl(details.url)) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'x-muz-desktop-token') delete headers[name]
      }
      headers['X-Muz-Desktop-Token'] = serviceToken
    }
    callback({ requestHeaders: headers })
  })
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isLocalUrl(details.url)) return callback({})
    callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'"],
    } })
  })
  browserSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存导出文件' })
  })
  return window.loadFile(join(__dirname, 'startup.html'))
}

async function startService() {
  const outputDirectory = app.isPackaged
    ? join(process.resourcesPath, 'app-server')
    : join(app.getAppPath(), '.output')
  const entry = join(outputDirectory, 'server', 'index.mjs')
  await access(entry)
  const dataDirectory = join(app.getPath('userData'), 'data')
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })

  return new Promise((resolve, reject) => {
    let settled = false
    let pendingOutput = ''
    const childEnvironment = { ...process.env,
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '0',
      MUZ_SERVER_ENTRY: entry,
      MUZ_DATA_DIR: dataDirectory,
      MUZ_DESKTOP_TOKEN: serviceToken,
    }
    // An inherited shell option must not redirect the bundled local service.
    for (const key of ['NITRO_UNIX_SOCKET', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete childEnvironment[key]
    const child = utilityProcess.fork(join(__dirname, 'service.cjs'), [], {
      cwd: app.getPath('userData'),
      env: childEnvironment,
      stdio: 'pipe',
      serviceName: 'muz-ms-agent 本地服务',
    })
    service = child
    const timer = setTimeout(() => finish(new Error('本地服务在 30 秒内没有完成启动。')), 30_000)
    function finish(error, serviceOrigin) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { child.kill(); reject(error) } else resolve(serviceOrigin)
    }
    child.on('message', (message) => {
      if (message?.type === 'startup-error') finish(new Error(message.message))
    })
    child.stdout?.on('data', (chunk) => {
      log?.write(chunk)
      pendingOutput += chunk.toString()
      const lines = pendingOutput.split(/\r?\n/)
      pendingOutput = lines.pop() || ''
      for (const line of lines) {
        // Nitro supports NITRO_PORT=0 and reports the OS-assigned bound port.
        const match = line.match(/^Listening on (http:\/\/127\.0\.0\.1:\d+)\/?$/)
        if (!match || settled) continue
        const serviceOrigin = new URL(match[1]).origin
        fetch(`${serviceOrigin}/api/catalog`, {
          headers: { 'X-Muz-Desktop-Token': serviceToken },
          signal: AbortSignal.timeout(10_000),
        }).then(async (response) => {
          if (!response.ok) throw new Error(`本地服务检查失败（${response.status}）。`)
          await response.json()
          finish(undefined, serviceOrigin)
        }).catch(finish)
      }
    })
    child.stderr?.on('data', (chunk) => log?.write(chunk))
    child.on('exit', (code) => {
      if (service === child) service = undefined
      finish(new Error(`本地服务提前退出（${code}）。`))
      if (!starting && !quitting) void showStartupError(new Error(`本地服务已停止（${code}）。`))
    })
  })
}

async function showStartupError(error) {
  if (quitting) return
  const details = error instanceof Error ? error.message : String(error)
  log?.write(`[desktop] ${details}\n`)
  const options = {
    type: 'error',
    title: 'muz-ms-agent 无法启动',
    message: '本地面试服务未能正常运行。',
    detail: `${details}\n\n练习数据保存在：${join(app.getPath('userData'), 'data')}\n诊断日志：${join(app.getPath('logs'), 'desktop.log')}`,
    buttons: ['重新启动', '退出应用'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const result = await (window && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options))
  if (result.response === 0) { app.relaunch(); app.quit() } else app.quit()
}

async function launch() {
  starting = true
  try {
    app.setAppLogsPath()
    await mkdir(app.getPath('logs'), { recursive: true, mode: 0o700 })
    log = createWriteStream(join(app.getPath('logs'), 'desktop.log'), { flags: 'w', mode: 0o600 })
    log.on('error', () => { log = undefined })
    await createWindow()
    origin = await startService()
    if (!quitting) await window?.loadURL(origin)
  } catch (error) {
    if (!quitting) await showStartupError(error)
  } finally { starting = false }
}

if (hasLock) {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.setIcon(join(__dirname, 'icon.png'))
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]))
    void launch()
  })
  // Closing the sole application window also releases the service on macOS.
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    const child = service
    if (!child) return
    event.preventDefault()
    const timer = setTimeout(() => app.exit(0), 5_000)
    child.once('exit', () => { clearTimeout(timer); log?.end(); app.quit() })
    child.kill()
  })
}
