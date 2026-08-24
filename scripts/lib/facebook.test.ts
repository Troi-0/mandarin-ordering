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

  it('selects an explicitly targeted historical post for a safe benchmark', () => {
    const candidates = extractFacebookCandidatesFromHtml([
      story('111', 100),
      story('222', 200),
    ].join(''))

    expect(selectFacebookCandidate(candidates, {
      postId: '111',
      postUrl: 'https://www.facebook.com/permalink.php?story_fbid=111',
    })?.postId).toBe('111')
    expect(selectFacebookCandidate(candidates, {
      postId: '999',
      postUrl: 'https://www.facebook.com/permalink.php?story_fbid=999',
    })).toBeUndefined()
  })
})
