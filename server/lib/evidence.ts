/** Quotes are selected by ID; the model never needs to retype candidate text. */
export function evidenceExcerpts(text: string, prefix = 'e') {
  const excerpts: { id: string; text: string }[] = []
  for (const sentence of new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(text)) {
    const characters = Array.from(sentence.segment)
    for (let offset = 0; offset < characters.length; offset += 240) {
      const quote = characters.slice(offset, offset + 240).join('').trim()
      if (quote) excerpts.push({ id: `${prefix}${excerpts.length + 1}`, text: quote })
    }
  }
  return excerpts
}
