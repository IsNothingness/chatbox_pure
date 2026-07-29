const path = require('node:path')
const { rimrafSync } = require('rimraf')

const rootPath = path.resolve(__dirname, '../..')
const distPath = path
  .join(rootPath, 'release', 'app', 'dist')
  .replaceAll('\\', '/')

rimrafSync(`${distPath}/**/*.map`, { glob: true })
