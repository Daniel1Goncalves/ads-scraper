const express = require('express')
const { chromium } = require('playwright')

const app = express()
app.use(express.json())

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

async function dismissCookieBanner(page) {
  try {
    // Tenta clicar em "Allow all cookies" / "Aceitar todos" / "Allow essential and optional cookies"
    const selectors = [
      'button[data-cookiebanner="accept_button"]',
      'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
      '[data-testid="cookie-policy-manage-dialog-accept-button"]',
      'button:has-text("Allow all cookies")',
      'button:has-text("Aceitar todos os cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Allow essential and optional cookies")',
      '[aria-label="Allow all cookies"]',
    ]
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first()
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click()
          await page.waitForTimeout(2000)
          console.log(`[cookie] clicou: ${sel}`)
          return
        }
      } catch {}
    }
  } catch {}
}

async function scrollAndWait(page, times = 8) {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.scrollBy(0, 2500))
    await page.waitForTimeout(2000)
  }
  await page.waitForTimeout(2000)
}

async function extractAdsFromPage(page) {
  return page.evaluate(() => {
    const results = []

    // Âncora: "Patrocinado" ou "Sponsored"
    const allEls = Array.from(document.querySelectorAll('span, a'))
    const sponsoredEls = allEls.filter(el => {
      const t = el.textContent.trim()
      return (t === 'Patrocinado' || t === 'Sponsored') && el.children.length === 0
    })

    const seen = new Set()

    sponsoredEls.forEach(sponsoredEl => {
      try {
        // Sobe até achar o card pai com tamanho adequado
        let card = sponsoredEl
        for (let i = 0; i < 12; i++) {
          card = card.parentElement
          if (!card) break
          const rect = card.getBoundingClientRect()
          if (rect.height > 200 && rect.width > 300) break
        }
        if (!card) return
        if (seen.has(card)) return
        seen.add(card)

        // Nome da página — elemento anterior ao "Patrocinado"
        let pageName = ''
        let searchEl = sponsoredEl
        for (let i = 0; i < 6; i++) {
          searchEl = searchEl.parentElement
          if (!searchEl) break
          const prev = searchEl.previousElementSibling
          if (prev) {
            const text = prev.textContent.trim()
            if (text.length > 1 && text.length < 100 && !text.includes('Patrocinado') && !text.includes('Sponsored')) {
              pageName = text
              break
            }
          }
        }

        // Fallback: primeiro link com texto legível
        if (!pageName) {
          for (const link of Array.from(card.querySelectorAll('a[href*="facebook.com"]'))) {
            const text = link.textContent.trim()
            if (text.length > 1 && text.length < 100) { pageName = text; break }
          }
        }

        // URL da página
        let pageUrl = ''
        const pageLink = card.querySelector('a[href*="facebook.com/"]')
        if (pageLink) pageUrl = pageLink.href

        // Texto do anúncio
        let adText = ''
        Array.from(card.querySelectorAll('div, span, p')).forEach(el => {
          if (el.children.length > 3) return
          const t = el.textContent.trim()
          if (t.length > 60 && t.length < 2000 && t !== pageName && !t.includes('Patrocinado')) {
            if (t.length > adText.length) adText = t.slice(0, 600)
          }
        })

        // Thumbnail
        let thumbnail = ''
        let maxArea = 0
        Array.from(card.querySelectorAll('img')).forEach(img => {
          if (!img.src || !img.src.startsWith('http')) return
          const area = (img.naturalWidth || img.width || 1) * (img.naturalHeight || img.height || 1)
          if (area > maxArea) { maxArea = area; thumbnail = img.src }
        })

        // Landing page
        let landingUrl = ''
        Array.from(card.querySelectorAll('a[href]')).forEach(link => {
          const href = link.href
          if (href && !href.includes('facebook.com') && !href.includes('instagram.com') && href.startsWith('http')) {
            landingUrl = href
          }
        })

        // Data
        let dateText = ''
        Array.from(card.querySelectorAll('span, div')).forEach(el => {
          const t = el.textContent.trim()
          if (t.match(/\d+\s*de\s+\w+\s+de\s+\d{4}/) && t.length < 80) dateText = t
          else if (t.match(/\d+\s*(dia|semana|m[eê]s|week|month|day)/i) && t.length < 60) dateText = t
        })

        if (pageName) results.push({ pageName, pageUrl, adText, dateText, thumbnail, landingUrl })
      } catch {}
    })

    return { results, totalSponsored: sponsoredEls.length }
  })
}

// Screenshot para debug
app.get('/screenshot', async (req, res) => {
  const { url } = req.query
  const targetUrl = url || 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=pdf&search_type=keyword_unordered'
  let browser
  try {
    browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    await dismissCookieBanner(page)
    await page.waitForTimeout(3000)
    const screenshot = await page.screenshot({ fullPage: false })
    const html = await page.content()
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000))
    res.json({
      screenshot: screenshot.toString('base64'),
      bodyText,
      url: page.url()
    })
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

    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)

    await dismissCookieBanner(page)
    await page.waitForTimeout(3000)

    await scrollAndWait(page, 8)

    const { results: ads, totalSponsored } = await extractAdsFromPage(page)
    const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 500))
    console.log(`[buscar] query="${q}" sponsored_found=${totalSponsored} ads=${ads.length}`)
    console.log(`[buscar] page snippet: ${bodySnippet.replace(/\n/g, ' ').slice(0, 200)}`)

    const map = {}
    ads.forEach((ad, i) => {
      const key = ad.pageName || `unknown_${i}`
      const days = parseDays(ad.dateText)
      const adObj = {
        id: `ad_${Date.now()}_${i}`,
        page_name: ad.pageName,
        page_url: ad.pageUrl,
        library_url: url,
        ad_text: ad.adText,
        days_active: days,
        started_date: ad.dateText,
        thumbnail_url: ad.thumbnail,
        landing_page_url: ad.landingUrl,
      }
      if (!map[key]) {
        map[key] = {
          page_id: `page_${i}`,
          page_name: ad.pageName,
          page_url: ad.pageUrl,
          library_url: url,
          total_ads: 0,
          oldest_ad_days: 0,
          top_ad: adObj,
          ads: [],
        }
      }
      map[key].total_ads++
      map[key].ads.push(adObj)
      if (days > map[key].oldest_ad_days) {
        map[key].oldest_ad_days = days
        map[key].top_ad = adObj
      }
    })

    const profiles = Object.values(map).sort((a, b) => b.oldest_ad_days - a.oldest_ad_days).slice(0, 30)
    res.json({ profiles, debug: { totalSponsored, adsExtracted: ads.length } })

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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)
    await dismissCookieBanner(page)
    await page.waitForTimeout(2000)
    await scrollAndWait(page, 3)

    const { results: ads } = await extractAdsFromPage(page)
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
      advertiser: {
        page_name: first.pageName || '',
        page_url: first.pageUrl || '',
        total_ads: ads.length,
      }
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
