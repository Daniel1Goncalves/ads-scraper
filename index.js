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

        // Fonte 1: filtros laterais (autocomplete)
        const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
        if (pages) {
          pages.forEach(p => { if (p.key && p.display_name) pageIdMap[p.display_name] = { id: p.key, count: p.count || 1 } })
        }

        // Fonte 2: resultados dos anúncios (contém page_id de cada ad)
        const edges = json?.data?.ad_library_main?.search_results_connection?.edges
        if (edges) {
          edges.forEach(edge => {
            const node = edge?.node
            if (!node) return
            const pid = node.page_id || node.page?.id
            const pname = node.page_name || node.page?.name
            if (pid && pname && !pageIdMap[pname]) {
              pageIdMap[pname] = { id: String(pid), count: 1 }
            }
            // Às vezes está em collated_results
            ;(node.collated_results || []).forEach((r) => {
              const rpid = r.page_id || r.page?.id
              const rpname = r.page_name || r.page?.name
              if (rpid && rpname && !pageIdMap[rpname]) {
                pageIdMap[rpname] = { id: String(rpid), count: 1 }
              }
            })
          })
        }

        // Fonte 3: busca recursiva por page_id em qualquer lugar da resposta
        const findPageIds = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 6) return
          if (obj.page_id && obj.page_name) {
            const pid = String(obj.page_id)
            if (/^\d+$/.test(pid) && !pageIdMap[obj.page_name]) {
              pageIdMap[obj.page_name] = { id: pid, count: 1 }
            }
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

          // Page ID extraído do link do perfil facebook.com/[NUMERIC_ID]/
          let pageIdFromLink = ''
          let profileUrl = ''
          for (const a of card.querySelectorAll('a[href*="facebook.com"]')) {
            const href = a.href
            // Tenta extrair ID numérico do link direto: facebook.com/12345678/
            let m = href.match(/facebook\.com\/(\d{8,})\/?/)
            if (m) { pageIdFromLink = m[1]; break }
            // Tenta extrair ID de profile.php?id=
            m = href.match(/facebook\.com\/profile\.php\?id=(\d+)/)
            if (m) { pageIdFromLink = m[1]; break }
            // Se não achou ID numérico, guarda a URL do perfil (vanity) como fallback
            if (!profileUrl && href.includes('facebook.com')) {
              profileUrl = href
            }
          }

          if (pageName) results.push({ pageName, adText, landingUrl, thumbnail, dateText, pageIdFromLink, profileUrl })
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
      // Prioridade: filter autocomplete/GraphQL → link do perfil no DOM (numérico) → profile.php?id → URL do perfil (vanity) → fallback sintético
      const resolvedId = info.id || domAd.pageIdFromLink || null
      // Extrai vanity do profileUrl se existir (ex: "cocacolabr" de "facebook.com/cocacolabr")
      const profileFacebookUrl = !resolvedId && domAd.profileUrl ? domAd.profileUrl : ''
      const vanityMatch = profileFacebookUrl
        ? profileFacebookUrl.match(/facebook\.com\/([^/?]+)/)
        : null
      const vanityName = vanityMatch ? vanityMatch[1] : null
      const pageId = resolvedId || (vanityName ? `vanity_${vanityName}` : `dom_${i}`)

      const isWhatsApp = !!(domAd.landingUrl && (
        domAd.landingUrl.includes('api.whatsapp') ||
        domAd.landingUrl.includes('wa.me') ||
        domAd.landingUrl.includes('whatsapp.com/send')
      ))

      // Constrói URL da melhor forma possível
      let pageUrl
      if (resolvedId) {
        pageUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&search_type=page&view_all_page_id=${resolvedId}`
      } else if (vanityName) {
        // Tentativa com view_all_page_id=vanity (pode funcionar)
        pageUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&search_type=page&view_all_page_id=${vanityName}`
      } else {
        pageUrl = searchUrl
      }
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
        _fbUrl: profileFacebookUrl || undefined,
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

    // Tenta resolver vanity URLs para page_ids numéricos (fetch dentro do browser, compartilha cookies)
    const vanityProfiles = profiles.filter(p => p.page_id && p.page_id.startsWith('vanity_'))
    if (vanityProfiles.length > 0) {
      console.log(`[buscar] resolvendo ${vanityProfiles.length} vanity URLs...`)
      for (const p of vanityProfiles) {
        const fbUrl = p._fbUrl
        if (!fbUrl) { console.log(`[buscar] ${p.page_name}: sem _fbUrl`); continue }
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
            console.log(`[buscar] vanity resolvido: ${p.page_name} → ${numId}`)
          } else {
            console.log(`[buscar] ${p.page_name}: página não tinha fb://page/ID no HTML (html length: ${html.length})`)
          }
        } catch (e) {
          console.log(`[buscar] erro ao resolver ${p.page_name}: ${e.message}`)
        }
      }
    }

    const final = profiles.slice(0, 50).map(p => { const { _fbUrl, ...rest } = p; return rest })

    // Log resumo dos tipos de page_id
    const numNum = final.filter(p => p.page_id && /^\d+$/.test(p.page_id)).length
    const numVanity = final.filter(p => p.page_id && p.page_id.startsWith('vanity_')).length
    const numDom = final.filter(p => p.page_id && p.page_id.startsWith('dom_')).length
    console.log(`[buscar] pageIdMap=${Object.keys(pageIdMap).length} dom=${rawAds.length} final=${final.length} | num=${numNum} vanity=${numVanity} dom=${numDom}`)
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

