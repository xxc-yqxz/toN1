// 从 App.vue 原样拷贝的分词逻辑（与 src/renderer/src/App.vue 580-815 行一致）
function isKana(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x3040 && code <= 0x309f) ||
    (code >= 0x30a0 && code <= 0x30ff) ||
    (code >= 0x31f0 && code <= 0x31ff) ||
    ch === 'ー' || ch === 'ゝ' || ch === 'ゞ' || ch === 'ヽ' || ch === 'ヾ'
  )
}
function isCJK(ch) {
  const code = ch.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}
const ZH_BARRIER = new Set(['是', '为', '的', '形'])
const BACKTRACK_ZH_KEYWORDS = new Set(['的', '是', '为', '名词', '形'])
const JA_ONLY_CJK = new Set([
  '気', '売', '読', '駅', '辺', '図', '広', '実', '芸', '発',
  '関', '対', '単', '応', '転', '従', '児', '営', '産', '円',
  '歳', '済', '続', '薬', '価', '変', '検', '雑', '験', '桜',
  '楽', '帰', '県', '毎', '後', '無', '優', '時', '間', '語',
  '題', '問', '話', '聞', '連', '選', '達', '週', '進', '運',
  '動', '強', '値', '質', '悪', '試', '難', '覚', '備', '員',
  '綺', '麗', '漢', '級', '終', '結', '給', '統', '録', '認',
  '調', '訳', '許', '設', '談', '論', '諸', '誰', '網', '総',
  '製', '複', '衛', '術', '規', '観', '触', '計', '詞', '誠',
  '誤', '講', '課', '謝', '議', '護', '負', '貫', '財', '貨',
  '資', '賛', '賞', '費', '賀', '賢', '購', '贈', '込', '違',
  '適', '遺', '遠', '遅', '遷', '還', '齢', '歴', '類', '離',
  '陸', '険', '隊', '階', '際', '陽', '隠', '領', '顔', '頭',
  '願', '額', '飯', '飲', '館', '駆', '駐', '驚', '魚', '鳥',
  '髪', '機', '構', '権', '橋', '極', '歓', '顕', '厳', '闘',
  '脳', '悩', '納', '騒', '増', '臓', '蔵', '層', '荘', '蒼',
  '詔', '渋', '獣', '縦', '粛', '縮', '樹', '収', '執', '衆',
  '鋭', '躍', '預', '揚', '揺', '葉', '様', '窯', '養', '羅',
  '頼', '絡', '濫', '覧', '裏', '竜', '両', '涼', '猟', '緑',
  '臨', '輪', '涙', '塁', '練', '論', '枠', '億', '憶', '穏',
  '禍', '絵', '拡', '殻', '渇', '仮', '換', '簡', '艦', '鑑',
  '環', '監', '寛', '幹', '巻', '陥', '偽', '戯', '犠', '儀',
  '漁', '喫', '詰', '暁', '況', '狭', '頬', '業', '訓', '勲',
  '薫', '恵', '蛍', '掲', '軽', '傾', '継', '撃', '倹', '剣',
  '圏', '献', '鍵', '賢', '謙', '懸', '戻', '塩', '帳', '遡',
  '諦', '辿'
])
const JA_PUNCT = new Set(['、', '。', '？', '！', '…'])
function hasAdjacentKana(chars, index) {
  for (let j = index - 1; j >= 0; j--) {
    if (ZH_BARRIER.has(chars[j])) break
    if (isKana(chars[j])) return true
    if (JA_ONLY_CJK.has(chars[j])) return true
    if (!isCJK(chars[j])) {
      if (JA_PUNCT.has(chars[j])) continue
      break
    }
  }
  for (let j = index + 1; j < chars.length; j++) {
    if (ZH_BARRIER.has(chars[j])) break
    if (isKana(chars[j])) return true
    if (JA_ONLY_CJK.has(chars[j])) return true
    if (!isCJK(chars[j])) {
      if (JA_PUNCT.has(chars[j])) continue
      break
    }
  }
  return false
}
const ZH_KEYWORDS = [
  '暗含', '例句', '说明', '表示', '表达', '强调', '对比', '原因', '并列', '推测',
  '断定', '可能', '打算', '确信', '义务', '接续', '解释', '感觉', '暗示', '主题',
  '对象', '否定', '肯定', '语气', '语感', '翻译', '翻译成', '相当于', '多用于',
  '常用于', '含有', '包含', '例如', '比如', '示例', '注意', '注', '译', '例', '表',
  '意为', '意思是', '指', '指的是', '即', '也就是', '用法', '含义', '意思',
  '除了', '提示', '可以', '还可以', '以及', '但是', '而且', '因为', '所以', '如果',
  '那么', '就是', '只有', '只要', '不仅', '而是', '或者', '还是', '虽然', '因此',
  '由于', '还能', '也能', '往往', '一般', '通常', '常常', '也',
  '是', '为', '名词', '的', '形',
  '动词'
]
function matchZhKeyword(chars, index) {
  for (const kw of ZH_KEYWORDS) {
    const kwChars = [...kw]
    let ok = true
    for (let k = 0; k < kwChars.length; k++) {
      if (chars[index + k] !== kwChars[k]) { ok = false; break }
    }
    if (ok) return kwChars.length
  }
  return 0
}
const JA_WORDS = ['上手', '下手', '苦手']
function matchJaWord(chars, index) {
  for (const w of JA_WORDS) {
    const wChars = [...w]
    let ok = true
    for (let k = 0; k < wChars.length; k++) {
      if (chars[index + k] !== wChars[k]) { ok = false; break }
    }
    if (ok) return wChars.length
  }
  return 0
}
function splitMixedText(text) {
  const chars = [...text]
  const segments = []
  let buf = ''
  let bufLang = null
  const flush = () => {
    const t = buf.trim()
    if (t) segments.push({ text: t, lang: bufLang === 'ja' ? 'ja' : 'zh' })
    buf = ''
    bufLang = null
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (/\s/.test(ch) || ch === '/') { flush(); continue }
    if (isKana(ch)) {
      if (bufLang !== 'ja') flush()
      buf += ch
      bufLang = 'ja'
      continue
    }
    if (isCJK(ch)) {
      const kwLen = matchZhKeyword(chars, i)
      if (kwLen > 0) {
        const kw = chars.slice(i, i + kwLen).join('')
        const needBacktrack = BACKTRACK_ZH_KEYWORDS.has(kw)
        if (bufLang === 'ja' && buf.length > 0 && needBacktrack) {
          let cut = buf.length
          while (cut > 0 && isCJK(buf[cut - 1]) && !ZH_BARRIER.has(buf[cut - 1])) cut--
          if (cut < buf.length) {
            const tailZh = buf.slice(cut)
            buf = buf.slice(0, cut)
            flush()
            buf = tailZh
          } else {
            flush()
          }
        } else if (bufLang !== 'zh') {
          flush()
        }
        for (let k = 0; k < kwLen; k++) buf += chars[i + k]
        i += kwLen - 1
        bufLang = 'zh'
        continue
      }
      const jaWordLen = matchJaWord(chars, i)
      if (jaWordLen > 0) {
        if (bufLang !== 'ja') flush()
        for (let k = 0; k < jaWordLen; k++) buf += chars[i + k]
        i += jaWordLen - 1
        bufLang = 'ja'
        continue
      }
      const lang = JA_ONLY_CJK.has(ch) || hasAdjacentKana(chars, i) ? 'ja' : 'zh'
      if (bufLang !== null && bufLang !== lang) flush()
      buf += ch
      bufLang = lang
      continue
    }
    if (/[0-9A-Za-z]/.test(ch)) {
      const nearKana =
        (i > 0 && isKana(chars[i - 1])) || (i + 1 < chars.length && isKana(chars[i + 1]))
      const lang = nearKana ? 'ja' : bufLang === 'ja' ? 'ja' : 'zh'
      if (bufLang !== null && bufLang !== lang) flush()
      buf += ch
      bufLang = lang
      continue
    }
    if (bufLang === null) { buf += ch; bufLang = 'zh' } else { buf += ch }
  }
  flush()
  return segments
}

