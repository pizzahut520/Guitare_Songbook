import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { SongCandidateOutputSchema } from "../src/lib/song-candidate-schema";

const destination = resolve("worker/generated/song-candidate-output-schema.json");
await mkdir(dirname(destination), { recursive: true });
await writeFile(
  destination,
  `${JSON.stringify(z.toJSONSchema(SongCandidateOutputSchema), null, 2)}\n`,
  "utf8"
);
