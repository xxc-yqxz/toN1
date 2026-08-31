import fs from 'node:fs'
import path from 'node:path'

const base = 'd:/MyCode/toN1/node_modules/.pnpm'
const evNM = path.join(
  base,
  'electron-vite@5.0.0_vite@7._1e642f3e2bd58ffc21741a1ac8ab5815',
  'node_modules'
)
const viteNM = path.join(evNM, 'vite', 'node_modules')
fs.mkdirSync(viteNM, { recursive: true })

// 取真实源目录（若为符号链接则解引用到目标内容）
function realSrc(src) {
  try {
    const st = fs.lstatSync(src)
    if (st.isSymbolicLink()) {
      let t = fs.readlinkSync(src).replace(/[\\/]+$/, '')
      if (!path.isAbsolute(t)) t = path.join(path.dirname(src), t)
      if (fs.existsSync(t)) return t
    }
  } catch {}
  return src
}

// 平台过滤：只复制当前平台需要的原生绑定
function isNeeded(dep) {
  if (dep.startsWith('@rollup/rollup-')) return dep === '@rollup/rollup-win32-x64-msvc'
  if (dep.startsWith('@esbuild/')) return dep === '@esbuild/win32-x64'
  return true
}

const done = new Set() // `${name}|${destDir}`

function copyPkg(name, src, destDir, depth = 0) {
  const key = `${name}|${destDir}`
  if (done.has(key)) return
  done.add(key)

  const rsrc = realSrc(src)
  if (!fs.existsSync(rsrc)) {
    console.log('  MISS:', '  '.repeat(depth), name, '<-', src)
    return
  }
  const dest = path.join(destDir, name)
  if (!fs.existsSync(path.join(dest, 'package.json'))) {
    if (fs.existsSync(dest)) {
      try {
        fs.rmSync(dest, { recursive: true, force: true })
      } catch {}
    }
    try {
      fs.cpSync(rsrc, dest, { recursive: true })
      console.log('  copied:', '  '.repeat(depth), name, '->', path.relative(base, dest))
    } catch (e) {
      console.log('  FAIL:', '  '.repeat(depth), name, e.message)
      return
    }
  }

  // 递归复制该包的依赖（从 store 同层 node_modules 根定位）
  let pkgJson = null
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(rsrc, 'package.json'), 'utf8'))
  } catch {
    return
  }
  const deps = { ...(pkgJson.dependencies || {}), ...(pkgJson.optionalDependencies || {}) }
  const parentNM = path.dirname(src) // store 中该包所在 node_modules 根（含其依赖链接）
  for (const dep of Object.keys(deps)) {
    if (!isNeeded(dep)) continue
    copyPkg(dep, path.join(parentNM, dep), destDir, depth + 1)
  }
}

// vite 的依赖 → vite/node_modules（私有，版本与 vite@7.3.2 一致）
const viteStoreNM = path.join(base, 'vite@7.3.2_@types+node@25.6.0_jiti@2.6.1', 'node_modules')
for (const n of ['esbuild', 'fdir', 'picomatch', 'postcss', 'rollup', 'tinyglobby', 'jiti', '@types/node']) {
  copyPkg(n, path.join(viteStoreNM, n), viteNM)
}

// electron-vite 的依赖 → electron-vite/node_modules
for (const n of ['@babel/code-frame', 'cac', 'esbuild', 'magic-string', 'picocolors']) {
  copyPkg(n, path.join(evNM, n), evNM)
}

console.log('=== verify ===')
for (const [label, dir] of [['vite', viteNM], ['ev', evNM]]) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'vite' || n.startsWith('.') || n.endsWith('_tmp')) continue
    try {
      fs.realpathSync(path.join(dir, n, 'package.json'))
      console.log(label, n, 'OK')
    } catch {
      console.log(label, n, 'BROKEN')
    }
  }
}
