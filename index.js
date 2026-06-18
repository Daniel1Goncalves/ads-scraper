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

    // Captura page_id dos anunciantes via rede (múltiplas fontes GraphQL)
    const pageIdMap = {}
    page.on('response', async (response) => {
      if (!response.url().includes('/api/graphql')) return
      try {
        const text = await response.text()
        const json = JSON.parse(text.startsWith('for (;;);') ? text.slice(9) : text)

        // Helper para adicionar ao pageIdMap com nome normalizado (trim)
        // source=1: filter autocomplete (confiável para view_all_page_id)
        // source=2: edges/recursive scan (pode não funcionar como page_id no Ad Library)
        const addToMap = (rawName, id, count = 1, source = 2) => {
          const key = rawName.trim()
          if (key && id && !pageIdMap[key]) {
            pageIdMap[key] = { id: String(id), count, source }
          }
        }

        // Fonte 1: filtros laterais (autocomplete) — IDs CONFIÁVEIS
        const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
        if (pages) {
          pages.forEach(p => { if (p.key && p.display_name) addToMap(p.display_name, p.key, p.count, 1) })
        }

        // Fonte 2: resultados dos anúncios (contém page_id de cada ad)
        const edges = json?.data?.ad_library_main?.search_results_connection?.edges
        if (edges) {
          edges.forEach(edge => {
            const node = edge?.node
            if (!node) return
            const pid = node.page_id || node.page?.id
            const pname = node.page_name || node.page?.name
            if (pid && pname) addToMap(pname, pid, 1, 2)
            ;(node.collated_results || []).forEach((r) => {
              const rpid = r.page_id || r.page?.id
              const rpname = r.page_name || r.page?.name
              if (rpid && rpname) addToMap(rpname, rpid, 1, 2)
            })
          })
        }

        // Fonte 3: busca recursiva por page_id em qualquer lugar da resposta
        const findPageIds = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 6) return
          if (obj.page_id && obj.page_name) {
            const pid = String(obj.page_id)
            if (/^\d+$/.test(pid)) addToMap(obj.page_name, pid, 1, 2)
          }
          for (const v of Object.values(obj)) {
            if (Array.isArray(v)) v.forEach(i => findPageIds(i, depth + 1))
            else if (typeof v === 'object') findPageIds(v, depth + 1)
          }
        }
        if (json?.data) findPageIds(json.data)

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

      // Coleta todos os "Identificação da biblioteca" da página em ordem de aparição
      const allLibIds = []
      const pageText = document.body.innerText || ''
      const libRegex = /Identificação da biblioteca[:\s]*(\d{10,})/gi
      let libMatch
      while ((libMatch = libRegex.exec(pageText)) !== null) {
        allLibIds.push(libMatch[1])
      }
      // Fallback: procura números de 15-18 dígitos isolados em spans (Library ID format)
      if (allLibIds.length === 0) {
        document.querySelectorAll('span').forEach(el => {
          if (el.children.length > 0) return
          const t = (el.textContent || '').trim()
          if (/^\d{15,18}$/.test(t)) allLibIds.push(t)
        })
      }

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

          // Landing page URL (extrai de l.php tracking links primeiro)
          let landingUrl = ''
          const allLinks = Array.from(card.querySelectorAll('a[href]'))
          for (const a of allLinks) {
            const h = a.href
            const lMatch = h.match(/l\.facebook\.com\/l\.php\?u=([^&]+)/)
            if (lMatch) {
              try { landingUrl = decodeURIComponent(lMatch[1]) } catch (e) { landingUrl = h }
              break
            }
          }
          if (!landingUrl) {
            for (const a of allLinks) {
              const h = a.href
              if (h.startsWith('http') && !h.includes('facebook.com') && !h.includes('instagram.com')) {
                landingUrl = h; break
              }
            }
          }

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

          // Identificação da biblioteca — pega o ID correspondente à posição deste card
          const adLibraryId = allLibIds[results.length] || ''

          // Page ID e URL do perfil extraídos dos links do card
          // IMPORTANTE: NÃO usa break — precisa capturar tanto pageIdFromLink quanto profileUrl
          let pageIdFromLink = ''
          let profileUrl = ''
          for (const a of card.querySelectorAll('a[href*="facebook.com"]')) {
            const href = a.href
            const isTracking = href.includes('/l.php') || href.startsWith('https://l.') || href.startsWith('http://l.')
            const isContentLink = href.includes('/posts/') || href.includes('/photos/') || href.includes('/videos/') || href.includes('/reels/') || href.includes('/sharer/') || href.includes('/plugins/') || href.includes('/share/')
            if (isTracking || isContentLink) continue

            const domain = href.match(/https?:\/\/([^\/]+)/)
            const isMainDomain = domain && ['www.facebook.com','facebook.com','web.facebook.com'].includes(domain[1])

            // Tenta extrair ID numérico
            const m = href.match(/facebook\.com\/(\d{8,})\/?/)
            if (m && isMainDomain && !pageIdFromLink) {
              pageIdFromLink = m[1]
            }

            // Tenta extrair ID de profile.php?id=
            const pm = href.match(/facebook\.com\/profile\.php\?id=(\d+)/)
            if (pm && isMainDomain && !pageIdFromLink) {
              pageIdFromLink = pm[1]
            }

            // Guarda URL do perfil (primeiro link não-tracking do domínio principal)
            if (!profileUrl && isMainDomain) {
              profileUrl = href
            }
          }

          if (pageName) results.push({ pageName, adText, landingUrl, thumbnail, dateText, pageIdFromLink, profileUrl, adLibraryId })
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
      const name = domAd.pageName.trim()
      if (!name || seenNames.has(name)) return
      seenNames.add(name)

      if (shouldExclude(name, domAd.adText || '', domAd.landingUrl || '')) return

      const info = pageIdMap[name] || {}
      const libraryId = info.id || null
      const pageId = libraryId || domAd.pageIdFromLink || `dom_${i}`

      const isWhatsApp = !!(domAd.landingUrl && (
        domAd.landingUrl.includes('api.whatsapp') ||
        domAd.landingUrl.includes('wa.me') ||
        domAd.landingUrl.includes('whatsapp.com/send')
      ))

      const adLibId = domAd.adLibraryId || null
      // Fallback: usa o link do perfil do Facebook quando não tem libraryId
      const fbProfileUrl = domAd.profileUrl || null
      const pageUrl = libraryId
        ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&search_type=page&view_all_page_id=${libraryId}`
        : adLibId
        ? `https://www.facebook.com/ads/library/?id=${adLibId}`
        : fbProfileUrl
        ? fbProfileUrl  // fallback: link do perfil FB, nunca null
        : null
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
        _fbUrl: fbProfileUrl,
      })
    })

    // Complementa com anunciantes do pageIdMap que não apareceram no DOM (aparecem por último)
    Object.entries(pageIdMap).forEach(([name, info], i) => {
      if (seenNames.has(name)) return
      const pageUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&search_type=page&view_all_page_id=${info.id}`
      profiles.push({
        page_id: info.id,
        page_name: name,
        page_url: pageUrl,
        library_url: searchUrl,
        total_ads: info.count || 1,
        oldest_ad_days: 0,
        top_ad: { id: `ad_extra_${i}`, page_name: name, page_url: pageUrl, library_url: searchUrl, ad_text: '', days_active: 0, started_date: '', thumbnail_url: '', landing_page_url: '', is_whatsapp: false },
        ads: [],
      })
    })

    // Resolve perfis sem ID numérico (vanity/dom) para page_ids da Ad Library
    // Faz fetch da página do Facebook dentro do browser e extrai page_id numérico
    const unresolvedProfiles = profiles.filter(p => {
      const hasNumId = p.page_id && /^\d+$/.test(p.page_id)
      return !hasNumId && p._fbUrl
    })
    if (unresolvedProfiles.length > 0) {
      console.log(`[buscar] resolvendo ${unresolvedProfiles.length} perfis (vanity/dom)...`)
      for (const p of unresolvedProfiles) {
        const fbUrl = p._fbUrl
        try {
          const html = await page.evaluate(async (url) => {
            const r = await fetch(url, { redirect: 'follow', credentials: 'include' })
            return await r.text()
          }, fbUrl)
          const m = html.match(/fb:\/\/page\/(\d+)/)
          if (m) {
            const numId = m[1]
            p.page_id = numId
            p.page_url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&search_type=page&view_all_page_id=${numId}`
            if (p.top_ad) p.top_ad.page_url = p.page_url
            console.log(`[buscar] resolvido: ${p.page_name} → ${numId}`)
          } else {
            console.log(`[buscar] ${p.page_name}: página sem fb://page/ID (html: ${html.length})`)
          }
        } catch (e) {
          console.log(`[buscar] erro ao resolver ${p.page_name}: ${e.message}`)
        }
      }
    }

    const final = profiles.slice(0, 50).map(p => { const { _fbUrl, ...rest } = p; return rest })

    // Log resumo dos tipos de page_id
    const numNum = final.filter(p => p.page_id && /^\d+$/.test(p.page_id)).length
    const numUrlNull = final.filter(p => !p.page_url).length
    console.log(`[buscar] pageIdMap=${Object.keys(pageIdMap).length} dom=${rawAds.length} final=${final.length} | num=${numNum} nullUrl=${numUrlNull}`)
    res.json({ profiles: final })

  } catch (err) {
    console.error('[buscar] erro:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

// Teste de resolução vanity — verifica se fb://page/ID aparece no HTML
app.get('/test-vanity', async (req, res) => {
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

    // Método 1: fetch dentro do browser (mesmo código do /buscar)
    let fetchHtml = '', fetchResult = ''
    try {
      fetchHtml = await page.evaluate(async (fbUrl) => {
        const r = await fetch(fbUrl, { redirect: 'follow', credentials: 'include' })
        return await r.text()
      }, url)
      const m = fetchHtml.match(/fb:\/\/page\/(\d+)/)
      fetchResult = m ? `OK: found id ${m[1]}` : 'FAIL: fb://page/ID not found'
    } catch (e) { fetchResult = `ERROR: ${e.message}` }

    // Método 2: navegação direta (page.goto) e pega o HTML
    let gotoHtml = '', gotoResult = ''
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2000)
      gotoHtml = await page.content()
      const m = gotoHtml.match(/fb:\/\/page\/(\d+)/)
      gotoResult = m ? `OK: found id ${m[1]}` : 'FAIL: fb://page/ID not found'
    } catch (e) { gotoResult = `ERROR: ${e.message}` }

    await context.close()
    res.json({
      url,
      fetch: {
        success: !fetchResult.startsWith('ERROR'),
        result: fetchResult,
        html_length: fetchHtml.length,
        has_page_id: !!fetchHtml.match(/fb:\/\/page\/(\d+)/),
        // Mostra trechos que contêm "page" ou "fb://"
        snippets: [
          fetchHtml.slice(0, 500),
          fetchHtml.slice(Math.max(0, fetchHtml.indexOf('fb://') - 100), fetchHtml.indexOf('fb://') + 200).substring(0, 300) || 'fb:// not found',
          fetchHtml.slice(-300),
        ],
      },
      goto: {
        success: !gotoResult.startsWith('ERROR'),
        result: gotoResult,
        html_length: gotoHtml.length,
        has_page_id: !!gotoHtml.match(/fb:\/\/page\/(\d+)/),
        snippets: [
          gotoHtml.slice(0, 500),
          gotoHtml.slice(Math.max(0, gotoHtml.indexOf('fb://') - 100), gotoHtml.indexOf('fb://') + 200).substring(0, 300) || 'fb:// not found',
          gotoHtml.slice(-300),
        ],
      },
    })
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

// DIAGNÓSTICO V2 — captura TODAS as respostas de rede sem filtro, + DOM completo
app.get('/diagnostico', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Keyword obrigatória. Ex: /diagnostico?q=figurinhas' })

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

    // ===== CAPTURA TODAS AS RESPOSTAS DE REDE =====
    const allResponses = []
    const graphqlResponses = [] // só /api/graphql
    const pageIdMap = {}

    page.on('response', async (response) => {
      const url = response.url()
      const ct = response.headers()['content-type'] || ''
      const isGraphQL = url.includes('/api/graphql')

      try {
        const text = await response.text()
        const snippet = text.slice(0, 800)

        // Guarda amostra de TODA resposta (limitado a 50)
        if (allResponses.length < 50 && !url.includes('static.xx.fbcdn.net') && !url.includes('static.cdn') && !url.match(/\.(js|css|png|jpg|gif|svg|woff)/)) {
          allResponses.push({
            url: url.slice(0, 200),
            content_type: ct.slice(0, 80),
            size: text.length,
            snippet: snippet,
            has_search_results: snippet.includes('search_results_connection'),
            has_ad_data: snippet.includes('page_name') || snippet.includes('page_id') || snippet.includes('ad_text'),
            has_library_id: snippet.includes('Identificação') || snippet.includes('library_id') || snippet.includes('ad_library'),
          })
        }

        if (isGraphQL) {
          const json = JSON.parse(text.startsWith('for (;;);') ? text.slice(9) : text)

          if (graphqlResponses.length < 20) {
            graphqlResponses.push({
              url: url.slice(0, 120),
              size_bytes: text.length,
              data_keys: json?.data ? Object.keys(json.data) : [],
              has_dynamic_filter: !!json?.data?.ad_library_main?.dynamic_filter_options,
              has_search_results: !!json?.data?.ad_library_main?.search_results_connection,
              filter_pages_count: json?.data?.ad_library_main?.dynamic_filter_options?.pages?.length || 0,
              edges_count: json?.data?.ad_library_main?.search_results_connection?.edges?.length || 0,
            })
          }

          // Preenche pageIdMap como de costume
          const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
          if (pages) {
            pages.forEach(p => { if (p.key && p.display_name) pageIdMap[p.display_name] = { id: p.key } })
          }
          const edges = json?.data?.ad_library_main?.search_results_connection?.edges
          if (edges) {
            edges.forEach(edge => {
              const node = edge?.node
              if (!node) return
              const pid = node.page_id || node.page?.id
              const pname = node.page_name || node.page?.name
              if (pid && pname && !pageIdMap[pname]) pageIdMap[pname] = { id: String(pid) }
              ;(node.collated_results || []).forEach(r => {
                const rpid = r.page_id || r.page?.id
                const rpname = r.page_name || r.page?.name
                if (rpid && rpname && !pageIdMap[rpname]) pageIdMap[rpname] = { id: String(rpid) }
              })
            })
          }
          const findPageIds = (obj, depth = 0) => {
            if (!obj || typeof obj !== 'object' || depth > 6) return
            if (obj.page_id && obj.page_name) {
              const pid = String(obj.page_id)
              if (/^\d+$/.test(pid) && !pageIdMap[obj.page_name]) pageIdMap[obj.page_name] = { id: pid }
            }
            for (const v of Object.values(obj)) {
              if (Array.isArray(v)) v.forEach(i => findPageIds(i, depth + 1))
              else if (typeof v === 'object') findPageIds(v, depth + 1)
            }
          }
          if (json?.data) findPageIds(json.data)
        }
      } catch {}
    })

    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(q)}&search_type=keyword_unordered`
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(4000)
    await dismissCookies(page)
    try {
      await page.waitForFunction(() => Array.from(document.querySelectorAll('span')).some(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored'), { timeout: 20000 })
    } catch {}
    for (let i = 0; i < 3; i++) {
      try { await page.evaluate(() => window.scrollBy(0, 2500)) } catch {}
      await page.waitForTimeout(1200)
    }
    await page.waitForTimeout(1500)

    // ===== ANÁLISE DOM COMPLETA =====
    const domAnalysis = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'))
      const sponsoredEls = spans.filter(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')

      return sponsoredEls.slice(0, 5).map((sponsoredEl, idx) => {
        let card = sponsoredEl
        for (let i = 0; i < 15; i++) {
          card = card.parentElement
          if (!card) break
          const rect = card.getBoundingClientRect()
          if (rect.height > 150 && rect.width > 250) break
        }
        if (!card) return { idx, error: 'card nao encontrado' }

        // Nome da página
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

        // Links
        const links = Array.from(card.querySelectorAll('a[href]')).map(a => ({
          text: a.textContent.trim().slice(0, 80),
          href: a.href,
          isFacebook: a.href.includes('facebook.com'),
          isLPhp: a.href.includes('l.php'),
        }))

        // Landing URL extraída de l.php
        let landingUrl = ''
        for (const a of card.querySelectorAll('a[href]')) {
          const m = a.href.match(/l\.facebook\.com\/l\.php\?u=([^&]+)/)
          if (m) { landingUrl = decodeURIComponent(m[1]); break }
        }
        if (!landingUrl) {
          for (const a of card.querySelectorAll('a[href]')) {
            const h = a.href
            if (h.startsWith('http') && !h.includes('facebook.com') && !h.includes('instagram.com')) {
              landingUrl = h; break
            }
          }
        }

        // Imagens
        const images = Array.from(card.querySelectorAll('img')).slice(0, 4).map(img => ({
          src: (img.src || '').slice(0, 120),
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        }))

        // HTML completo do card (sem limite)
        const fullHtml = card.innerHTML

        // Procura por qualquer ID numérico grande no HTML
        const allText = card.textContent
        const libIdMatch = allText.match(/Identificação da biblioteca[:\s]*(\d{10,})/i)
        const numericIds = [...fullHtml.matchAll(/\b(\d{10,})\b/g)].map(m => m[1]).slice(0, 5)

        // Atributos do card
        const cardAttrs = {}
        Array.from(card.attributes || []).forEach(a => { cardAttrs[a.name] = a.value.slice(0, 200) })

        // Procura data-testid ou outros data-* com library/ad
        const dataAttrs = {}
        card.querySelectorAll('[data-testid], [data-ad], [data-page], [data-id]').forEach(el => {
          Array.from(el.attributes).forEach(a => {
            if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value.slice(0, 100)
          })
        })

        return {
          idx,
          pageName,
          links,
          images,
          landingUrl,
          libIdFromText: libIdMatch ? libIdMatch[1] : null,
          numericIdsInHtml: numericIds,
          cardTag: card.tagName,
          cardAttrs,
          fullHtmlLength: fullHtml.length,
          fullHtml,
          dataAttrs,
        }
      })
    })

    // Verifica se alguma resposta tinha search_results ou ad data
    const responsesWithAds = allResponses.filter(r => r.has_ad_data)
    const responsesWithSearch = allResponses.filter(r => r.has_search_results)
    const responsesWithLib = allResponses.filter(r => r.has_library_id)

    res.json({
      keyword: q,
      stats: {
        total_responses_captured: allResponses.length,
        graphql_responses_captured: graphqlResponses.length,
        page_id_map_count: Object.keys(pageIdMap).length,
        responses_with_ad_data: responsesWithAds.length,
        responses_with_search_results: responsesWithSearch.length,
        responses_with_library_id: responsesWithLib.length,
      },
      responses_with_ad_data: responsesWithAds.map(r => ({ url: r.url, snippet: r.snippet.slice(0, 400) })),
      responses_with_search_results: responsesWithSearch.map(r => ({ url: r.url, snippet: r.snippet.slice(0, 400) })),
      responses_with_library_id: responsesWithLib.map(r => ({ url: r.url, snippet: r.snippet.slice(0, 400) })),
      all_responses: allResponses.sort((a, b) => a.size - b.size),
      graphql_responses: graphqlResponses,
      page_id_map_final: Object.fromEntries(Object.entries(pageIdMap).slice(0, 30)),
      dom_cards: domAnalysis,
    })
  } catch (err) {
    console.error('[diagnostico] erro:', err.message, err.stack)
    res.status(500).json({ error: err.message })
  } finally {
    if (browser) await browser.close()
  }
})

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
