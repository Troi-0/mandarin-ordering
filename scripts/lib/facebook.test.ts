import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { PAGE_ID } from '../../src/lib/menu-schema.ts'
import {
  extractLargerViewerImage,
  extractTargetedPermalinkImage,
  inspectFacebookFeed,
  selectFacebookCandidate,
  targetedPermalinkCandidate,
} from './facebook.ts'

function candidatesFromScripts(jsonScripts: readonly string[]) {
  return inspectFacebookFeed(jsonScripts).candidates
}

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
    const result = candidatesFromScripts([
      feed(story('111', 100), story('222', 200)),
    ])

    expect(result.map((candidate) => candidate.postId)).toEqual(['222', '111'])
  })

  it('never borrows an older image for a newer image-less post', () => {
    const newerWithoutImage = story('222', 200, { images: [] })
    const olderWithImage = story('111', 100)
    const result = candidatesFromScripts([
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
    const result = candidatesFromScripts([
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
    const result = candidatesFromScripts([
      feed(
        story('111', 100, { pageId: '999999999999999' }),
        story('222', 200, { images: [] }),
      ),
    ])

    expect(result).toEqual([])
  })

  it('deduplicates identical embedded records across scripts', () => {
    const duplicate = story('333', 300)
    expect(candidatesFromScripts([feed(duplicate), feed(duplicate)])).toHaveLength(1)
  })

  it('rejects conflicting records with the same post ID', () => {
    const first = story('333', 300)
    const conflicting = story('333', 300, {
      images: ['https://scontent.example.fbcdn.net/different.jpg'],
    })
    expect(candidatesFromScripts([feed(first), feed(conflicting)])).toEqual([])
  })

  it('constructs the canonical Page permalink from the structured record', () => {
    const [candidate] = candidatesFromScripts([feed(story('444', 400))])
    expect(candidate).toEqual({
      postId: '444',
      creationTime: 400,
      imageUrl: 'https://scontent.example.fbcdn.net/444.jpg',
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=444&id=${PAGE_ID}`,
    })
  })

  it('retains the attached photo identity and feed dimensions for the viewer lookup', () => {
    const imageUrl = 'https://scontent.example.fbcdn.net/feed.jpg'
    const record = {
      ...story('444', 400),
      attachments: [{
        styles: {
          attachment: {
            media: {
              id: '777',
              __typename: 'Photo',
              photo_image: { uri: imageUrl, width: 1080, height: 1532 },
            },
          },
        },
      }],
    }

    expect(candidatesFromScripts([feed(record)])[0]).toMatchObject({
      postId: '444',
      photoId: '777',
      imageUrl,
      imageWidth: 1080,
      imageHeight: 1532,
    })
  })

  it('selects a larger viewer image only from the exact attached photo', () => {
    const candidate = {
      postId: '444',
      creationTime: 400,
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=444&id=${PAGE_ID}`,
      imageUrl: 'https://scontent.example.fbcdn.net/feed.jpg',
      photoId: '777',
      imageWidth: 1080,
      imageHeight: 1532,
    }
    const viewer = (id: string, uri: string, width: number, height: number) => ({
      __bbox: { result: { data: { currMedia: { id, image: { uri, width, height } } } } },
    })
    const full = 'https://scontent.example.fbcdn.net/full.jpg'

    expect(extractLargerViewerImage([
      JSON.stringify(viewer('999', 'https://scontent.example.fbcdn.net/wrong.jpg', 4000, 5000)),
      JSON.stringify(viewer('777', full, 1444, 2048)),
    ], candidate)).toEqual({ imageUrl: full, width: 1444, height: 2048 })
    expect(extractLargerViewerImage([
      JSON.stringify(viewer('777', full, 1080, 1532)),
    ], candidate)).toBeUndefined()
    expect(extractLargerViewerImage([
      JSON.stringify(viewer('777', full, 800, 2048)),
    ], candidate)).toBeUndefined()
    expect(extractLargerViewerImage([
      JSON.stringify(viewer('777', 'https://example.com/full.jpg', 1444, 2048)),
    ], candidate)).toBeUndefined()
    expect(extractLargerViewerImage([
      JSON.stringify(viewer('777', full, 1444, 2048)),
      JSON.stringify(viewer('777', 'https://scontent.example.fbcdn.net/other.jpg', 1444, 2048)),
    ], candidate)).toBeUndefined()
  })

  it('supports direct legacy Page author fields', () => {
    expect(candidatesFromScripts([
      feed(story('555', 500, { legacyAuthor: true })),
    ])[0]?.postId).toBe('555')
  })

  it('ignores malformed scripts when another script contains a valid record', () => {
    const result = candidatesFromScripts([
      '{malformed',
      feed(story('555', 500)),
    ])
    expect(result.map((candidate) => candidate.postId)).toEqual(['555'])
  })

  it('rejects non-Facebook CDN images, non-HTTPS images, unsafe timestamps, and multiple photos', () => {
    const unsafeTime = story('777', Number.MAX_SAFE_INTEGER + 1)
    expect(candidatesFromScripts([
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

  it('separates a Page that posted no image from a feed this parser cannot read', () => {
    const textOnly = { ...story('111', 100), attachments: [] }

    expect(inspectFacebookFeed([feed(textOnly)])).toEqual({
      candidates: [],
      pageStories: 1,
      unusableMediaStories: 0,
    })
    expect(inspectFacebookFeed(['{malformed'])).toEqual({
      candidates: [],
      pageStories: 0,
      unusableMediaStories: 0,
    })
  })

  it('flags a Page post whose attachment media holds an image it could not resolve', () => {
    const renamedMediaField = {
      ...story('111', 100),
      attachments: [{
        styles: {
          attachment: {
            media: { id: 'photo-1', full_image: { uri: 'https://scontent.example.fbcdn.net/111.jpg' } },
          },
        },
      }],
    }

    expect(inspectFacebookFeed([feed(renamedMediaField)])).toMatchObject({
      candidates: [],
      pageStories: 1,
      unusableMediaStories: 1,
    })
  })

  it('flags a multi-photo post as unusable media rather than a Page that posted nothing', () => {
    const twoPhotos = story('111', 100, {
      images: [
        'https://scontent.example.fbcdn.net/one.jpg',
        'https://scontent.example.fbcdn.net/two.jpg',
      ],
    })

    expect(inspectFacebookFeed([feed(twoPhotos)])).toMatchObject({
      candidates: [],
      pageStories: 1,
      unusableMediaStories: 1,
    })
  })

  it('counts conflicting duplicate records of one post as unusable media', () => {
    const first = story('333', 300)
    const conflicting = story('333', 300, {
      images: ['https://scontent.example.fbcdn.net/different.jpg'],
    })

    expect(inspectFacebookFeed([feed(first), feed(conflicting)])).toMatchObject({
      candidates: [],
      pageStories: 1,
      unusableMediaStories: 1,
    })
  })

  it('selects an explicitly targeted historical post for a safe benchmark', () => {
    const candidates = candidatesFromScripts([
      feed(story('111', 100), story('222', 200)),
    ])

    expect(selectFacebookCandidate(candidates, { postId: '111' })?.postId).toBe('111')
    expect(selectFacebookCandidate(candidates, { postId: '999' })).toBeUndefined()
  })

  it('accepts one exact-post Facebook CDN image from targeted permalink metadata', () => {
    const html = `
      <meta content="https://www.facebook.com/${PAGE_ID}/posts/menu/1698896525575953/" property="og:url">
      <meta property="og:image" content="https://scontent.fsof9-1.fna.fbcdn.net/menu.jpg?a=1&amp;b=2">
    `

    expect(extractTargetedPermalinkImage(html, { postId: '1698896525575953' }))
      .toBe('https://scontent.fsof9-1.fna.fbcdn.net/menu.jpg?a=1&b=2')
  })

  it('rejects cross-post, cross-page, non-CDN, ambiguous, and malformed permalink metadata', () => {
    const validCanonical = `https://www.facebook.com/${PAGE_ID}/posts/menu/1698896525575953/`
    const html = (canonical: string, images: string[]) => `
      <meta property="og:url" content="${canonical}">
      ${images.map((image) => `<meta property="og:image" content="${image}">`).join('\n')}
    `
    const target = { postId: '1698896525575953' }
    const cdn = 'https://scontent.example.fbcdn.net/menu.jpg'

    expect(extractTargetedPermalinkImage(
      html(`https://www.facebook.com/${PAGE_ID}/posts/menu/111/`, [cdn]),
      target,
    )).toBeUndefined()
    expect(extractTargetedPermalinkImage(
      html('https://www.facebook.com/999999999/posts/menu/1698896525575953/', [cdn]),
      target,
    )).toBeUndefined()
    expect(extractTargetedPermalinkImage(
      html(validCanonical, ['https://example.com/menu.jpg']),
      target,
    )).toBeUndefined()
    expect(extractTargetedPermalinkImage(
      html(validCanonical, [cdn, 'https://scontent.example.fbcdn.net/other.jpg']),
      target,
    )).toBeUndefined()
    expect(extractTargetedPermalinkImage('<meta property="og:url" content=broken>', target))
      .toBeUndefined()
  })

  it('builds a targeted historical candidate only from a valid permalink response and trusted time', async () => {
    const postId = '1698896525575953'
    const imageUrl = 'https://scontent.example.fbcdn.net/menu.jpg?a=1&amp;b=2'
    const html = `
        <meta property="og:url" content="https://www.facebook.com/${PAGE_ID}/posts/menu/${postId}/">
        <meta property="og:image" content="${imageUrl}">
      `
    const goto = vi.fn(async () => ({ ok: () => true }))
    const page = { goto, content: vi.fn(async () => html) } as unknown as Page

    await expect(targetedPermalinkCandidate(page, {
      postId,
      creationTime: 1_777_000_000,
    })).resolves.toEqual({
      postId,
      creationTime: 1_777_000_000,
      imageUrl: 'https://scontent.example.fbcdn.net/menu.jpg?a=1&b=2',
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${PAGE_ID}`,
    })
    expect(goto).toHaveBeenCalledWith(
      `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${PAGE_ID}`,
      expect.objectContaining({
        waitUntil: 'domcontentloaded',
      }),
    )
  })

  it('fails targeted permalink lookup closed for untrusted time, HTTP failure, or invalid metadata', async () => {
    const postId = '1698896525575953'
    const page = (ok: boolean, html: string) => ({
      goto: vi.fn(async () => ({ ok: () => ok })),
      content: vi.fn(async () => html),
    }) as unknown as Page

    await expect(targetedPermalinkCandidate(page(true, ''), { postId }))
      .resolves.toBeUndefined()
    await expect(targetedPermalinkCandidate(page(false, ''), {
      postId,
      creationTime: 1_777_000_000,
    })).resolves.toBeUndefined()
    await expect(targetedPermalinkCandidate(page(true, '<html></html>'), {
      postId,
      creationTime: 1_777_000_000,
    })).resolves.toBeUndefined()
  })
})
