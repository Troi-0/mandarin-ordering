import { describe, expect, it } from 'vitest'
import { PAGE_ID } from '../../src/lib/menu-schema.ts'
import { extractFacebookCandidatesFromHtml } from './facebook.ts'

function story(postId: string, creationTime: number, options?: { pageId?: string; image?: boolean }) {
  const pageId = options?.pageId ?? PAGE_ID
  const image = options?.image === false ? '' : '"photo_image":{"uri":"https:\\/\\/example.com\\/menu.jpg"}'
  return `{"id":"${pageId}","actor_id":"${pageId}","post_id":"${postId}","creation_time":${creationTime},${image}}`
}

describe('Facebook embedded post parsing', () => {
  it('sorts by embedded creation timestamp, so an older pinned post cannot win', () => {
    const result = extractFacebookCandidatesFromHtml([
      story('111', 100),
      story('222', 200),
    ].join(''))

    expect(result.map((candidate) => candidate.postId)).toEqual(['222', '111'])
  })

  it('rejects visitor/foreign authors and posts without images', () => {
    const result = extractFacebookCandidatesFromHtml([
      story('111', 100, { pageId: '999999999999999' }),
      story('222', 200, { image: false }),
    ].join(''))

    expect(result).toEqual([])
  })

  it('deduplicates repeated embedded records', () => {
    const duplicate = story('333', 300)
    expect(extractFacebookCandidatesFromHtml(`${duplicate}${duplicate}`)).toHaveLength(1)
  })
})
