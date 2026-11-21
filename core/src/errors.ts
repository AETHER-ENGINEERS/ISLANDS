// Errors the island hands back to a ferry, with the protocol's codes (docs/protocol.md).

export const CODES = {
  parse: -32700,
  invalidRequest: -32600,
  noMethod: -32601,
  badParams: -32602,
  internal: -32603,
  noHello: -32000,
  notFound: -32001,
  refused: -32002,
  conflict: -32003,
} as const;

export class IslandError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const notFound = (what: string) => new IslandError(CODES.notFound, `${what}: not found`);
export const refused = (why: string) => new IslandError(CODES.refused, why);
export const conflict = (why: string) => new IslandError(CODES.conflict, why);
export const badParams = (why: string) => new IslandError(CODES.badParams, why);
