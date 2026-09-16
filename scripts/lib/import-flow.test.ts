import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertMenuInvariants,
  menuPublicationSchema,
  menuSchema,
  type Menu,
} from '../../src/lib/menu-schema.ts'
import { compareTranscriptions, extractedMenuSchema, type ExtractedMenu } from './gemini.ts'
import { createMenuImporter, referenceTranscript } from './import-flow.ts'
import { imageSha256 } from './menu-build.ts'

const NOW = new Date('2026-08-27T09:00:00Z')
const TODAY = '2026-08-27'
const TODAY_TIMESTAMP = Math.floor(new Date('2026-08-27T05:30:03Z').getTime() / 1_000)
const IMAGE = new TextEncoder().encode('public-menu-image')

let testRoot: string

async function humanMenu(): Promise<Menu> {
  return menuSchema.parse(
    JSON.parse(await readFile('data/menus/2026-08-24.json', 'utf8')),
  )
}

async function approvedTranscript(): Promise<ExtractedMenu> {
  return extractedMenuSchema.parse(referenceTranscript(await humanMenu()))
}

function facebookResult(timestamp = TODAY_TIMESTAMP, postId = '1700919125373693') {
  return {
    status: 'ready' as const,
    candidate: {
      postId,
      creationTime: timestamp,
      imageUrl: 'https://scontent.example.fbcdn.net/menu.jpg',
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=100063668642218`,
    },
    image: IMAGE,
    mimeType: 'image/jpeg',
  }
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await readFile(filename)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), 'mandarin-import-test-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(testRoot, { recursive: true, force: true })
})

describe('menu import orchestration', () => {
  it.each([
    {
      date: '2026-08-24',
      postId: '1697831445682461',
      sha256: '2bfc03e5b38d9635e78e6be79da5ef879e48fff894a3ea508017b7e7da007867',
    },
    {
      date: '2026-08-25',
      postId: '1698896525575953',
      sha256: '890ec67f6690203b6cc02de2cba695d062887f7f2c76f37d3526fffef511b532',
    },
  ])('pins the public $date benchmark image to its historical post', async ({
    date,
    postId,
    sha256,
  }) => {
    const reference = menuSchema.parse(
      JSON.parse(await readFile(`data/menus/${date}.json`, 'utf8')),
    )
    const image = await readFile(`test-fixtures/facebook/${date}.jpg`)

    expect(reference.source.postId).toBe(postId)
    expect(reference.validation.extractedBy).toMatch(/^human-verified/)
    expect(imageSha256(image)).toBe(sha256)
  })

  it('publishes approved Facebook data to identical current and archive menus', async () => {
    const transcript = await approvedTranscript()
    const fetchFacebook = vi.fn(async () => facebookResult())
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook,
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })

    await expect(importer.runFacebook()).resolves.toBe('published')

    const publication = menuPublicationSchema.parse(
      JSON.parse(await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8')),
    )
    if (publication.status !== 'ready') throw new Error('Expected a ready publication')
    const archive = menuSchema.parse(
      JSON.parse(await readFile(path.join(testRoot, `data/menus/${TODAY}.json`), 'utf8')),
    )
    expect(publication.menu).toEqual(archive)
    expect(publication.menu.source).toMatchObject({
      postId: '1700919125373693',
      imageSha256: imageSha256(IMAGE),
    })
    expect(publication.menu.categories.flatMap((category) => category.items).map((item) => item.priceCents))
      .toEqual(transcript.categories.flatMap((category) => category.items).map((item) => item.priceCents))
    expect(() => assertMenuInvariants(publication.menu)).not.toThrow()
  })

  it('treats a repeated approved import as unchanged without replacing menu data', async () => {
    const transcript = await approvedTranscript()
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })
    const source = {
      ...facebookResult(),
      date: TODAY,
      sourcePostId: '1700919125373693',
      sourcePostUrl: facebookResult().candidate.postUrl,
      publishedAt: new Date(TODAY_TIMESTAMP * 1_000).toISOString(),
      method: 'facebook' as const,
    }

    await expect(importer.processImage({
      image: source.image,
      mimeType: source.mimeType,
      date: source.date,
      sourcePostId: source.sourcePostId,
      sourcePostUrl: source.sourcePostUrl,
      publishedAt: source.publishedAt,
      method: source.method,
    })).resolves.toBe('published')
    const firstPublication = await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8')

    await expect(importer.processImage({
      image: source.image,
      mimeType: source.mimeType,
      date: source.date,
      sourcePostId: source.sourcePostId,
      sourcePostUrl: source.sourcePostUrl,
      publishedAt: source.publishedAt,
      method: source.method,
    })).resolves.toBe('unchanged')
    expect(await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8'))
      .toBe(firstPublication)
  })

  it('skips Facebook only when the complete current publication is valid and for today', async () => {
    const existing = {
      status: 'ready',
      menu: menuSchema.parse(
        JSON.parse(await readFile(`data/menus/${TODAY}.json`, 'utf8')),
      ),
    }
    await mkdir(path.join(testRoot, 'data'), { recursive: true })
    await writeFile(path.join(testRoot, 'data/current-menu.json'), JSON.stringify(existing))
    const fetchFacebook = vi.fn(async () => facebookResult())
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook,
    })

    await expect(importer.runFacebook()).resolves.toBe('skipped')
    expect(fetchFacebook).not.toHaveBeenCalled()
  })

  it('repairs a malformed same-day pointer instead of trusting its status and date', async () => {
    await mkdir(path.join(testRoot, 'data'), { recursive: true })
    await writeFile(
      path.join(testRoot, 'data/current-menu.json'),
      JSON.stringify({ status: 'ready', menu: { date: TODAY } }),
    )
    const transcript = await approvedTranscript()
    const fetchFacebook = vi.fn(async () => facebookResult())
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook,
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })

    await expect(importer.runFacebook()).resolves.toBe('published')
    expect(fetchFacebook).toHaveBeenCalledOnce()
    expect(menuPublicationSchema.safeParse(
      JSON.parse(await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8')),
    ).success).toBe(true)
  })

  it('treats a stale newest post as no menu today, without reaching Gemini or publishing', async () => {
    const extract = vi.fn(async () => approvedTranscript())
    const verify = vi.fn(async () => approvedTranscript())
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook: async () => facebookResult(
        Math.floor(new Date('2026-08-26T05:30:03Z').getTime() / 1_000),
      ),
      extract,
      verify,
    })

    await expect(importer.runFacebook()).resolves.toBe('no-menu-post')
    expect(extract).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
  })

  it('still fails closed inside processImage when a stale date reaches it directly', async () => {
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      extract: vi.fn(async () => approvedTranscript()),
      verify: vi.fn(async () => approvedTranscript()),
    })

    await expect(importer.processImage({
      image: IMAGE,
      mimeType: 'image/jpeg',
      date: '2026-08-26',
      sourcePostId: '1700919125373693',
      sourcePostUrl: facebookResult().candidate.postUrl,
      publishedAt: '2026-08-26T05:30:03.000Z',
      method: 'facebook',
    })).rejects.toThrow('Fail-closed date check: source is 2026-08-26, expected 2026-08-27')
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
  })

  it('reports an image-less Page feed as no menu today instead of an import failure', async () => {
    const extract = vi.fn(async () => approvedTranscript())
    const verify = vi.fn(async () => approvedTranscript())
    const fetchFacebook = vi.fn(async () => ({
      status: 'no-menu-post' as const,
      detail: 'read 1 Page post(s), none carrying a menu image',
    }))
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook,
      extract,
      verify,
    })

    await expect(importer.runFacebook()).resolves.toBe('no-menu-post')
    expect(fetchFacebook).toHaveBeenCalledOnce()
    expect(extract).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
    expect(await pathExists(path.join(testRoot, 'data/review/2026-08-27.json'))).toBe(false)
  })

  it('writes a complete fail-closed review menu and never publishes a disagreement', async () => {
    const extracted = await approvedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[0].items[0].priceCents += 1
    const resolutionTranscript = structuredClone(extracted)
    resolutionTranscript.categories[0].items[0].priceCents += 2
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook: async () => facebookResult(),
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(verificationTranscript),
      resolve: async () => structuredClone(resolutionTranscript),
    })

    await expect(importer.runFacebook()).rejects.toThrow('draft saved')
    const draft = JSON.parse(
      await readFile(path.join(testRoot, `data/review/${TODAY}.json`), 'utf8'),
    ) as {
      status: string
      editableMenu: Menu & { validation: { uncertain: boolean; verifiedBy: string } }
      verification: { approved: boolean; issues: Array<{ field: string }> }
    }
    expect(draft.status).toBe('rejected')
    expect(draft.editableMenu).toMatchObject({
      date: TODAY,
      currency: 'EUR',
      importMethod: 'facebook',
      source: { postId: '1700919125373693', imageSha256: imageSha256(IMAGE) },
      validation: { verifiedBy: 'human-review-required', uncertain: true },
    })
    expect(draft.verification).toMatchObject({
      approved: false,
      issues: [expect.objectContaining({ field: 'price' })],
    })
    expect(draft).toMatchObject({
      resolution: {
        certain: true,
        agreesWithExtraction: false,
        agreesWithVerification: false,
      },
    })
    expect(menuSchema.safeParse(draft.editableMenu).success).toBe(false)
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
    expect(await pathExists(path.join(testRoot, `data/menus/${TODAY}.json`))).toBe(false)
  })

  it('publishes only when a certain focused re-inspection matches one full transcription', async () => {
    const extracted = await approvedTranscript()
    extracted.categories[4].items[1].priceCents = 79
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[4].items[1].priceCents = 179
    verificationTranscript.categories[4].items[1].uncertain = true
    verificationTranscript.uncertain = true
    verificationTranscript.uncertaintyNotes = ['Leading price digit crosses artwork.']
    const resolutionTranscript = structuredClone(verificationTranscript)
    resolutionTranscript.categories[4].items[1].uncertain = false
    resolutionTranscript.uncertain = false
    resolutionTranscript.uncertaintyNotes = []
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook: async () => facebookResult(),
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(verificationTranscript),
      resolve: async () => structuredClone(resolutionTranscript),
    })

    await expect(importer.runFacebook()).resolves.toBe('published')
    const publication = menuPublicationSchema.parse(
      JSON.parse(await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8')),
    )
    if (publication.status !== 'ready') throw new Error('Expected a ready publication')
    expect(publication.menu.categories[4].items[1].priceCents).toBe(179)
    expect(publication.menu.validation).toEqual({
      extractedBy: 'gemini-3.6-flash',
      verifiedBy: 'gemini-3.6-flash:focused-consensus',
      uncertain: false,
    })
  })

  it('keeps a matching focused re-inspection unpublished when it remains uncertain', async () => {
    const extracted = await approvedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[0].items[0].priceCents += 1
    const resolutionTranscript = structuredClone(verificationTranscript)
    resolutionTranscript.categories[0].items[0].uncertain = true
    resolutionTranscript.uncertain = true
    resolutionTranscript.uncertaintyNotes = ['The leading digit is still unreadable.']
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      fetchFacebook: async () => facebookResult(),
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(verificationTranscript),
      resolve: async () => structuredClone(resolutionTranscript),
    })

    await expect(importer.runFacebook()).rejects.toThrow('draft saved')
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
  })

  it('writes an approved dry-run report without changing publication data', async () => {
    const transcript = await approvedTranscript()
    const reportPath = path.join(testRoot, 'reports', 'dry-run.json')
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: true,
      reportPath,
      now: () => NOW,
      fetchFacebook: async () => facebookResult(),
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })

    await expect(importer.runFacebook()).resolves.toBe('dry-run')
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      status: string
      menu: Menu
      verification: { approved: boolean }
    }
    expect(report).toMatchObject({
      status: 'approved',
      menu: { date: TODAY },
      verification: { approved: true },
    })
    expect(await pathExists(path.join(testRoot, 'data/current-menu.json'))).toBe(false)
  })

  it('writes rejected dry-run evidence and requires an explicit report path', async () => {
    const extracted = await approvedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[0].items[0].priceCents += 1
    const resolutionTranscript = structuredClone(extracted)
    resolutionTranscript.categories[0].items[0].priceCents += 2
    const reportPath = path.join(testRoot, 'reports', 'rejected.json')
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: true,
      reportPath,
      now: () => NOW,
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(verificationTranscript),
      resolve: async () => structuredClone(resolutionTranscript),
    })

    await expect(importer.processImage({
      image: IMAGE,
      mimeType: 'image/jpeg',
      date: TODAY,
      sourcePostId: '1700919125373693',
      sourcePostUrl: facebookResult().candidate.postUrl,
      publishedAt: new Date(TODAY_TIMESTAMP * 1_000).toISOString(),
      method: 'facebook',
    })).rejects.toThrow('Dry run requires manual review')
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
      status: 'rejected',
      editableMenu: { validation: { uncertain: true } },
      verification: { approved: false },
    })

    const missingPathImporter = createMenuImporter({
      root: testRoot,
      dryRun: true,
      now: () => NOW,
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(extracted),
    })
    await expect(missingPathImporter.processImage({
      image: IMAGE,
      mimeType: 'image/jpeg',
      date: TODAY,
      sourcePostId: '1700919125373693',
      sourcePostUrl: facebookResult().candidate.postUrl,
      publishedAt: new Date(TODAY_TIMESTAMP * 1_000).toISOString(),
      method: 'facebook',
    })).rejects.toThrow('IMPORT_REPORT_PATH is required')
  })

  it('runs a reordered historical benchmark by category name instead of array position', async () => {
    const reference = await humanMenu()
    const extracted = referenceTranscript(reference)
    extracted.categories.reverse()
    await mkdir(path.join(testRoot, 'data/menus'), { recursive: true })
    await writeFile(
      path.join(testRoot, 'data/menus/2026-08-24.json'),
      JSON.stringify(reference),
    )
    const reportPath = path.join(testRoot, 'benchmark.json')
    const fetchFacebook = vi.fn(async () => facebookResult(
      Math.floor(new Date('2026-08-24T05:30:03Z').getTime() / 1_000),
      reference.source.postId,
    ))
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: true,
      reportPath,
      now: () => NOW,
      fetchFacebook,
      extract: async () => structuredClone(extracted),
      verify: async () => structuredClone(extracted),
    })

    await expect(importer.runFacebook('data/menus/2026-08-24.json')).resolves.toBe('dry-run')
    expect(fetchFacebook).toHaveBeenCalledWith({
      postId: reference.source.postId,
      creationTime: Math.floor(new Date(reference.source.publishedAt).getTime() / 1_000),
    })
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      benchmark: { approved: boolean; issues: unknown[] }
    }
    expect(report.benchmark).toEqual({ approved: true, uncertain: false, issues: [] })
    expect(compareTranscriptions(extracted, referenceTranscript(reference)).approved).toBe(true)
  })

  it('replays a repository Facebook fixture without contacting the live Page', async () => {
    const reference = await humanMenu()
    const transcript = referenceTranscript(reference)
    await mkdir(path.join(testRoot, 'data/menus'), { recursive: true })
    await mkdir(path.join(testRoot, 'test-fixtures/facebook'), { recursive: true })
    await writeFile(
      path.join(testRoot, 'data/menus/2026-08-24.json'),
      JSON.stringify(reference),
    )
    await writeFile(path.join(testRoot, 'test-fixtures/facebook/2026-08-24.jpg'), IMAGE)
    const reportPath = path.join(testRoot, 'fixture-report.json')
    const fetchFacebook = vi.fn(async () => facebookResult())
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: true,
      reportPath,
      now: () => NOW,
      fetchFacebook,
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })

    await expect(importer.runFacebook(
      'data/menus/2026-08-24.json',
      'test-fixtures/facebook/2026-08-24.jpg',
    )).resolves.toBe('dry-run')
    expect(fetchFacebook).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
      status: 'approved',
      menu: {
        date: '2026-08-24',
        source: { postId: reference.source.postId },
      },
      benchmark: { approved: true },
    })
  })

  it('rejects unpaired or mismatched repository benchmark images', async () => {
    const importer = createMenuImporter({ root: testRoot, dryRun: true, now: () => NOW })
    await expect(importer.runFacebook(
      undefined,
      'test-fixtures/facebook/2026-08-24.jpg',
    )).rejects.toThrow('requires IMPORT_BENCHMARK_MENU')

    const reference = await humanMenu()
    await mkdir(path.join(testRoot, 'data/menus'), { recursive: true })
    await writeFile(
      path.join(testRoot, 'data/menus/2026-08-24.json'),
      JSON.stringify(reference),
    )
    await expect(importer.runFacebook(
      'data/menus/2026-08-24.json',
      'test-fixtures/facebook/2026-08-25.jpg',
    )).rejects.toThrow('match the reference date')
    await expect(importer.runFacebook(
      'data/menus/2026-08-24.json',
      '../2026-08-24.jpg',
    )).rejects.toThrow('must be test-fixtures/facebook')
  })

  it('publishes a valid manual-inbox image with deterministic source metadata', async () => {
    const transcript = await approvedTranscript()
    await mkdir(path.join(testRoot, 'manual-inbox'), { recursive: true })
    await writeFile(path.join(testRoot, `manual-inbox/${TODAY}.png`), IMAGE)
    const importer = createMenuImporter({
      root: testRoot,
      dryRun: false,
      now: () => NOW,
      extract: async () => structuredClone(transcript),
      verify: async () => structuredClone(transcript),
    })

    await expect(importer.runManual(`manual-inbox/${TODAY}.png`)).resolves.toBe('published')
    const publication = menuPublicationSchema.parse(
      JSON.parse(await readFile(path.join(testRoot, 'data/current-menu.json'), 'utf8')),
    )
    if (publication.status !== 'ready') throw new Error('Expected a ready publication')
    expect(publication.menu).toMatchObject({
      date: TODAY,
      importMethod: 'manual',
      source: {
        postId: `manual-${imageSha256(IMAGE).slice(0, 16)}`,
        imageSha256: imageSha256(IMAGE),
      },
    })
  })

  it('rejects unsafe manual paths, filenames, extensions, and oversized images', async () => {
    const importer = createMenuImporter({ root: testRoot, dryRun: false, now: () => NOW })
    await expect(importer.runManual()).rejects.toThrow('Usage: npm run import:manual')
    await expect(importer.runManual('../outside.png')).rejects.toThrow('inside manual-inbox')

    await mkdir(path.join(testRoot, 'manual-inbox'), { recursive: true })
    await writeFile(path.join(testRoot, 'manual-inbox/menu.txt'), IMAGE)
    await expect(importer.runManual('manual-inbox/menu.txt')).rejects.toThrow('PNG, JPEG, or WebP')
    await writeFile(path.join(testRoot, 'manual-inbox/today.png'), IMAGE)
    await expect(importer.runManual('manual-inbox/today.png')).rejects.toThrow('YYYY-MM-DD')
    await writeFile(path.join(testRoot, `manual-inbox/${TODAY}.png`), new Uint8Array((8 * 1024 * 1024) + 1))
    await expect(importer.runManual(`manual-inbox/${TODAY}.png`)).rejects.toThrow('8 MB limit')
  })

  it('requires dry-run mode, a repository menu path, and a human-verified benchmark', async () => {
    const liveImporter = createMenuImporter({ root: testRoot, dryRun: false, now: () => NOW })
    await expect(liveImporter.loadBenchmarkReference('data/menus/2026-08-24.json'))
      .rejects.toThrow('only when IMPORT_DRY_RUN=true')

    const dryImporter = createMenuImporter({ root: testRoot, dryRun: true, now: () => NOW })
    await expect(dryImporter.loadBenchmarkReference('../menu.json'))
      .rejects.toThrow('must be data/menus/YYYY-MM-DD.json')
    await mkdir(path.join(testRoot, 'data/menus'), { recursive: true })
    const nonHuman = structuredClone(await humanMenu())
    nonHuman.validation.extractedBy = 'gemini-3.6-flash'
    await writeFile(path.join(testRoot, 'data/menus/2026-08-24.json'), JSON.stringify(nonHuman))
    await expect(dryImporter.loadBenchmarkReference('data/menus/2026-08-24.json'))
      .rejects.toThrow('must be marked as human-verified')
  })
})
