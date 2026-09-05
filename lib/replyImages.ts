'use client'

// Legacy image attachments for verified_answers replies, from before the
// Replies editor supported inline images (see components/RichTextEditor.tsx
// and lib/richText.ts, which embed a picked/pasted image directly in
// answer_html as a data URI instead). Nothing writes a new row into
// verified_answer_images any more, these helpers only read, sign and
// delete what pre-existing rows already have, so old attachments stay
// visible and removable rather than orphaned.

import { supabaseClient } from './supabase'
import type { VerifiedAnswerImage } from './types'

export const REPLY_IMAGES_BUCKET = 'reply-images'

export async function deleteReplyImage(image: VerifiedAnswerImage): Promise<void> {
  const client = supabaseClient()
  const { error: removeError } = await client.storage
    .from(REPLY_IMAGES_BUCKET)
    .remove([image.storage_path])
  if (removeError) throw new Error(removeError.message || 'Could not delete image.')

  const { error: deleteError } = await client
    .from('verified_answer_images')
    .delete()
    .eq('id', image.id)
  if (deleteError) throw new Error(deleteError.message || 'Could not delete image record.')
}

// Signed URLs are generated on demand and never persisted, the bucket is
// private, and a stored signed URL would just go stale.
export async function signImagePaths(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!paths.length) return out
  const client = supabaseClient()
  const { data, error } = await client.storage
    .from(REPLY_IMAGES_BUCKET)
    .createSignedUrls(paths, 60 * 60)
  if (error || !data) return out
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out.set(entry.path, entry.signedUrl)
  }
  return out
}

/**
 * Download the stored images and return them as base64 `data:` URIs.
 *
 * Copying a reply has to survive being pasted into the platform's forum editor days
 * later. A signed Storage URL cannot do that: the bucket is private and the
 * signature expires, so the pasted post would render broken images once the
 * link lapsed. Inlining the bytes makes the clipboard payload self-contained
 *, the paste target never has to fetch anything.
 */
export async function imagesAsDataUris(images: VerifiedAnswerImage[]): Promise<string[]> {
  const out: string[] = []
  for (const image of images) {
    const { data, error } = await supabaseClient()
      .storage
      .from(REPLY_IMAGES_BUCKET)
      .download(image.storage_path)
    if (error || !data) continue
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(data)
    })
    out.push(dataUri)
  }
  return out
}
