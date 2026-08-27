import { describe, expect, it } from "vitest";
import { z } from "zod";
import generatedSchema from "../worker/generated/song-candidate-output-schema.json";
import { SongCandidateOutputSchema } from "../src/lib/song-candidate-schema";

describe("generated Worker song candidate schema", () => {
  it("stays synchronized with the source Zod schema", () => {
    expect(generatedSchema).toEqual(z.toJSONSchema(SongCandidateOutputSchema));
  });
});
