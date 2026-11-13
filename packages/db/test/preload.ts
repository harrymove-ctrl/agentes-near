import { setDefaultTimeout } from "bun:test";

// The first database a test process asks for migrates its template (PGlite); on a busy machine that can
// take longer than Bun's 5 s default. Bun keeps this only for the first test file of a run (and `timeout`
// in bunfig is not honored): a file that is slow on its own sets its own default.
setDefaultTimeout(30_000);
