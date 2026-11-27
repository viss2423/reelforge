/**
 * Fixed LLM evaluation set: ~60 s talking-head transcripts in four languages, with
 * hand-labelled ground truth. Word timings are synthesised (≈2.7 words/s, pauses after
 * sentences) so the segmenter sees realistic input. Used by the gated real-model
 * integration test and by the model benchmark (README.md).
 *
 * Labels (sentence indices):
 * - `hooks`: sentences a good editor would open with (any one counts as a hit);
 * - `filler`: greetings / housekeeping / rambling that a highlight reel should skip;
 * - `keywords`: words worth highlighting in captions (normalised, lower case).
 */
import type { Word } from '@reelforge/core'

export interface EvalTranscript {
  id: string
  language: string
  sentences: string[]
  hooks: number[]
  filler: number[]
  keywords: string[]
}

export const EVAL_SET: EvalTranscript[] = [
  {
    id: 'battery-en',
    language: 'en',
    sentences: [
      'Hey guys, welcome back to the channel.',
      'So um, today I wanted to talk about something.',
      'Your phone charger is secretly destroying your battery, and nobody tells you.',
      'Lithium cells hate sitting at one hundred percent for hours.',
      'Every night you charge to full, the battery ages faster.',
      'Mistake number two is heat.',
      'Gaming while charging can push the cell past forty degrees.',
      'That alone can cut its life in half within a year.',
      'The fix is simple: turn on optimized charging and keep it between twenty and eighty percent.',
      'I did this for two years and my battery health is still ninety six percent.',
      'Okay so, yeah, that was it, I guess.',
      'Follow for part two where I test fast chargers.',
    ],
    hooks: [2, 7, 9],
    filler: [0, 1, 10],
    keywords: [
      'charger',
      'destroying',
      'battery',
      'hundred',
      'faster',
      'heat',
      'gaming',
      'forty',
      'half',
      'optimized',
      'twenty',
      'eighty',
      'ninety',
      'six',
      'two',
      'years',
      'fast',
      'chargers',
      'nobody',
      'mistake',
      'simple',
      'percent',
      'lithium',
      'year',
      'life',
    ],
  },
  {
    id: 'pasta-en',
    language: 'en',
    sentences: [
      'Okay, so I am in the kitchen right now.',
      'Restaurants have been lying to you about pasta water.',
      'Most people pour it down the drain, which is a huge mistake.',
      'That starchy water is the secret to a silky sauce.',
      'Save one cup before you drain the pasta.',
      'Add the pasta to the pan with butter and cheese.',
      'Then splash in the water a little at a time and toss like crazy.',
      'Um, let me just, uh, move the camera a bit.',
      'In thirty seconds you get a glossy sauce that clings to every noodle.',
      'This is the exact trick Italian grandmas have used for a hundred years.',
      'Save this so you never forget it.',
    ],
    hooks: [1, 2, 9],
    filler: [0, 7],
    keywords: [
      'lying',
      'pasta',
      'water',
      'huge',
      'mistake',
      'starchy',
      'secret',
      'silky',
      'sauce',
      'cup',
      'butter',
      'cheese',
      'crazy',
      'thirty',
      'seconds',
      'glossy',
      'every',
      'noodle',
      'italian',
      'grandmas',
      'hundred',
      'years',
      'save',
      'never',
      'trick',
      'restaurants',
      'drain',
    ],
  },
  {
    id: 'travel-es',
    language: 'es',
    sentences: [
      'Hola a todos, bienvenidos otra vez.',
      'Bueno, eh, hoy estoy en el aeropuerto.',
      'Este truco me ahorró trescientos euros en un solo vuelo.',
      'Las aerolíneas cambian los precios según el día en que buscas.',
      'Si buscas un martes por la mañana, los vuelos suelen ser más baratos.',
      'Además, usa siempre el modo incógnito del navegador.',
      'Yo reservé Madrid a Tokio por la mitad del precio normal.',
      'Bueno, eso, no sé, ya está.',
      'Sígueme para más trucos de viaje baratos.',
    ],
    hooks: [2, 6],
    filler: [0, 1, 7],
    keywords: [
      'truco',
      'ahorró',
      'trescientos',
      'euros',
      'vuelo',
      'aerolíneas',
      'precios',
      'martes',
      'baratos',
      'incógnito',
      'madrid',
      'tokio',
      'mitad',
      'precio',
      'siempre',
      'trucos',
      'viaje',
      'mañana',
      'vuelos',
    ],
  },
  {
    id: 'fitness-de',
    language: 'de',
    sentences: [
      'Hallo zusammen und herzlich willkommen.',
      'Also, ähm, ich wollte heute kurz was zeigen.',
      'Du machst Liegestütze seit Jahren falsch und merkst es nicht.',
      'Die meisten lassen die Hüfte durchhängen.',
      'Dadurch arbeitet der untere Rücken statt der Brust.',
      'Spann den Bauch an, als würde gleich jemand zuschlagen.',
      'Die Ellbogen zeigen schräg nach hinten, nicht zur Seite.',
      'So schaffst du sofort fünf Wiederholungen mehr.',
      'Ja, äh, okay, das war es eigentlich schon.',
      'Folge mir für den kompletten Trainingsplan.',
    ],
    hooks: [2, 7],
    filler: [0, 1, 8],
    keywords: [
      'liegestütze',
      'jahren',
      'falsch',
      'hüfte',
      'durchhängen',
      'rücken',
      'brust',
      'bauch',
      'zuschlagen',
      'ellbogen',
      'schräg',
      'sofort',
      'fünf',
      'wiederholungen',
      'mehr',
      'trainingsplan',
      'kompletten',
      'meisten',
    ],
  },
]

/** Synthesises word timings for a transcript (≈0.37 s per word, 0.6 s pauses). */
export const toWords = (t: EvalTranscript): { words: Word[]; sentenceOf: number[] } => {
  const words: Word[] = []
  const sentenceOf: number[] = []
  let at = 400_000
  t.sentences.forEach((s, si) => {
    for (const text of s.split(/\s+/)) {
      const len = 180_000 + Math.min(10, text.length) * 22_000
      words.push({
        text,
        start: at,
        end: at + len,
        confidence: 0.92,
        filler: /^(um|uh|eh|ähm|äh)[,.]?$/i.test(text),
        emphasis: false,
      })
      sentenceOf.push(si)
      at += len + 60_000
    }
    at += 600_000
  })
  return { words, sentenceOf }
}
