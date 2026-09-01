import { BSKY_POST_LIMIT, splitText } from '../src/text-split.js';

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.log(`  ✗ ${message}`);
  }
}

console.log('Text splitting');
{
  assert(splitText('Hello world').length === 1, 'Short text is not split');
  assert(splitText('Hello world')[0] === 'Hello world', 'Short text is preserved verbatim');

  // A chunk may now use the full 300 characters: nothing is appended after the
  // split, so reserving space for a counter would waste 8 characters per chunk.
  const exactly300 = 'a'.repeat(BSKY_POST_LIMIT);
  assert(splitText(exactly300).length === 1, 'Text at exactly the limit stays one chunk');

  const justOver = `${'a'.repeat(BSKY_POST_LIMIT)}b`;
  assert(splitText(justOver).length === 2, 'Text one character over the limit splits in two');
}

console.log('\nChunk sizing');
{
  const long = `${'word '.repeat(200)}end`;
  const chunks = splitText(long);
  assert(chunks.length > 1, 'Long text splits into multiple chunks');
  assert(
    chunks.every((chunk) => chunk.length <= BSKY_POST_LIMIT),
    'Every chunk fits inside the Bluesky limit',
  );
  assert(
    chunks.every((chunk) => !/\(\d+\/\d+\)$/.test(chunk)),
    'No chunk carries an (i/n) counter',
  );
}

console.log('\nBreak points');
{
  const paragraphs = `${'a'.repeat(100)}\n\n${'b'.repeat(250)}`;
  const chunks = splitText(paragraphs);
  assert(chunks[0] === 'a'.repeat(100), 'Splits on a paragraph break when one is in range');

  const sentences = `${'a'.repeat(280)}. ${'b'.repeat(100)}`;
  const sentenceChunks = splitText(sentences);
  assert(sentenceChunks[0]?.endsWith('.') === true, 'Splits after sentence punctuation');

  const noBreaks = 'a'.repeat(700);
  const forced = splitText(noBreaks);
  assert(
    forced.every((chunk) => chunk.length <= BSKY_POST_LIMIT),
    'Force-splits text with no break points without exceeding the limit',
  );
  assert(forced.join('') === noBreaks, 'Force-split chunks reassemble into the original text');
}

console.log('\nContent preservation');
{
  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  const chunks = splitText(text, 30);
  assert(
    chunks.every((chunk) => chunk.length > 0),
    'No empty chunks are produced',
  );
  assert(
    chunks.join(' ').replace(/\s+/g, ' ') === text.replace(/\s+/g, ' '),
    'All words survive the split',
  );
}

const total = failures === 0;
console.log(`\n${total ? 'All tests passed' : `${failures} test(s) failed`}`);
process.exit(total ? 0 : 1);
