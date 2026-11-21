// §11.2 step 2: pack transcript turns into extraction windows of at most
// `maxChars` characters (config.params.extractWindowChars = 6000), never
// splitting inside a turn; an oversized turn forms its own window.
export interface TranscriptTurn {
  index: number;
  role: 'user' | 'assistant';
  content: string;
  at: string; // ISO 8601
}

/**
 * Greedy packer: each window holds as many consecutive turns as fit within
 * `maxChars` chars (turn content lengths plus one separator space between
 * turns), never splitting a turn. A single turn longer than `maxChars` is
 * its own window. Empty input yields `[]`.
 */
export function windowTurns(turns: TranscriptTurn[], maxChars: number): TranscriptTurn[][] {
  const windows: TranscriptTurn[][] = [];
  let current: TranscriptTurn[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length > 0) {
      windows.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const turn of turns) {
    const chars = turn.content.length;
    // First turn in the window always fits (oversized turns stand alone);
    // otherwise only add when the joined window stays within maxChars.
    if (current.length === 0) {
      current = [turn];
      currentChars = chars;
    } else if (currentChars + 1 + chars <= maxChars) {
      current.push(turn);
      currentChars += 1 + chars;
    } else {
      flush();
      current = [turn];
      currentChars = chars;
    }
  }
  flush();
  return windows;
}
