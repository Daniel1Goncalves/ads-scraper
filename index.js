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

// Busca por keyword na biblioteca do Meta
app.get('/buscar', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Keyword obrigatória' })

  let browser
  try {
    browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'pt-BR',
    })
    const page = await context.newPage()

    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(3000)

    // Scroll para carregar mais
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000))
      await page.waitForTimeout(1500)
    }

    const ads = await page.evaluate(() => {
      const results = []
      const cards = document.querySelectorAll('[data-testid="ad-archive-render-ad-card"], [class*="x1qjc9v5"]')

      cards.forEach((card, index) => {
        try {
          const pageNameEl = card.querySelector('a strong, [class*="x193iq5w"]')
          const pageName = pageNameEl?.textContent?.trim() || ''

          const pageLink = card.querySelector('a[href*="facebook.com"]')
          const pageUrl = pageLink?.href || ''

          const adTextEl = card.querySelector('[data-ad-preview="message"], [class*="xdj266r"]')
          const adText = adTextEl?.textContent?.trim() || ''

          const dateEls = card.querySelectorAll('[class*="x1lliihq"]')
          let dateText = ''
          dateEls.forEach(el => {
            const t = el.textContent?.trim() || ''
            if (t.includes('dia') || t.includes('semana') || t.includes('mês') || t.includes('Started')) {
              dateText = t
            }
          })

          const imgEl = card.querySelector('img[src*="fbcdn"], img[src*="facebook"]')
          const thumbnail = imgEl?.src || ''

          const ctaLinks = card.querySelectorAll('a[href]')
          let landingUrl = ''
          ctaLinks.forEach(link => {
            const href = link.href || ''
            if (href && !href.includes('facebook.com') && !href.includes('instagram.com')) {
              landingUrl = href
            }
          })

          if (pageName) {
            results.push({ pageName, pageUrl, adText, dateText, thumbnail, landingUrl, index })
          }
        } catch (e) {}
      })

      return results
    })

    // Agrupa por anunciante
    const map = {}
    ads.forEach((ad, i) => {
      const key = ad.pageName
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
    res.json({ profiles })

  } catch (err) {
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
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(() => {
      const pageName = document.querySelector('a strong')?.textContent?.trim() || ''
      const pageUrl = document.querySelector('a[href*="facebook.com/"]')?.href || ''
      const adText = document.querySelector('[data-ad-preview="message"]')?.textContent?.trim() || ''
      const imgEl = document.querySelector('img[src*="fbcdn"]')
      const thumbnail = imgEl?.src || ''
      const ctaLinks = document.querySelectorAll('a[href]')
      let landingUrl = ''
      ctaLinks.forEach(link => {
        if (link.href && !link.href.includes('facebook.com') && !link.href.includes('instagram.com')) {
          landingUrl = link.href
        }
      })
      const cards = document.querySelectorAll('[data-testid="ad-archive-render-ad-card"]')
      return { pageName, pageUrl, adText, thumbnail, landingUrl, totalAds: cards.length }
    })

    res.json({
      ad: {
        id: `ad_${Date.now()}`,
        page_name: data.pageName,
        page_url: data.pageUrl,
        library_url: url,
        ad_text: data.adText,
        days_active: 0,
        thumbnail_url: data.thumbnail,
        landing_page_url: data.landingUrl,
      },
      advertiser: {
        page_name: data.pageName,
        page_url: data.pageUrl,
        total_ads: data.totalAds,
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
        if (src && src.startsWith('http') && !src.includes('icon') && !src.includes('logo')) {
          images.push(src)
        }
      })

      return {
        title,
        headlines: headlines.slice(0, 10),
        cta_texts: Array.from(new Set(cta_texts)).slice(0, 5),
        full_text,
        images: images.slice(0, 5),
      }
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
  const match = text.match(/(\d+)\s*(dia|day|semana|week|mês|month)/i)
  if (!match) return 0
  const num = parseInt(match[1])
  const unit = match[2].toLowerCase()
  if (unit.includes('semana') || unit.includes('week')) return num * 7
  if (unit.includes('mês') || unit.includes('month')) return num * 30
  return num
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Scraper rodando na porta ${PORT}`))
