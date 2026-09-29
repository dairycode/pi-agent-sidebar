/**
 * Compile-time exhaustiveness check for a discriminated union.
 *
 * Placed in the `default` arm of a `switch` over a message union, it turns a
 * missing branch into a build failure instead of a silently ignored message.
 * Both dispatch switches used to `break` here, so adding a variant to either
 * message union compiled cleanly and the message vanished at runtime.
 *
 * Throwing (rather than returning) keeps the failure loud if a value ever does
 * reach it: TypeScript proves the arm unreachable, so reaching it means the
 * union and the runtime disagree.
 */
export function assertNever(value: never): never {
 throw new Error(`Unhandled message variant: ${JSON.stringify(value)}`);
}
