import { main } from "./cli";

// exitCode, not process.exit(): a piped stdout gets flushed before the process ends.
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
