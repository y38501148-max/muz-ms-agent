import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
await access(join(root, '.output/server/index.mjs'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const directory = join(root, '.desktop-app')
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })
await cp(join(root, 'desktop'), join(directory, 'desktop'), { recursive: true })
await writeFile(join(directory, 'package.json'), JSON.stringify({
  name: manifest.name,
  productName: 'muz-ms-agent',
  version: manifest.version,
  description: '面向岗位、公司与个人经历的面试练习应用',
  author: 'muzermat',
  private: true,
  main: 'desktop/main.cjs',
  dependencies: {},
}, null, 2) + '\n')
console.log('Desktop application prepared in .desktop-app')
