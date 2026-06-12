const express = require('express')
const { chromium } = require('playwright')

const app = express()
app.use(express.json())

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--js-flags=--max-old-space-size=512',
    ],
  })
}

async function dismissCookies(page) {
  const selectors = [
    'button[data-cookiebanner="accept_button"]',
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Aceitar todos")',
    'button:has-text("Allow essential and optional cookies")',
  ]
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click()
        await page.waitForTimeout(1500)
        return
      }
    } catch {}
  }
}

function shouldExclude(name, adText, landingUrl) {
  const text = (name + ' ' + adText).toLowerCase()
  const url = (landingUrl || '').toLowerCase()

  // Redes sociais como landing page (exceto WhatsApp — é válido)
  if (url && (
    url.includes('instagram.com/') ||
    url.includes('t.me/')
  )) return true

  // Apostas / jogos de azar
  const gambling = ['aposta', 'apostas', 'cassino', 'casino', ' bet', 'bet.', 'betano', 'betnacional', 'jogue agora', 'ganhe jogando', 'loteria', 'slots', 'roleta', 'poker', 'odds', 'depósito mínimo', 'deposito minimo', 'palpite', 'esportiva']
  if (gambling.some(k => text.includes(k))) return true
  if (url.includes('bet') || url.includes('casino') || url.includes('cassino') || url.includes('1mmm')) return true

  // Loja / produto físico
  const store = ['loja ', ' loja', 'boutique', 'feira ', 'atacado', 'varejo']
  if (store.some(k => text.includes(k))) return true

  const physical = ['frete grátis', 'frete gratis', 'envio grátis', 'envio gratis', 'produto físico', 'entrega em', 'correios', 'sedex', 'compre e receba']
  if (physical.some(k => text.includes(k))) return true

  return false
}

