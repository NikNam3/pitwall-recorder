# pitwall-recorder

Standalone tool: records raw F1 25 UDP datagrams to `.pwrec.gz` files, shipped to friends as a Windows exe. **Deliberately separate from the pitwall app repo.** Don't share code or conventions with it. The only contract is `FORMAT.md`.

## Commands
- `npm test` (vitest), `npm run typecheck` (tsc, noEmit)
- `npm run record | inspect | replay -- …`: run from source; Node strips the TS types, no build step
- `npm run build:exe` + `npm run smoke`: needs an official Node binary. The Nix `node` on the dev machine is a wrapper and can't be used for SEA. CI builds the real exe on `windows-latest`.

## Layout
- `src/format/`: codec (pure) and gzip file reader/writer. **Changing the byte layout requires bumping the format version and updating FORMAT.md.**
- `src/f1/header.ts`: 29-byte F1 packet header peek. The only F1 knowledge here; never decode more.
- `src/recorder/`: `recorder.ts` (core, no console output), `main.ts` (CLI and friend-facing text)
- `src/tools/`: `inspect`, `replay`
- `scripts/`: esbuild bundle, SEA build, exe smoke test

## Rules
- Runtime code uses only Node built-ins (the exe must stay a single file).
- Source must be erasable-only TS (no enums or parameter properties) with `.ts` import extensions.
- Tests check observable behaviour: bytes in equal bytes out, real sockets, the real CLI as a child process. No mocks.
- Friend-facing text (README top half, console output) is written for non-developers.
- Release: bump `package.json` and `src/version.ts` together, tag `vX.Y.Z`, push the tag.
