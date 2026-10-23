module.exports = {
  appId: 'com.muzermat.muzmsagent',
  productName: 'muz-ms-agent',
  directories: { app: '.desktop-app', output: 'dist-desktop/release' },
  files: ['desktop/**/*', 'package.json', '!node_modules/**/*'],
  asar: true,
  extraResources: [{ from: '.output', to: 'app-server', filter: ['**/*', '!**/*.map'] }],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // Desktop uses only Electron/Node built-ins; Nitro's complete dependencies
  // are already traced into .output. Returning false also prevents builder
  // from falling back to the parent project's Nuxt dependency collection.
  beforeBuild: async () => false,
  publish: null,
  mac: {
    icon: 'desktop/icon.icns',
    category: 'public.app-category.education',
    target: ['dmg', 'zip'],
    identity: null,
    hardenedRuntime: false,
  },
  dmg: { title: '${productName} ${version}', window: { width: 540, height: 380 } },
  win: { icon: 'desktop/icon.ico', target: [{ target: 'nsis', arch: ['x64'] }], signExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
  },
}
