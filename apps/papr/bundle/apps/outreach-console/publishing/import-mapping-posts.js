import { cell, list, nextId, mappingContext, checkSchedule, result } from './import-mapping-values.js';
export function mapPublications(manifest, rows, spec) {
  const context = mappingContext(manifest); const posts = [...(manifest.publishingPlans || [])]; const media = [...(manifest.media || [])]; const postId = nextId(posts, 'post'); const mediaId = nextId(media, 'media');
  const mapped = rows.map((row, i) => {
    const read = (key) => cell(row, spec, key); const number = i + 1; const channel = read('channel').trim().toLowerCase(); const accountRef = read('accountRef').trim(); const scheduledFor = read('scheduledFor').trim();
    if (!['linkedin', 'instagram', 'x', 'tiktok'].includes(channel)) context.errors.push(`Row ${number}: choose LinkedIn, Instagram, X or TikTok.`);
    else context.account(accountRef, channel, number);
    checkSchedule(scheduledFor, number, context.errors); const references = [];
    for (const name of list(read('media'))) {
      if (name.length > 200 || /[/\\]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32)) { context.errors.push(`Row ${number}: media must use local filenames without folders.`); continue; }
      const matches = media.filter((item) => item.name === name);
      if (matches.length > 1) context.errors.push(`Row ${number}: ${name} matches more than one media reference. Repair the manifest first.`);
      const ref = matches[0] || { id: mediaId(), name }; if (!matches.length) { media.push(ref); context.repairs.push(`Upload and map media file ${name} after saving.`); }
      if (!references.includes(ref.id)) references.push(ref.id);
    }
    const text = read('text'); if (!text.trim() && !references.length) context.errors.push(`Row ${number}: choose a caption or at least one media filename.`);
    const format = read('format').trim() || 'feed'; if (!['feed', 'carousel', 'video', 'reel'].includes(format)) context.errors.push(`Row ${number}: format must be feed, carousel, video or reel.`);
    const firstComment = read('firstComment');
    return { id: postId(), accountRef, channel, text, media: references, scheduledFor, format, tags: [], ...(firstComment ? { firstComment } : {}) };
  });
  return result(manifest, { publishingPlans: [...posts, ...mapped], media }, context, mapped);
}
