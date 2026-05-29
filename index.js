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

async function extractAdsFromPage(page) {
  return page.evaluate(() => {
    const results = []

    // Estratégia 1: data-testid oficial
    let cards = Array.from(document.querySelectorAll('[data-testid="ad-archive-render-ad-card"]'))

    // Estratégia 2: divs grandes que contêm links do Facebook + imagens
    if (cards.length === 0) {
      const allDivs = Array.from(document.querySelectorAll('div'))
      cards = allDivs.filter(div => {
        const hasFbLink = div.querySelector('a[href*="facebook.com"]')
        const hasImg = div.querySelector('img')
        const rect = div.getBoundingClientRect()
        const isCard = rect.height > 150 && rect.height < 2000 && rect.width > 200
        return hasFbLink && hasImg && isCard
      }).filter((div, i, arr) => {
        // Remove divs que são filhos de outros já selecionados
        return !arr.some(other => other !== div && other.contains(div))
      })
    }

    // Estratégia 3: qualquer elemento com texto de anúncio
    if (cards.length === 0) {
      const candidates = Array.from(document.querySelectorAll('div[role="article"], div[class*="ad"], section'))
      cards = candidates.filter(el => {
        const text = el.textContent || ''
        return text.length > 100 && el.querySelector('a[href*="facebook.com"]')
      })
    }

    cards.forEach((card, index) => {
      try {
        // Nome da página
        let pageName = ''
        const strong = card.querySelector('strong')
        if (strong) pageName = strong.textContent.trim()

        if (!pageName) {
          const links = Array.from(card.querySelectorAll('a[href*="facebook.com"]'))
          for (const link of links) {
            const text = link.textContent.trim()
            if (text.length > 2 && text.length < 100 && !text.includes('http')) {
              pageName = text
              break
            }
          }
        }

        // URL da página
        let pageUrl = ''
        const pageLink = card.querySelector('a[href*="facebook.com"]')
        if (pageLink) pageUrl = pageLink.href

        // Texto do anúncio
        let adText = ''
        const allText = Array.from(card.querySelectorAll('span, p, div'))
        for (const el of allText) {
          const t = el.textContent.trim()
          if (t.length > 80 && t.length < 3000 && el.children.length < 5) {
            if (t.length > adText.length) adText = t.slice(0, 500)
          }
        }

        // Thumbnail
        let thumbnail = ''
        const imgs = Array.from(card.querySelectorAll('img'))
        for (const img of imgs) {
          if (img.src && img.src.startsWith('http') && img.width > 50) {
            thumbnail = img.src
            break
          }
        }

        // URL da landing page
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
          if (t.match(/\d+\s*(dia|semana|m[eê]s|week|month|day)/i) && t.length < 80) {
            dateText = t
          }
        })

        if (pageName && pageName.length > 1) {
          results.push({ pageName, pageUrl, adText, dateText, thumbnail, landingUrl, index })
        }
      } catch (e) {}
    })

    return { results, totalCards: cards.length }
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
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()

    const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)

    // Scroll para carregar mais anúncios
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 2000))
      await page.waitForTimeout(1500)
    }

    await page.waitForTimeout(2000)

    const { results: ads, totalCards } = await extractAdsFromPage(page)
    console.log(`[buscar] query="${q}" cards=${totalCards} ads_with_name=${ads.length}`)

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
    res.json({ profiles, debug: { totalCards, adsFound: ads.length } })

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
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(5000)

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
    console.error('[buscar-url] erro:', err.message)
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
  const match = text.match(/(\d+)\s*(dia|day|semana|week|m[eê]s|month)/i)
  if (!match) return 0
  const num = parseInt(match[1])
  const unit = match[2].toLowerCase()
  if (unit.includes('semana') || unit.includes('week')) return num * 7
  if (unit.includes('m') ) return num * 30
  return num
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Scraper rodando na porta ${PORT}`))
