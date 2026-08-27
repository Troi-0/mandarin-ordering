import { describe, expect, it } from 'vitest'
import { PAGE_ID } from '../../src/lib/menu-schema.ts'
import { extractFacebookCandidatesFromJsonScripts, selectFacebookCandidate } from './facebook.ts'

function photo(uri: string, id = 'photo-1') {
  return {
    styles: {
      attachment: {
        media: { id, __typename: 'Photo', photo_image: { uri } },
      },
    },
  }
}

function story(
  postId: string,
  creationTime: number,
  options?: { pageId?: string; images?: string[]; legacyAuthor?: boolean },
) {
  const pageId = options?.pageId ?? PAGE_ID
  return {
    post_id: postId,
    creation_time: creationTime,
    ...(options?.legacyAuthor ? { actor_id: pageId } : { actors: [{ id: pageId }] }),
    attachments: (options?.images ?? [`https://scontent.example.fbcdn.net/${postId}.jpg`])
      .map((uri, index) => photo(uri, `photo-${index}`)),
  }
}

function feed(...nodes: unknown[]): string {
  return JSON.stringify({
    require: [[null, null, null, {
      __bbox: {
        result: {
          data: { user: { timeline_list_feed_units: { edges: nodes.map((node) => ({ node })) } } },
        },
      },
    }]],
  })
}

describe('Facebook embedded post parsing', () => {
  it('sorts same-record candidates by creation timestamp, so an older pinned post cannot win', () => {
    const result = extractFacebookCandidatesFromJsonScripts([
      feed(story('111', 100), story('222', 200)),
    ])

    expect(result.map((candidate) => candidate.postId)).toEqual(['222', '111'])
  })

  it('never borrows an older image for a newer image-less post', () => {
    const newerWithoutImage = story('222', 200, { images: [] })
    const olderWithImage = story('111', 100)
    const result = extractFacebookCandidatesFromJsonScripts([
      feed(newerWithoutImage, olderWithImage),
    ])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      postId: '111',
      creationTime: 100,
      imageUrl: 'https://scontent.example.fbcdn.net/111.jpg',
    })
  })

  it('does not accept an author or image found only in a sibling or nested record', () => {
    const result = extractFacebookCandidatesFromJsonScripts([
      JSON.stringify({
        post_id: '222',
        creation_time: 200,
        actors: [{ id: PAGE_ID }],
        unrelated: { attachments: [photo('https://scontent.example.fbcdn.net/older.jpg')] },
      }),
      JSON.stringify({
        post_id: '333',
        creation_time: 300,
        attachments: [photo('https://scontent.example.fbcdn.net/333.jpg')],
        unrelated: { actors: [{ id: PAGE_ID }] },
      }),
    ])

    expect(result).toEqual([])
  })

  it('rejects visitor/foreign authors and posts without images', () => {
    const result = extractFacebookCandidatesFromJsonScripts([
      feed(
        story('111', 100, { pageId: '999999999999999' }),
        story('222', 200, { images: [] }),
      ),
    ])

    expect(result).toEqual([])
  })

  it('deduplicates identical embedded records across scripts', () => {
    const duplicate = story('333', 300)
    expect(extractFacebookCandidatesFromJsonScripts([feed(duplicate), feed(duplicate)])).toHaveLength(1)
  })

  it('rejects conflicting records with the same post ID', () => {
    const first = story('333', 300)
    const conflicting = story('333', 300, {
      images: ['https://scontent.example.fbcdn.net/different.jpg'],
    })
    expect(extractFacebookCandidatesFromJsonScripts([feed(first), feed(conflicting)])).toEqual([])
  })

  it('constructs the canonical Page permalink from the structured record', () => {
    const [candidate] = extractFacebookCandidatesFromJsonScripts([feed(story('444', 400))])
    expect(candidate).toEqual({
      postId: '444',
      creationTime: 400,
      imageUrl: 'https://scontent.example.fbcdn.net/444.jpg',
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=444&id=${PAGE_ID}`,
    })
  })

  it('supports direct legacy Page author fields', () => {
    expect(extractFacebookCandidatesFromJsonScripts([
      feed(story('555', 500, { legacyAuthor: true })),
    ])[0]?.postId).toBe('555')
  })

  it('ignores malformed scripts when another script contains a valid record', () => {
    const result = extractFacebookCandidatesFromJsonScripts([
      '{malformed',
      feed(story('555', 500)),
    ])
    expect(result.map((candidate) => candidate.postId)).toEqual(['555'])
  })

  it('rejects non-Facebook CDN images, non-HTTPS images, unsafe timestamps, and multiple photos', () => {
    const unsafeTime = story('777', Number.MAX_SAFE_INTEGER + 1)
    expect(extractFacebookCandidatesFromJsonScripts([
      feed(
        story('666', 600, { images: ['http://scontent.example.fbcdn.net/menu.jpg'] }),
        story('667', 601, { images: ['https://example.com/menu.jpg'] }),
        unsafeTime,
        story('888', 800, {
          images: [
            'https://scontent.example.fbcdn.net/one.jpg',
            'https://scontent.example.fbcdn.net/two.jpg',
          ],
        }),
      ),
    ])).toEqual([])
  })

  it('selects an explicitly targeted historical post for a safe benchmark', () => {
    const candidates = extractFacebookCandidatesFromJsonScripts([
      feed(story('111', 100), story('222', 200)),
    ])

    expect(selectFacebookCandidate(candidates, { postId: '111' })?.postId).toBe('111')
    expect(selectFacebookCandidate(candidates, { postId: '999' })).toBeUndefined()
  })
})
