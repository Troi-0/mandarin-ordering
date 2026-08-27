import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { menuSchema } from '../../src/lib/menu-schema.ts'
import {
  comparePriceBenchmark,
  compareTranscriptions,
  extractedMenuSchema,
  normalizeTranscription,
  type ExtractedMenu,
} from './gemini.ts'

async function humanVerifiedTranscript(): Promise<ExtractedMenu> {
  const menu = menuSchema.parse(
    JSON.parse(await readFile('data/menus/2026-08-24.json', 'utf8')),
  )
  return extractedMenuSchema.parse({
    uncertain: false,
    uncertaintyNotes: [],
    categories: menu.categories.map((category) => ({
      name: category.name,
      items: category.items.map((item) => ({
        name: item.name,
        portion: item.portion ?? null,
        priceCents: item.priceCents,
        uncertain: false,
      })),
    })),
  })
}

describe('blind Gemini transcription comparison', () => {
  it('normalizes printed gram abbreviations before comparison and publication', async () => {
    const transcript = await humanVerifiedTranscript()
    transcript.categories[1].items[0].portion = '350гр.'

    expect(normalizeTranscription(transcript).categories[1].items[0].portion).toBe('350 г')
  })

  it('normalizes millilitres, pieces, whitespace, and decimal gram portions', async () => {
    const transcript = await humanVerifiedTranscript()
    const items = transcript.categories[0].items
    items[0].portion = ' 350   мл. '
    items[1].portion = '2бр'
    items[2].portion = '0,5 гр.'

    const normalized = normalizeTranscription(transcript)
    expect(normalized.categories[0].items.slice(0, 3).map((item) => item.portion)).toEqual([
      '350 мл',
      '2 бр.',
      '0,5 г',
    ])
  })

  it('enforces integer-cent price limits in model output', async () => {
    const transcript = await humanVerifiedTranscript()
    transcript.categories[0].items[0].priceCents = 0
    expect(extractedMenuSchema.safeParse(transcript).success).toBe(false)
    transcript.categories[0].items[0].priceCents = 10_001
    expect(extractedMenuSchema.safeParse(transcript).success).toBe(false)
    transcript.categories[0].items[0].priceCents = 270.5
    expect(extractedMenuSchema.safeParse(transcript).success).toBe(false)
  })

  it('approves exact independent agreement across the human-verified 43-item menu', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)

    expect(extracted.categories.flatMap((category) => category.items)).toHaveLength(43)
    expect(compareTranscriptions(extracted, verificationTranscript)).toEqual({
      approved: true,
      uncertain: false,
      issues: [],
    })
  })

  it('approves identical categories returned in a different order', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories.reverse()
    verificationTranscript.categories[0].name = verificationTranscript.categories[0].name
      .toLocaleUpperCase('bg-BG')

    expect(compareTranscriptions(extracted, verificationTranscript)).toEqual({
      approved: true,
      uncertain: false,
      issues: [],
    })
  })

  it('still rejects item disagreements after categories are reordered', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories.reverse()
    const grill = verificationTranscript.categories.find((category) => category.name === 'Скара')
    if (!grill) throw new Error('Expected the human-verified fixture to contain Скара')
    grill.items[0].priceCents += 1

    expect(compareTranscriptions(extracted, verificationTranscript)).toMatchObject({
      approved: false,
      uncertain: false,
      issues: [{
        category: 'Скара',
        field: 'price',
      }],
    })
  })

  it('checks every price position in the 43-item transcript', async () => {
    const extracted = await humanVerifiedTranscript()
    let checkedPrices = 0

    for (let categoryIndex = 0; categoryIndex < extracted.categories.length; categoryIndex += 1) {
      for (let itemIndex = 0; itemIndex < extracted.categories[categoryIndex].items.length; itemIndex += 1) {
        const verificationTranscript = structuredClone(extracted)
        verificationTranscript.categories[categoryIndex].items[itemIndex].priceCents += 1
        const result = compareTranscriptions(extracted, verificationTranscript)

        expect(result.approved).toBe(false)
        expect(result.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ field: 'price' }),
        ]))
        checkedPrices += 1
      }
    }

    expect(checkedPrices).toBe(43)
  })

  it('matches category names after Bulgarian casing and whitespace normalization', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[0].name = `  ${verificationTranscript.categories[0].name.toLocaleLowerCase('bg-BG')}  `

    expect(compareTranscriptions(extracted, verificationTranscript)).toMatchObject({
      approved: true,
      issues: [],
    })
  })

  it('rejects missing and duplicate categories without pairing their prices unsafely', async () => {
    const extracted = await humanVerifiedTranscript()
    const missingCategory = structuredClone(extracted)
    missingCategory.categories.pop()
    const missingResult = compareTranscriptions(extracted, missingCategory)
    expect(missingResult.approved).toBe(false)
    expect(missingResult.issues.some((issue) => issue.field === 'category')).toBe(true)

    const duplicateCategory = structuredClone(extracted)
    duplicateCategory.categories.push(structuredClone(duplicateCategory.categories[0]))
    const duplicateResult = compareTranscriptions(extracted, duplicateCategory)
    expect(duplicateResult.approved).toBe(false)
    expect(duplicateResult.issues.some((issue) => issue.explanation.includes('appears 2 times'))).toBe(true)
  })

  it('rejects a missing item instead of comparing the following price against it', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[0].items.splice(1, 1)

    const result = compareTranscriptions(extracted, verificationTranscript)
    expect(result.approved).toBe(false)
    expect(result.issues.some((issue) => ['missing-item', 'extra-item'].includes(issue.field))).toBe(true)
  })

  it('ignores item-name differences but rejects portion and price disagreements', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[1].items[1].name =
      'Късчета от пилешко филе с териаки сос, с гарнитура ориз'
    verificationTranscript.categories[1].items[4].name =
      'Телешки кюфтета на скара /2 бр./, с ½ пърленка, тирокафтери и гарнитура'
    verificationTranscript.categories[4].items[0].priceCents = 130
    verificationTranscript.categories[5].items[1].name =
      'Сала Капрезе с моцарела и песто 300гр/единично опакована/'
    verificationTranscript.categories[5].items[1].portion = null

    const result = compareTranscriptions(extracted, verificationTranscript)

    expect(result.approved).toBe(false)
    expect(result.uncertain).toBe(false)
    expect(result.issues.map((issue) => issue.field)).toEqual([
      'price',
      'portion',
    ])
  })

  it('approves name-only spelling and whitespace disagreements when numeric structure agrees', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[1].items[4].name =
      'Телешки кюфтета не скара /2бр/, с ½ пърленка, тирокафтери и гарнитура'
    verificationTranscript.categories[5].items[1].name =
      'Сала Капрезе с моцарела и песто/единично опакована/'

    expect(compareTranscriptions(extracted, verificationTranscript)).toEqual({
      approved: true,
      uncertain: false,
      issues: [],
    })
  })

  it('rejects uncertainty even when both transcripts otherwise agree', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.uncertain = true
    verificationTranscript.uncertaintyNotes = ['Последната цена не се чете ясно.']

    expect(compareTranscriptions(extracted, verificationTranscript)).toMatchObject({
      approved: false,
      uncertain: true,
      issues: [],
    })
  })

  it('rejects uncertainty attached to a single item even without a global note', async () => {
    const extracted = await humanVerifiedTranscript()
    const verificationTranscript = structuredClone(extracted)
    verificationTranscript.categories[2].items[0].uncertain = true

    expect(compareTranscriptions(extracted, verificationTranscript)).toMatchObject({
      approved: false,
      uncertain: true,
      issues: [],
    })
  })

  it('keeps the human benchmark price-focused across reordered and display-normalized names', async () => {
    const humanReference = await humanVerifiedTranscript()
    const extracted = structuredClone(humanReference)
    extracted.categories.reverse()
    const desserts = extracted.categories.find((category) => category.name === 'Десерти')
    const salads = extracted.categories.find((category) => category.name === 'Салати')
    if (!desserts || !salads) throw new Error('Expected dessert and salad categories')
    desserts.name = 'ДЕСЕРТ'
    salads.items[1].name = salads.items[1].name.replace(' /', '/')

    expect(comparePriceBenchmark(extracted, humanReference)).toEqual({
      approved: true,
      uncertain: false,
      issues: [],
    })
  })

  it('rejects any human-benchmark price, portion, structure, or uncertainty change', async () => {
    const humanReference = await humanVerifiedTranscript()
    const wrongPrice = structuredClone(humanReference)
    wrongPrice.categories[0].items[0].priceCents += 1
    expect(comparePriceBenchmark(wrongPrice, humanReference)).toMatchObject({
      approved: false,
      issues: [expect.objectContaining({ field: 'price' })],
    })

    const wrongPortion = structuredClone(humanReference)
    wrongPortion.categories[0].items[0].portion = '300 мл'
    expect(comparePriceBenchmark(wrongPortion, humanReference)).toMatchObject({
      approved: false,
      issues: [expect.objectContaining({ field: 'portion' })],
    })

    const missingItem = structuredClone(humanReference)
    missingItem.categories[0].items.pop()
    expect(comparePriceBenchmark(missingItem, humanReference)).toMatchObject({
      approved: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ field: expect.stringMatching(/^(missing|extra)-item$/) }),
      ]),
    })

    const uncertain = structuredClone(humanReference)
    uncertain.categories[0].items[0].uncertain = true
    expect(comparePriceBenchmark(uncertain, humanReference)).toMatchObject({
      approved: false,
      uncertain: true,
    })
  })
})
