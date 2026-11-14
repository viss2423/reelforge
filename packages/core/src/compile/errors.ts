/** Thrown when a project cannot be compiled into a render plan (invalid/missing input). */
export class CompileError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CompileError'
  }
}