const tests = [
  '春子、元気？',
  '今週中に単語を全部覚えるなんて、無理に決まってるよ。',
  '試験が難しかったので、ダメかと思ったが、合格できてよかった。',
  '1. 作谓语：京都の桜は美しい。',
  '2. 修饰名词：昨日、新しい車を買いました。',
  '3. 修饰动词：とても上手にできましたね。',
  '4. て形（并列/中顿）：先生は綺麗で優しいです。',
  '1. 连用形中顿：値段は安く、品質も悪くない。',
  '2. 假定形条件：品がよくて安ければ、よく売れます。',
  '3. 推量形推测：ここは安全だろう。警備員がいるから。',
  'だろう是简体',
  'に対して前加的名词',
  'は除了提示',
  'わけだ暗含',
  '接续：动词て形',
  '接续：动词た形 + ことがある',
  '0. 基本形（作为所有变形的起点）',
  '日本語で',
  '高兴、兴奋、激动',
  '表示强调',
  '③ 对象＋が＋感情/能力相关的部分形容词\n→嫌い、好き、怖い / 上手、下手、苦手',
]

for (const t of tests) {
  const segs = splitMixedText(t)
  console.log(JSON.stringify(t))
  for (const s of segs) console.log('   ', s.lang === 'ja' ? 'ja' : 'zh', '|', s.text)
}
