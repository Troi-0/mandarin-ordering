import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { menuSchema } from '../../src/lib/menu-schema.ts'
import {
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

  it('rejects name, portion, and price disagreements', async () => {
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
      'name',
      'name',
      'price',
      'name',
      'portion',
    ])
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
})
