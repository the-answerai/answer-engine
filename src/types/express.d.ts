declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      apiKeyId?: string;
      libraryId?: string;
      apiCapabilities?: readonly ('read' | 'write')[];
    }
  }
}
export {};
