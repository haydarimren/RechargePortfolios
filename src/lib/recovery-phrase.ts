/**
 * BIP39 12-word recovery phrase encoding for our 16-byte master secret.
 *
 * Why BIP39 specifically (rather than rolling our own word list): it's the
 * standard the user is most likely to have already encountered (every crypto
 * wallet uses it), and the wordlist is hand-curated to avoid ambiguous words
 * — no two words share their first four letters, no homophones — so a user
 * who slightly misspells one can still recover.
 *
 * Mechanics for 16-byte (128-bit) seeds:
 *   - Take the 128 bits of entropy.
 *   - Append a 4-bit checksum: first 4 bits of SHA-256(entropy).
 *   - Split the 132 bits into 12 × 11-bit chunks.
 *   - Each chunk is an index 0..2047 into the BIP39 wordlist.
 *   - Encoding result: 12 space-separated words.
 *
 * Decoding inverts the process and verifies the checksum, throwing on
 * mismatch (catches typos before downstream crypto silently fails).
 */
import { BIP39_WORDLIST } from "./bip39-wordlist";

const ENTROPY_BITS = 128;
const CHECKSUM_BITS = ENTROPY_BITS / 32; // = 4 for our case
const TOTAL_BITS = ENTROPY_BITS + CHECKSUM_BITS;
const WORD_COUNT = TOTAL_BITS / 11; // = 12
const ENTROPY_BYTES = ENTROPY_BITS / 8; // = 16

if (BIP39_WORDLIST.length !== 2048) {
  throw new Error("BIP39 wordlist must contain exactly 2048 words");
}

/** Build a position→word lookup for fast `indexOf`-style decoding. */
const WORD_TO_INDEX: ReadonlyMap<string, number> = new Map(
  BIP39_WORDLIST.map((w, i) => [w, i] as const),
);

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return new Uint8Array(digest);
}

/**
 * Encode bytes as a 12-word phrase. Throws if input isn't exactly 16 bytes —
 * we don't support other sizes, since changing this would break recovery
 * for existing users.
 */
export async function seedToPhrase(seed: Uint8Array): Promise<string> {
  if (seed.length !== ENTROPY_BYTES) {
    throw new Error(`seed must be ${ENTROPY_BYTES} bytes; got ${seed.length}`);
  }
  const hash = await sha256(seed);
  const checksum = hash[0] >> 4; // top 4 bits

  // Build the 132-bit stream then read it out 11 bits at a time. We can't
  // hold all 132 bits in a single number, so we re-stream the source for
  // each word: walk through the seed bytes + checksum bit-by-bit.
  const totalBits = TOTAL_BITS;
  const bits: number[] = new Array(totalBits);
  let cursor = 0;
  for (const b of seed) {
    for (let bi = 7; bi >= 0; bi--) bits[cursor++] = (b >> bi) & 1;
  }
  for (let bi = CHECKSUM_BITS - 1; bi >= 0; bi--) {
    bits[cursor++] = (checksum >> bi) & 1;
  }

  const words: string[] = [];
  for (let w = 0; w < WORD_COUNT; w++) {
    let idx = 0;
    for (let bi = 0; bi < 11; bi++) {
      idx = (idx << 1) | bits[w * 11 + bi];
    }
    words.push(BIP39_WORDLIST[idx]);
  }
  return words.join(" ");
}

/**
 * Parse a 12-word phrase back to 16-byte entropy. Throws on:
 *   - wrong word count
 *   - any word not in the wordlist
 *   - checksum mismatch (typo / wrong order)
 */
export async function phraseToSeed(phrase: string): Promise<Uint8Array> {
  // Tolerant of capitalization and extra whitespace; users will copy-paste
  // these into their password manager and the formatting will vary.
  const words = phrase.trim().toLowerCase().split(/\s+/);
  if (words.length !== WORD_COUNT) {
    throw new Error(`phrase must be ${WORD_COUNT} words; got ${words.length}`);
  }

  const bits: number[] = new Array(TOTAL_BITS);
  for (let w = 0; w < WORD_COUNT; w++) {
    const word = words[w];
    const idx = WORD_TO_INDEX.get(word);
    if (idx === undefined) {
      throw new Error(`unknown word in phrase: "${word}"`);
    }
    for (let bi = 0; bi < 11; bi++) {
      bits[w * 11 + bi] = (idx >> (10 - bi)) & 1;
    }
  }

  // First 128 bits → entropy. Last 4 bits → checksum.
  const seed = new Uint8Array(ENTROPY_BYTES);
  for (let bytei = 0; bytei < ENTROPY_BYTES; bytei++) {
    let b = 0;
    for (let bi = 0; bi < 8; bi++) b = (b << 1) | bits[bytei * 8 + bi];
    seed[bytei] = b;
  }
  let checksum = 0;
  for (let bi = 0; bi < CHECKSUM_BITS; bi++) {
    checksum = (checksum << 1) | bits[ENTROPY_BITS + bi];
  }

  const hash = await sha256(seed);
  const expected = hash[0] >> 4;
  if (checksum !== expected) {
    throw new Error("invalid recovery phrase (checksum mismatch)");
  }
  return seed;
}
