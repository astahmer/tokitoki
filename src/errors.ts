/** CLI/user-facing error with an exact "try:" hint for the next command. */
export class UserError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
    this.name = "UserError";
  }
}