// Busca anúncios na página de resultados (uma só visita)
app.get('/buscar', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Keyword obrigatória' })

  let browser
  try {
    browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    // Captura page_id dos anunciantes via rede
    const pageIdMap = {}
    page.on('response', async (response) => {
      if (!response.url().includes('/api/graphql')) return
      try {
        const text = await response.text()
        const json = JSON.parse(text.startsWith('for (;;);') ? text.slice(9) : text)
        const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
        if (pages) {
          pages.forEach(p => {
            if (p.key && p.display_name) {
              if (!pageIdMap[p.display_name]) pageIdMap[p.display_name] = []
              pageIdMap[p.display_name].push({ id: p.key, count: p.count || 1 })
            }
          })
        }
      } catch {}
    })

    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    await dismissCookies(page)

    // Aguarda anúncios aparecerem no DOM
    let domLoaded = false
    try {
      await page.waitForFunction(() => {
        const spans = Array.from(document.querySelectorAll('span'))
        return spans.some(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      }, { timeout: 20000 })
      domLoaded = true
      console.log('[buscar] DOM carregado com anúncios')
    } catch {
      console.log('[buscar] timeout DOM — tentando assim mesmo')
    }

    // Scroll para carregar mais (reduzido para não crashar)
    for (let i = 0; i < 6; i++) {
      try { await page.evaluate(() => window.scrollBy(0, 2500)) } catch {}
      await page.waitForTimeout(1000)
    }
    await page.waitForTimeout(1500)

    // Extrai todos os anúncios do DOM
    let rawAds = []
    try { rawAds = await page.evaluate(() => {
      const results = []
      const seen = new Set()

      const spans = Array.from(document.querySelectorAll('span'))
      const sponsoredEls = spans.filter(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')

      sponsoredEls.forEach(sponsoredEl => {
        try {
          // Sobe para achar o card
          let card = sponsoredEl
          for (let i = 0; i < 15; i++) {
            card = card.parentElement
            if (!card) break
            const rect = card.getBoundingClientRect()
            if (rect.height > 150 && rect.width > 250) break
          }
          if (!card || seen.has(card)) return
          seen.add(card)

          // Nome da página (elemento antes do "Patrocinado")
          let pageName = ''
          let el = sponsoredEl
          for (let i = 0; i < 6; i++) {
            el = el.parentElement
            if (!el) break
            const prev = el.previousElementSibling
            if (prev) {
              const t = prev.textContent.trim()
              if (t.length > 1 && t.length < 100 && t !== 'Patrocinado' && t !== 'Sponsored') {
                pageName = t; break
              }
            }
          }
          if (!pageName) {
            for (const a of card.querySelectorAll('a[href*="facebook.com"]')) {
              const t = a.textContent.trim()
              if (t.length > 1 && t.length < 100) { pageName = t; break }
            }
          }

          // Texto do anúncio
          let adText = ''
          card.querySelectorAll('div, span, p').forEach(el => {
            if (el.children.length > 3) return
            const t = el.textContent.trim()
            if (t.length > 80 && t.length < 2000 && t !== pageName && t !== 'Patrocinado') {
              if (t.length > adText.length) adText = t.slice(0, 600)
            }
          })

          // Landing page URL
          let landingUrl = ''
          card.querySelectorAll('a[href]').forEach(a => {
            const h = a.href
            if (h && !h.includes('facebook.com') && !h.includes('instagram.com') && h.startsWith('http')) {
              landingUrl = h
            }
          })

          // Thumbnail
          let thumbnail = '', maxArea = 0
          card.querySelectorAll('img').forEach(img => {
            if (!img.src?.startsWith('http')) return
            const area = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
            if (area > maxArea) { maxArea = area; thumbnail = img.src }
          })

          // Data
          let dateText = ''
          card.querySelectorAll('span, div').forEach(el => {
            const t = el.textContent.trim()
            if (t.match(/\d+\s*de\s+\w+\s+de\s+\d{4}/) && t.length < 80) dateText = t
          })

          // page_id direto do DOM — extrai de links facebook.com no card
          let domPageId = ''
          for (const a of card.querySelectorAll('a[href*="facebook.com"]')) {
            const h = a.href || ''
            // profile.php?id=123456
            let m = h.match(/profile\.php\?id=(\d+)/)
            if (m) { domPageId = m[1]; break }
            // /people/name/123456
            m = h.match(/\/people\/[^/]+\/(\d+)/)
            if (m) { domPageId = m[1]; break }
            // view_all_page_id=123456
            m = h.match(/view_all_page_id=(\d+)/)
            if (m) { domPageId = m[1]; break }
            // facebook.com/123456 (só dígitos no path)
            m = h.match(/facebook\.com\/(\d{8,})/)
            if (m) { domPageId = m[1]; break }
          }

          if (pageName) results.push({ pageName, adText, landingUrl, thumbnail, dateText, domPageId })
        } catch {}
      })

      return results
    }) } catch (evalErr) { console.error('[buscar] page.evaluate crashed:', evalErr.message) }

    console.log(`[buscar] "${q}" → DOM found: ${rawAds.length} ads, pageIdMap: ${Object.keys(pageIdMap).length}`)

    // Usa rawAds (DOM order = ordem de relevância da biblioteca) como fonte primária
    // pageIdMap serve apenas para enriquecer com page_id
    const seenNames = new Set()
    const profiles = []

    rawAds.forEach((domAd, i) => {
      const name = domAd.pageName
      if (!name) return
      // Dedup por nome+url para permitir anunciantes homônimos
      const deduKey = `${name}::${(domAd.landingUrl || '').slice(0, 60)}`
      if (seenNames.has(deduKey)) return
      seenNames.add(deduKey)

      if (shouldExclude(name, domAd.adText || '', domAd.landingUrl || '')) return

      // Usa page_id extraído do DOM quando disponível (mais confiável)
      const domId = domAd.domPageId || ''
      const infoList = pageIdMap[name] || []
      // Remove da lista o entry que bate com o domId, se houver
      const matchIdx = domId ? infoList.findIndex(x => x.id === domId) : -1
      const info = matchIdx >= 0 ? infoList.splice(matchIdx, 1)[0] : (infoList.shift() || {})
      const pageId = domId || info.id || `dom_${i}`

      const isWhatsApp = !!(domAd.landingUrl && (
        domAd.landingUrl.includes('api.whatsapp') ||
        domAd.landingUrl.includes('wa.me') ||
        domAd.landingUrl.includes('whatsapp.com/send')
      ))

      const pageUrl = pageId && !pageId.startsWith('dom_')
        ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${pageId}`
        : `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(name)}&search_type=page`
      const days = parseDays(domAd.dateText)
      const adObj = {
        id: `ad_${Date.now()}_${i}`,
        page_name: name,
        page_url: pageUrl,
        library_url: searchUrl,
        ad_text: domAd.adText || '',
        days_active: days,
        started_date: domAd.dateText || '',
        thumbnail_url: domAd.thumbnail || '',
        landing_page_url: domAd.landingUrl || '',
        is_whatsapp: isWhatsApp,
      }
      profiles.push({
        page_id: pageId,
        page_name: name,
        page_url: pageUrl,
        library_url: searchUrl,
        total_ads: info.count || 1,
        oldest_ad_days: days,
        top_ad: adObj,
        ads: [adObj],
      })
    })

    // Complementa com anunciantes do pageIdMap que não apareceram no DOM (aparecem por último)
    Object.entries(pageIdMap).forEach(([name, infoList], i) => {
      ;(Array.isArray(infoList) ? infoList : [infoList]).forEach((info, j) => {
        const deduKey = `${name}::extra_${j}`
        if (seenNames.has(deduKey)) return
        seenNames.add(deduKey)
        const pageUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${info.id}`
        profiles.push({
          page_id: info.id,
          page_name: name,
          page_url: pageUrl,
          library_url: searchUrl,
          total_ads: info.count || 1,
          oldest_ad_days: 0,
          top_ad: { id: `ad_extra_${i}_${j}`, page_name: name, page_url: pageUrl, library_url: searchUrl, ad_text: '', days_active: 0, started_date: '', thumbnail_url: '', landing_page_url: '', is_whatsapp: false },
          ads: [],
        })
      })
    })

    const final = profiles.slice(0, 50)

    console.log(`[buscar] pageIdMap=${Object.keys(pageIdMap).length} dom=${rawAds.length} final=${final.length}`)
    res.json({ profiles: final })

  } catch (err) {
    console.error('[buscar] erro:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

// Busca por URL da biblioteca
app.get('/buscar-url', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'URL obrigatória' })

  let browser
  try {
    browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }) })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    await dismissCookies(page)
    try {
      await page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('span')).some(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      }, { timeout: 12000 })
    } catch {}

    const data = await page.evaluate(() => {
      const sponsoredEl = Array.from(document.querySelectorAll('span')).find(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      if (!sponsoredEl) return {}
      let card = sponsoredEl
      for (let i = 0; i < 15; i++) {
        card = card.parentElement
        if (!card) break
        const rect = card.getBoundingClientRect()
        if (rect.height > 150 && rect.width > 250) break
      }
      if (!card) return {}
      let pageName = '', pageUrl = '', adText = '', thumbnail = '', landingUrl = ''
      for (const a of card.querySelectorAll('a[href*="facebook.com"]')) {
        const t = a.textContent.trim()
        if (t.length > 1 && t.length < 100) { pageName = t; pageUrl = a.href; break }
      }
      card.querySelectorAll('div,span,p').forEach(el => {
        if (el.children.length > 3) return
        const t = el.textContent.trim()
        if (t.length > 80 && t.length < 2000 && t.length > adText.length) adText = t.slice(0, 600)
      })
      let maxArea = 0
      card.querySelectorAll('img').forEach(img => {
        if (!img.src?.startsWith('http')) return
        const a = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
        if (a > maxArea) { maxArea = a; thumbnail = img.src }
      })
      card.querySelectorAll('a[href]').forEach(a => {
        const h = a.href
        if (h && !h.includes('facebook.com') && !h.includes('instagram.com') && h.startsWith('http')) landingUrl = h
      })
      return { pageName, pageUrl, adText, thumbnail, landingUrl }
    })

    await context.close()
    res.json({
      ad: { id: `ad_${Date.now()}`, page_name: data.pageName || '', page_url: data.pageUrl || '', library_url: url, ad_text: data.adText || '', days_active: 0, thumbnail_url: data.thumbnail || '', landing_page_url: data.landingUrl || '' },
      advertiser: { page_name: data.pageName || '', page_url: data.pageUrl || '', total_ads: 1 }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

// Scrape de landing page
app.post('/scrape', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL obrigatória' })
  let browser
  try {
    browser = await getBrowser()
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)
    const data = await page.evaluate(() => {
      document.querySelectorAll('script, style, nav, footer').forEach(el => el.remove())
      const title = document.title || document.querySelector('h1')?.textContent?.trim() || ''
      const headlines = []
      document.querySelectorAll('h1, h2, h3').forEach(el => { const t = el.textContent?.trim(); if (t && t.length > 5) headlines.push(t) })
      const cta_texts = []
      document.querySelectorAll('button, a[class*="btn"], a[class*="cta"], input[type="submit"]').forEach(el => { const t = el.textContent?.trim(); if (t && t.length > 2 && t.length < 100) cta_texts.push(t) })
      const full_text = document.body.innerText.slice(0, 8000)
      const images = []
      document.querySelectorAll('img[src]').forEach(el => { const s = el.src; if (s?.startsWith('http') && !s.includes('icon') && !s.includes('logo')) images.push(s) })
      return { title, headlines: headlines.slice(0, 10), cta_texts: Array.from(new Set(cta_texts)).slice(0, 5), full_text, images: images.slice(0, 5) }
    })
    res.json({ url, ...data })
  } catch (err) {
    res.json({ url, title: '', full_text: '', headlines: [], cta_texts: [], images: [], error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

function parseDays(text) {
  if (!text) return 0
  const dateMatch = text.match(/(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/)
  if (dateMatch) {
    const months = { jan:0, fev:1, mar:2, abr:3, mai:4, jun:5, jul:6, ago:7, set:8, out:9, nov:10, dez:11 }
    const d = parseInt(dateMatch[1]), m = months[dateMatch[2].toLowerCase().slice(0,3)], y = parseInt(dateMatch[3])
    if (!isNaN(d) && m !== undefined && !isNaN(y)) {
      const diff = Math.floor((Date.now() - new Date(y, m, d).getTime()) / 86400000)
      return diff > 0 ? diff : 0
    }
  }
  const match = text.match(/(\d+)\s*(dia|day|semana|week|m[eê]s|month)/i)
  if (!match) return 0
  const num = parseInt(match[1]), unit = match[2].toLowerCase()
  if (unit.includes('semana') || unit.includes('week')) return num * 7
  if (unit.startsWith('m')) return num * 30
  return num
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Scraper rodando na porta ${PORT}`))
