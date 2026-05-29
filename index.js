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
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click()
        await page.waitForTimeout(1500)
        return
      }
    } catch {}
  }
}

// Busca lista de anunciantes via GraphQL
async function getAdvertiserList(browser, keyword) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  const advertisers = []

  page.on('response', async (response) => {
    if (!response.url().includes('/api/graphql')) return
    try {
      const text = await response.text()
      const json = JSON.parse(text.startsWith('for (;;);') ? text.slice(9) : text)
      const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
      if (pages && Array.isArray(pages)) {
        pages.forEach(p => {
          if (p.display_name && p.key) {
            advertisers.push({ name: p.display_name, pageId: p.key, count: p.count || 1 })
          }
        })
      }
    } catch {}
  })

  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(5000)
  await dismissCookies(page)
  await page.waitForTimeout(4000)

  await context.close()
  return { advertisers, searchUrl: url }
}

// Visita a página de um anunciante e extrai o primeiro anúncio
async function getFirstAd(browser, pageId) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'pt-BR',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })

  try {
    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${pageId}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(3000)
    await dismissCookies(page)

    // Espera aparecer algum anúncio
    try {
      await page.waitForFunction(() => {
        const spans = Array.from(document.querySelectorAll('span'))
        return spans.some(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      }, { timeout: 10000 })
    } catch {}

    const result = await page.evaluate(() => {
      let adText = ''
      let landingUrl = ''
      let thumbnail = ''

      const spans = Array.from(document.querySelectorAll('span'))
      const sponsoredEl = spans.find(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')

      if (sponsoredEl) {
        // Sobe para achar o card
        let card = sponsoredEl
        for (let i = 0; i < 12; i++) {
          card = card.parentElement
          if (!card) break
          const rect = card.getBoundingClientRect()
          if (rect.height > 200 && rect.width > 200) break
        }

        if (card) {
          // Texto do anúncio
          Array.from(card.querySelectorAll('div, span, p')).forEach(el => {
            if (el.children.length > 3) return
            const t = el.textContent.trim()
            if (t.length > 60 && t.length < 2000) {
              if (t.length > adText.length) adText = t.slice(0, 800)
            }
          })

          // Landing page
          Array.from(card.querySelectorAll('a[href]')).forEach(link => {
            const href = link.href
            if (href && !href.includes('facebook.com') && !href.includes('instagram.com') && href.startsWith('http')) {
              landingUrl = href
            }
          })

          // Thumbnail
          let maxArea = 0
          Array.from(card.querySelectorAll('img')).forEach(img => {
            if (!img.src?.startsWith('http')) return
            const area = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
            if (area > maxArea) { maxArea = area; thumbnail = img.src }
          })
        }
      }

      return { adText, landingUrl, thumbnail }
    })

    return result
  } catch {
    return { adText: '', landingUrl: '', thumbnail: '' }
  } finally {
    await context.close()
  }
}

function shouldExclude(name, adText, landingUrl) {
  const text = (name + ' ' + adText).toLowerCase()
  const url = landingUrl.toLowerCase()

  // WhatsApp
  if (url.includes('api.whatsapp') || url.includes('wa.me') || url.includes('whatsapp.com/send')) return true
  if (text.includes('whatsapp') && (text.includes('compra') || text.includes('pedido') || text.includes('encomenda'))) return true

  // Apostas / jogos de azar
  const gamblingKeywords = ['aposta', 'apostas', 'cassino', 'casino', ' bet', 'bet ', '.bet', 'jogue agora', 'ganhe jogando', 'loteria', 'sorteio', 'slots', 'roleta', 'poker', 'bônus de boas-vindas', 'bonus de boas-vindas', 'depósito mínimo', 'deposito minimo', 'odds', 'esportiva', 'esportivo', 'palpite']
  if (gamblingKeywords.some(k => text.includes(k))) return true
  if (url.includes('bet') || url.includes('casino') || url.includes('cassino') || url.includes('aposta')) return true

  // Loja / produto físico
  const storeKeywords = ['loja ', ' loja', 'store', 'mercado', 'boutique', 'feira', 'empório', 'atacado', 'varejo']
  if (storeKeywords.some(k => text.includes(k))) return true

  const physicalKeywords = ['frete grátis', 'frete gratis', 'envio grátis', 'envio gratis', 'produto físico', 'produto fisico', 'entrega em', 'correios', 'sedex', 'compre e receba']
  if (physicalKeywords.some(k => text.includes(k))) return true

  return false
}

// Busca por keyword
app.get('/buscar', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Keyword obrigatória' })

  let browser
  try {
    browser = await getBrowser()

    // 1. Pega lista de anunciantes
    const { advertisers, searchUrl } = await getAdvertiserList(browser, q)
    console.log(`[buscar] "${q}" → ${advertisers.length} anunciantes (total_ads >= 2)`)

    if (advertisers.length === 0) {
      return res.json({ profiles: [] })
    }

    // 2. Visita cada anunciante em paralelo (5 por vez) para pegar texto e URL
    const BATCH = 5
    const enriched = []

    for (let i = 0; i < advertisers.length; i += BATCH) {
      const batch = advertisers.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (adv) => {
          const { adText, landingUrl, thumbnail } = await getFirstAd(browser, adv.pageId)
          return { ...adv, adText, landingUrl, thumbnail }
        })
      )
      enriched.push(...results)
    }

    // 3. Filtra WhatsApp e lojas
    const filtered = enriched.filter(a => !shouldExclude(a.name, a.adText, a.landingUrl))
    console.log(`[buscar] após filtro: ${filtered.length} anunciantes`)

    // 4. Monta profiles
    const profiles = filtered.map((a, i) => {
      const adObj = {
        id: `ad_${Date.now()}_${i}`,
        page_name: a.name,
        page_url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${a.pageId}`,
        library_url: searchUrl,
        ad_text: a.adText,
        days_active: 0,
        started_date: '',
        thumbnail_url: a.thumbnail,
        landing_page_url: a.landingUrl,
      }
      return {
        page_id: a.pageId,
        page_name: a.name,
        page_url: adObj.page_url,
        library_url: searchUrl,
        total_ads: a.count,
        oldest_ad_days: 0,
        top_ad: adObj,
        ads: [adObj],
      }
    }).sort((a, b) => b.total_ads - a.total_ads).slice(0, 20)

    res.json({ profiles })

  } catch (err) {
    console.error('[buscar] erro:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

// Busca por URL
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
    await page.waitForTimeout(5000)
    await dismissCookies(page)
    try {
      await page.waitForFunction(() => {
        const spans = Array.from(document.querySelectorAll('span'))
        return spans.some(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      }, { timeout: 10000 })
    } catch {}

    const data = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'))
      const sponsoredEl = spans.find(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')
      if (!sponsoredEl) return { pageName: '', pageUrl: '', adText: '', thumbnail: '', landingUrl: '' }

      let card = sponsoredEl
      for (let i = 0; i < 12; i++) {
        card = card.parentElement
        if (!card) break
        const rect = card.getBoundingClientRect()
        if (rect.height > 200 && rect.width > 200) break
      }

      let pageName = '', pageUrl = '', adText = '', thumbnail = '', landingUrl = ''
      if (card) {
        const links = Array.from(card.querySelectorAll('a[href*="facebook.com"]'))
        for (const l of links) { const t = l.textContent.trim(); if (t.length > 1 && t.length < 100) { pageName = t; pageUrl = l.href; break } }
        Array.from(card.querySelectorAll('div,span,p')).forEach(el => {
          if (el.children.length > 3) return
          const t = el.textContent.trim()
          if (t.length > 60 && t.length < 2000 && t.length > adText.length) adText = t.slice(0, 800)
        })
        let maxArea = 0
        Array.from(card.querySelectorAll('img')).forEach(img => {
          if (!img.src?.startsWith('http')) return
          const a = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
          if (a > maxArea) { maxArea = a; thumbnail = img.src }
        })
        Array.from(card.querySelectorAll('a[href]')).forEach(l => {
          const h = l.href
          if (h && !h.includes('facebook.com') && !h.includes('instagram.com') && h.startsWith('http')) landingUrl = h
        })
      }
      return { pageName, pageUrl, adText, thumbnail, landingUrl }
    })

    await context.close()
    res.json({
      ad: { id: `ad_${Date.now()}`, page_name: data.pageName, page_url: data.pageUrl, library_url: url, ad_text: data.adText, days_active: 0, thumbnail_url: data.thumbnail, landing_page_url: data.landingUrl },
      advertiser: { page_name: data.pageName, page_url: data.pageUrl, total_ads: 1 }
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
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
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
