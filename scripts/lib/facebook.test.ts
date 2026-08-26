import { describe, expect, it } from 'vitest'
import { PAGE_ID } from '../../src/lib/menu-schema.ts'
import { extractFacebookCandidatesFromHtml, selectFacebookCandidate } from './facebook.ts'

function story(postId: string, creationTime: number, options?: { pageId?: string; image?: boolean }) {
  const pageId = options?.pageId ?? PAGE_ID
  const image = options?.image === false ? '' : '"photo_image":{"uri":"https:\\/\\/example.com\\/menu.jpg"}'
  return `{"short_name":"Author","id":"${pageId}","post_id":"${postId}","creation_time":${creationTime},${image}}`
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

  it('decodes escaped HTTPS image URLs and constructs the canonical Page permalink', () => {
    const [candidate] = extractFacebookCandidatesFromHtml(story('444', 400))
    expect(candidate).toEqual({
      postId: '444',
      creationTime: 400,
      imageUrl: 'https://example.com/menu.jpg',
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=444&id=${PAGE_ID}`,
    })
  })

  it('supports legacy Page author records', () => {
    const html = `{"actor_id":"${PAGE_ID}","post_id":"555","creation_time":500,"photo_image":{"uri":"https:\\/\\/example.com\\/legacy.jpg"}}`
    expect(extractFacebookCandidatesFromHtml(html)[0]?.postId).toBe('555')
  })

  it('rejects non-HTTPS images and unsafe timestamps', () => {
    const insecure = `{"short_name":"Author","id":"${PAGE_ID}","post_id":"666","creation_time":600,"photo_image":{"uri":"http:\\/\\/example.com\\/menu.jpg"}}`
    const unsafeTime = `{"short_name":"Author","id":"${PAGE_ID}","post_id":"777","creation_time":999999999999999999,"photo_image":{"uri":"https:\\/\\/example.com\\/menu.jpg"}}`
    expect(extractFacebookCandidatesFromHtml(`${insecure}${unsafeTime}`)).toEqual([])
  })

  it('selects an explicitly targeted historical post for a safe benchmark', () => {
    const candidates = extractFacebookCandidatesFromHtml([
      story('111', 100),
      story('222', 200),
    ].join(''))

    expect(selectFacebookCandidate(candidates, {
      postId: '111',
    })?.postId).toBe('111')
    expect(selectFacebookCandidate(candidates, {
      postId: '999',
    })).toBeUndefined()
  })
})