// DIAGNÓSTICO — captura tudo que o Meta envia e como o DOM está estruturado
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

    // Captura TODAS as respostas GraphQL completas (primeiros 5)
    const graphqlResponses = []
    const pageIdMap = {}

    page.on('response', async (response) => {
      if (!response.url().includes('/api/graphql')) return
      try {
        const text = await response.text()
        const json = JSON.parse(text.startsWith('for (;;);') ? text.slice(9) : text)

        // Guarda resposta bruta (primeiras 5 apenas, limitado a 50kb cada)
        if (graphqlResponses.length < 5) {
          const raw = JSON.stringify(json)
          graphqlResponses.push({
            url: response.url().slice(0, 120),
            size_bytes: raw.length,
            // Mostra as top-level keys do data
            data_keys: json?.data ? Object.keys(json.data) : [],
            // Mostra estrutura do ad_library_main se existir
            ad_library_main_keys: json?.data?.ad_library_main ? Object.keys(json.data.ad_library_main) : [],
            // Amostra das edges (primeiros 2 anúncios completos)
            edges_sample: (() => {
              const edges = json?.data?.ad_library_main?.search_results_connection?.edges
              if (!edges) return null
              return edges.slice(0, 2).map(e => {
                const n = e?.node || {}
                return {
                  // Todos os campos de primeiro nível do node
                  node_keys: Object.keys(n),
                  page_id: n.page_id,
                  page_name: n.page_name,
                  'page.id': n.page?.id,
                  'page.name': n.page?.name,
                  collated_results_count: (n.collated_results || []).length,
                  // Amostra do primeiro collated_result
                  collated_sample: (n.collated_results || []).slice(0, 1).map(r => ({
                    keys: Object.keys(r),
                    page_id: r.page_id,
                    page_name: r.page_name,
                    'page.id': r.page?.id,
                    'page.name': r.page?.name,
                  })),
                }
              })
            })(),
            // Fonte 1: filtros laterais
            filter_pages: (() => {
              const pages = json?.data?.ad_library_main?.dynamic_filter_options?.pages
              if (!pages) return null
              return pages.slice(0, 5).map(p => ({ key: p.key, display_name: p.display_name, count: p.count }))
            })(),
            // Busca recursiva: todos os pares page_id+page_name encontrados
            found_page_ids: (() => {
              const found = []
              const scan = (obj, path = '', depth = 0) => {
                if (!obj || typeof obj !== 'object' || depth > 8) return
                if (obj.page_id !== undefined && obj.page_name !== undefined) {
                  found.push({ path, page_id: obj.page_id, page_id_type: typeof obj.page_id, page_name: obj.page_name })
                }
                for (const [k, v] of Object.entries(obj)) {
                  if (Array.isArray(v)) v.slice(0, 3).forEach((i, idx) => scan(i, `${path}.${k}[${idx}]`, depth + 1))
                  else if (typeof v === 'object') scan(v, `${path}.${k}`, depth + 1)
                }
              }
              if (json?.data) scan(json.data, 'data')
              return found.slice(0, 20)
            })(),
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

    // Análise DOM: mostra estrutura dos primeiros 3 cards
    const domAnalysis = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'))
      const sponsoredEls = spans.filter(s => s.textContent.trim() === 'Patrocinado' || s.textContent.trim() === 'Sponsored')

      return sponsoredEls.slice(0, 3).map((sponsoredEl, idx) => {
        // Sobe para achar o card
        let card = sponsoredEl
        for (let i = 0; i < 15; i++) {
          card = card.parentElement
          if (!card) break
          const rect = card.getBoundingClientRect()
          if (rect.height > 150 && rect.width > 250) break
        }
        if (!card) return { idx, error: 'card nao encontrado' }

        // Nome da página
        let pageName = '', pageNamePath = ''
        let el = sponsoredEl
        for (let i = 0; i < 6; i++) {
          el = el.parentElement
          if (!el) break
          const prev = el.previousElementSibling
          if (prev) {
            const t = prev.textContent.trim()
            if (t.length > 1 && t.length < 100 && t !== 'Patrocinado' && t !== 'Sponsored') {
              pageName = t; pageNamePath = `sponsoredEl.parent[${i}].previousSibling`; break
            }
          }
        }

        // Links dentro do card
        const links = Array.from(card.querySelectorAll('a[href]')).slice(0, 8).map(a => ({
          text: a.textContent.trim().slice(0, 80),
          href: a.href.slice(0, 150),
          isFacebook: a.href.includes('facebook.com'),
        }))

        // Imagens
        const images = Array.from(card.querySelectorAll('img')).slice(0, 4).map(img => ({
          src: (img.src || '').slice(0, 100),
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        }))

        // Textos maiores (candidatos a adText)
        const texts = []
        card.querySelectorAll('div, span, p').forEach(el => {
          if (el.children.length > 3) return
          const t = el.textContent.trim()
          if (t.length > 60 && t.length < 800) texts.push(t.slice(0, 200))
        })

        // IDs e atributos do card
        const cardAttrs = {}
        Array.from(card.attributes || []).forEach(a => { cardAttrs[a.name] = a.value.slice(0, 100) })

        // HTML snapshot pequeno
        const htmlSnippet = card.innerHTML.slice(0, 1500)

        return {
          idx,
          pageName,
          pageNamePath,
          links,
          images,
          texts: texts.slice(0, 5),
          cardTag: card.tagName,
          cardAttrs,
          htmlSnippet,
        }
      })
    })

    res.json({
      keyword: q,
      graphql_responses_captured: graphqlResponses.length,
      page_id_map_final: pageIdMap,
      page_id_map_count: Object.keys(pageIdMap).length,
      graphql_responses: graphqlResponses,
      dom_cards: domAnalysis,
    })
  } catch (err) {
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
