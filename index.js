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

// Extrai anúncios interceptando as respostas GraphQL do Facebook
async function scrapeViaNetwork(page, targetUrl) {
  const captured = []

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('facebook.com')) return
    const isGraphQL = url.includes('/api/graphql') || url.includes('graphql?')
    const isAdAPI = url.includes('ads/library/async') || url.includes('search_ads')
    if (!isGraphQL && !isAdAPI) return

    try {
      const text = await response.text()
      const jsonStr = text.startsWith('for (;;);') ? text.slice(9) : text
      if (!jsonStr.trim().startsWith('{') && !jsonStr.trim().startsWith('[')) return
      const json = JSON.parse(jsonStr)
      captured.push(json)
    } catch {}
  })

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // Aguarda anúncios aparecerem (DOM ou rede)
  await page.waitForTimeout(5000)

  // Tenta dispensar cookie banner
  const cookieSelectors = [
    'button[data-cookiebanner="accept_button"]',
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Aceitar todos")',
    'button:has-text("Allow essential and optional cookies")',
  ]
  for (const sel of cookieSelectors) {
    try {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click()
        console.log(`[cookie] clicou: ${sel}`)
        await page.waitForTimeout(2000)
        break
      }
    } catch {}
  }

  // Scroll para disparar mais requisições de rede
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 2500))
    await page.waitForTimeout(2500)
  }

  await page.waitForTimeout(3000)

  console.log(`[network] respostas capturadas: ${captured.length}`)

  // Tenta extrair anúncios das respostas capturadas
  const ads = []
  for (const json of captured) {
    extractAdsFromJSON(json, ads)
  }

  // Fallback: tenta pelo DOM se rede não funcionou
  if (ads.length === 0) {
    const domAds = await extractAdsFromDOM(page)
    ads.push(...domAds)
    console.log(`[dom] fallback encontrou: ${domAds.length}`)
  }

  return ads
}

function extractAdsFromJSON(obj, results, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return

  // Procura por campos típicos de anúncios
  if (obj.page_name && (obj.ad_creative_bodies || obj.snapshot || obj.ad_id)) {
    const ad = {
      pageName: obj.page_name || '',
      pageUrl: obj.page_profile_uri || obj.page_profile_url || '',
      adText: (obj.ad_creative_bodies && obj.ad_creative_bodies[0]) || '',
      thumbnail: (obj.snapshot && obj.snapshot.images && obj.snapshot.images[0] && obj.snapshot.images[0].original_image_url) || '',
      landingUrl: (obj.snapshot && obj.snapshot.link_url) || '',
      dateText: obj.ad_delivery_start_time || '',
    }
    results.push(ad)
    return
  }

  // Busca recursiva em arrays e objetos
  if (Array.isArray(obj)) {
    obj.forEach(item => extractAdsFromJSON(item, results, depth + 1))
  } else {
    Object.values(obj).forEach(val => extractAdsFromJSON(val, results, depth + 1))
  }
}

async function extractAdsFromDOM(page) {
  return page.evaluate(() => {
    const results = []
    const allEls = Array.from(document.querySelectorAll('span, a'))
    const sponsoredEls = allEls.filter(el => {
      const t = el.textContent.trim()
      return (t === 'Patrocinado' || t === 'Sponsored') && el.children.length === 0
    })

    console.log('DOM sponsored found:', sponsoredEls.length)

    const seen = new Set()
    sponsoredEls.forEach(sponsoredEl => {
      try {
        let card = sponsoredEl
        for (let i = 0; i < 12; i++) {
          card = card.parentElement
          if (!card) break
          const rect = card.getBoundingClientRect()
          if (rect.height > 200 && rect.width > 300) break
        }
        if (!card || seen.has(card)) return
        seen.add(card)

        let pageName = ''
        let searchEl = sponsoredEl
        for (let i = 0; i < 6; i++) {
          searchEl = searchEl.parentElement
          if (!searchEl) break
          const prev = searchEl.previousElementSibling
          if (prev) {
            const text = prev.textContent.trim()
            if (text.length > 1 && text.length < 100 && text !== 'Patrocinado' && text !== 'Sponsored') {
              pageName = text; break
            }
          }
        }
        if (!pageName) {
          for (const link of Array.from(card.querySelectorAll('a[href*="facebook.com"]'))) {
            const text = link.textContent.trim()
            if (text.length > 1 && text.length < 100) { pageName = text; break }
          }
        }

        let pageUrl = card.querySelector('a[href*="facebook.com/"]')?.href || ''
        let adText = ''
        Array.from(card.querySelectorAll('div, span, p')).forEach(el => {
          if (el.children.length > 3) return
          const t = el.textContent.trim()
          if (t.length > 60 && t.length < 2000 && t !== pageName && t !== 'Patrocinado') {
            if (t.length > adText.length) adText = t.slice(0, 600)
          }
        })

        let thumbnail = ''
        let maxArea = 0
        Array.from(card.querySelectorAll('img')).forEach(img => {
          if (!img.src?.startsWith('http')) return
          const area = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
          if (area > maxArea) { maxArea = area; thumbnail = img.src }
        })

        let landingUrl = ''
        Array.from(card.querySelectorAll('a[href]')).forEach(link => {
          const href = link.href
          if (href && !href.includes('facebook.com') && !href.includes('instagram.com') && href.startsWith('http')) {
            landingUrl = href
          }
        })

        let dateText = ''
        Array.from(card.querySelectorAll('span, div')).forEach(el => {
          const t = el.textContent.trim()
          if (t.match(/\d+\s*de\s+\w+\s+de\s+\d{4}/) && t.length < 80) dateText = t
        })

        if (pageName) results.push({ pageName, pageUrl, adText, dateText, thumbnail, landingUrl })
      } catch {}
    })
    return results
  })
}

