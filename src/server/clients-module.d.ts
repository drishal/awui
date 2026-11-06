// The `awui:clients` module: the compiled binary's bundled terminal clients
// (src/atui/embed.ts), resolved by scripts/build-binary.ts's plugin. It exists
// only inside the binary; clients.ts imports it there and nowhere else.
declare module "awui:clients" {
  /** Run atui with its options. */
  export function atui(argv: string[]): Promise<void>;
  /** Run the Tern client with its options. */
  export function tern(argv: string[]): Promise<void>;
}
