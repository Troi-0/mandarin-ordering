import { writeFile } from 'node:fs/promises'
import { fetchFacebookMenu } from './lib/facebook.ts'
import { buildGeminiImagePart } from './lib/gemini.ts'

const outputPath = process.argv[2]
if (!outputPath) throw new Error('Provide a temporary output path for the image check')

const result = await fetchFacebookMenu()
if (result.status !== 'ready') throw new Error(result.detail)

// Use the exact payload builder used by generateJson, without calling Gemini.
const imagePart = buildGeminiImagePart(result.image, result.mimeType)
const payloadImage = Buffer.from(imagePart.inlineData.data, 'base64')
if (!payloadImage.equals(Buffer.from(result.image))) {
  throw new Error('Gemini image payload differs from the downloaded Facebook image')
}

await writeFile(outputPath, payloadImage)
process.stdout.write(
  `Gemini image payload: post ${result.candidate.postId}, ${imagePart.inlineData.mimeType}, ` +
  `${payloadImage.byteLength} bytes, ` +
  `${imagePart.mediaResolution?.level ?? 'default model media resolution'}\n`,
)
