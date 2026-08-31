import { readFileSync, writeFileSync } from 'fs'
const file = 'd:/MyCode/toN1/star.json'
const d = JSON.parse(readFileSync(file, 'utf8'))
const f = d.favorites
for (const k of Object.keys(f)) {
  const v = f[k]
  if (typeof v === 'string') {
    try {
      f[k] = JSON.parse(v)
      console.log(`已将 ${k} 从字符串转为数组，共 ${f[k].length} 个词`)
    } catch (e) {
      console.log(`解析失败: ${k}`, e.message)
    }
  }
}
writeFileSync(file, JSON.stringify(d, null, 2) + '\n', 'utf8')
console.log('star.json 修复完成')