function groupAds(ads, libraryUrl) {
  const map = {}
  ads.forEach((ad, i) => {
    const key = ad.pageName || `unknown_${i}`
    const days = parseDays(ad.dateText)
    const adObj = {
      id: `ad_${Date.now()}_${i}`,
      page_name: ad.pageName,
      page_url: ad.pageUrl,
      library_url: libraryUrl,
      ad_text: ad.adText,
      days_active: days,
      started_date: ad.dateText,
      thumbnail_url: ad.thumbnail,
      landing_page_url: ad.landingUrl,
    }
    if (!map[key]) {
      map[key] = { page_id: `page_${i}`, page_name: ad.pageName, page_url: ad.pageUrl, library_url: libraryUrl, total_ads: 0, oldest_ad_days: 0, top_ad: adObj, ads: [] }
    }
    map[key].total_ads++
    map[key].ads.push(adObj)
    if (days > map[key].oldest_ad_days) { map[key].oldest_ad_days = days; map[key].top_ad = adObj }
  })
  return Object.values(map).sort((a, b) => b.oldest_ad_days - a.oldest_ad_days).slice(0, 30)
}

// Debug: inspeciona estrutura das respostas de rede
app.get('/debug-network', async (req, res) => {
  const { q } = req.query
  const keyword = q || 'pdf'
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

    const captured = []
    page.on('response', async (response) => {
      const url = response.url()
      if (!url.includes('facebook.com')) return
      const isGraphQL = url.includes('/api/graphql') || url.includes('graphql?')
      const isAdAPI = url.includes('ads/library') || url.includes('search_ads')
      if (!isGraphQL && !isAdAPI) return
      try {
        const text = await response.text()
        const jsonStr = text.startsWith('for (;;);') ? text.slice(9) : text
        if (!jsonStr.trim().startsWith('{') && !jsonStr.trim().startsWith('[')) return
        const json = JSON.parse(jsonStr)
        // Pega só os primeiros 2000 chars para não explodir
        captured.push({ url: url.slice(0, 100), preview: JSON.stringify(json).slice(0, 2000) })
      } catch {}
    })

    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(keyword)}&search_type=keyword_unordered`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 2500))
      await page.waitForTimeout(2000)
    }
    await page.waitForTimeout(2000)

    res.json({ total: captured.length, responses: captured })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

// Busca por keyword
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

    // Mascara o webdriver para evitar detecção
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    const ads = await scrapeViaNetwork(page, url)

    console.log(`[buscar] query="${q}" ads_total=${ads.length}`)
    const profiles = groupAds(ads, url)
    res.json({ profiles, debug: { adsFound: ads.length } })

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
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })

    const ads = await scrapeViaNetwork(page, url)
    const first = ads[0] || {}

    res.json({
      ad: {
        id: `ad_${Date.now()}`,
        page_name: first.pageName || '',
        page_url: first.pageUrl || '',
        library_url: url,
        ad_text: first.adText || '',
        days_active: parseDays(first.dateText),
        thumbnail_url: first.thumbnail || '',
        landing_page_url: first.landingUrl || '',
      },
      advertiser: { page_name: first.pageName || '', page_url: first.pageUrl || '', total_ads: ads.length }
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
      document.querySelectorAll('h1, h2, h3').forEach(el => {
        const text = el.textContent?.trim()
        if (text && text.length > 5) headlines.push(text)
      })
      const cta_texts = []
      document.querySelectorAll('button, a[class*="btn"], a[class*="cta"], input[type="submit"]').forEach(el => {
        const text = el.textContent?.trim()
        if (text && text.length > 2 && text.length < 100) cta_texts.push(text)
      })
      const full_text = document.body.innerText.slice(0, 8000)
      const images = []
      document.querySelectorAll('img[src]').forEach(el => {
        const src = el.src
        if (src && src.startsWith('http') && !src.includes('icon') && !src.includes('logo')) images.push(src)
      })
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
    const d = parseInt(dateMatch[1])
    const m = months[dateMatch[2].toLowerCase().slice(0,3)]
    const y = parseInt(dateMatch[3])
    if (!isNaN(d) && m !== undefined && !isNaN(y)) {
      const diff = Math.floor((Date.now() - new Date(y, m, d).getTime()) / 86400000)
      return diff > 0 ? diff : 0
    }
  }
  const match = text.match(/(\d+)\s*(dia|day|semana|week|m[eê]s|month)/i)
  if (!match) return 0
  const num = parseInt(match[1])
  const unit = match[2].toLowerCase()
  if (unit.includes('semana') || unit.includes('week')) return num * 7
  if (unit.startsWith('m')) return num * 30
  return num
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Scraper rodando na porta ${PORT}`))
