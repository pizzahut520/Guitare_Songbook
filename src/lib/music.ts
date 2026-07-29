const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "E♭",
  "E",
  "F",
  "F♯",
  "G",
  "A♭",
  "A",
  "B♭",
  "B"
] as const;

const NOTE_INDEX: Record<string, number> = {
  C: 0,
  "C#": 1,
  "C♯": 1,
  Db: 1,
  "D♭": 1,
  D: 2,
  "D#": 3,
  "D♯": 3,
  Eb: 3,
  "E♭": 3,
  E: 4,
  F: 5,
  "F#": 6,
  "F♯": 6,
  Gb: 6,
  "G♭": 6,
  G: 7,
  "G#": 8,
  "G♯": 8,
  Ab: 8,
  "A♭": 8,
  A: 9,
  "A#": 10,
  "A♯": 10,
  Bb: 10,
  "B♭": 10,
  B: 11
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
const DEGREE_PATTERN =
  /([♭♯]?[1-7])(m\(maj7\)|m7♭5|m7|m6|sus4|m|\(7\)|7)?(?:\/([♭♯]?[1-7]))?/g;

function modulo(value: number, base: number): number {
  return ((value % base) + base) % base;
}

function degreeOffset(degree: string): number {
  const accidental = degree.startsWith("♭") ? -1 : degree.startsWith("♯") ? 1 : 0;
  const number = Number(degree.replace(/[♭♯]/g, ""));
  return MAJOR_SCALE[number - 1] + accidental;
}

export function keyAtTranspose(key: string, transpose = 0): string {
  const root = NOTE_INDEX[key];
  if (root === undefined) return key;
  return NOTE_NAMES[modulo(root + transpose, 12)];
}

export function degreeToChord(
  degree: string,
  key: string,
  transpose = 0
): string {
  const rootIndex = NOTE_INDEX[key];
  if (rootIndex === undefined) return degree;

  return degree.replace(
    DEGREE_PATTERN,
    (_match, rootDegree: string, rawQuality = "", bassDegree?: string) => {
      const root = NOTE_NAMES[
        modulo(rootIndex + transpose + degreeOffset(rootDegree), 12)
      ];
      const quality = rawQuality === "(7)" ? "7" : rawQuality;
      const bass = bassDegree
        ? `/${NOTE_NAMES[
            modulo(rootIndex + transpose + degreeOffset(bassDegree), 12)
          ]}`
        : "";
      return `${root}${quality}${bass}`;
    }
  );
}

